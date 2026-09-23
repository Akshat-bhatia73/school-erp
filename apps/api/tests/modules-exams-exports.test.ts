/**
 * The three exam files (Task 21): a paper's marks register as a spreadsheet,
 * one published report card as a document and a section's newest cards in
 * one document.
 *
 * A route only decides that the caller may ask; the producer reads every row
 * again under that same person's own export plans when it makes the bytes,
 * and a download decides the named record again. Each test asks for the
 * file, checks the job came back ready and downloads it through the shared
 * export route, which is the only way a file ever reaches anybody.
 *
 * The suite owns its year, class, section, subject and pupils. Exams, papers,
 * marks and exam publications are seeded straight into the tables as the
 * migrator, exactly as the exams routes leave them; the term 1 card is
 * published through its own route.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = `exam-export-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string

const suffix = randomUUID().slice(0, 8)
const year = randomUUID()
const YEAR_START = '2026-04-01'
const YEAR_END = '2027-03-31'
const grade = randomUUID()
const section = randomUUID()
const maths = randomUUID()
// A second subject the teacher keeps, so they still hold exams.export
// somewhere once the maths assignment ends.
const english = randomUUID()
const pt1 = randomUUID()
const halfYearly = randomUUID()
const mathsPt1Paper = randomUUID()
const mathsHalfPaper = randomUUID()

// The parent's own child, and a pupil of another family in the same class.
const child = randomUUID()
const stranger = randomUUID()
// The parent's other child, in no class, so the parent keeps a family scope
// once the first child's link is revoked.
const sibling = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let subjectTeacher: Client
let parent: Client
let subjectTeacherStaff = ''
const extraUserIds: string[] = []

interface Job {
  id: string
  status: string
  fileName?: string
  format?: string
}

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** The job a route made, downloaded through the shared export route. */
async function fileOf(client: Client, response: Response, expected: 'pdf' | 'xlsx'): Promise<Job> {
  assert.equal(response.status, 202, await response.clone().text())
  const job = await json<Job>(response)
  assert.equal(job.status, 'ready', 'a small file is made in the request that asked for it')
  assert.equal(job.format, expected)
  assert.ok(job.fileName?.endsWith(`.${expected}`), `${job.fileName} is not a ${expected} file`)
  await download(client, job.id, expected)
  return job
}

async function download(client: Client, jobId: string, expected: 'pdf' | 'xlsx'): Promise<void> {
  const response = await client.fetch(`/api/schools/${schoolA}/exports/${jobId}/file`)
  assert.equal(response.status, 200, await response.clone().text())
  assert.equal(
    response.headers.get('content-type'),
    expected === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  const bytes = Buffer.from(await response.arrayBuffer())
  const head = bytes.subarray(0, 4).toString('latin1')
  assert.equal(head.startsWith(expected === 'pdf' ? '%PDF' : 'PK'), true, `the bytes start with ${head}`)
}

async function downloadAudits(jobId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND target_type = 'export_job' AND target_id = $2 AND result = 'allowed'
        AND summary = 'Downloaded an export file'`,
    [schoolA, jobId],
  )
  return Number(found.rows[0]?.count)
}

async function jobPermission(jobId: string): Promise<string | undefined> {
  const found = await adminPool().query<{ permission: string }>(
    'SELECT permission FROM export_jobs WHERE school_id = $1 AND id = $2',
    [schoolA, jobId],
  )
  return found.rows[0]?.permission
}

/** A brand new member of school A with the roles named, signed in. */
async function member(input: {
  roleKeys: readonly string[]
  label: string
  staffId?: string
  childIds?: readonly string[]
}): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `exam-export-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, `Exam export ${input.label}`, email])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [schoolA, membershipId, [...input.roleKeys]],
  )
  if (input.staffId !== undefined) {
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
      schoolA,
      membershipId,
      input.staffId,
    ])
  }
  const childIds = input.childIds ?? []
  if (childIds.length > 0) {
    const guardianId = randomUUID()
    await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [
      guardianId,
      schoolA,
      `Exam export guardian ${input.label}`,
    ])
    await pool.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`,
      [schoolA, membershipId, guardianId],
    )
    for (const childId of childIds) {
      await pool.query(
        `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian')`,
        [schoolA, childId, guardianId],
      )
      await pool.query(
        `INSERT INTO guardian_student_access
           (school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
         VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
        [schoolA, guardianId, childId, ownerMembershipId],
      )
    }
  }
  await setFixturePassword(server, userId, PASSWORD)
  extraUserIds.push(userId)
  return signInWithPassword(server, email, PASSWORD)
}

async function insertStaff(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active',$5)`,
    [id, schoolA, `EX-${suffix}-${label}`, `Exam export ${label}`, YEAR_START],
  )
  return id
}

async function mark(examId: string, paperId: string, studentId: string, component: string, tenths: number | null): Promise<void> {
  await adminPool().query(
    `INSERT INTO exam_marks (school_id, paper_id, exam_id, academic_year_id, section_id, subject_id, student_id,
                             component, status, marks_tenths, revision, kind, recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'entry',$11)`,
    [
      schoolA,
      paperId,
      examId,
      year,
      section,
      maths,
      studentId,
      component,
      tenths === null ? 'absent' : 'marked',
      tenths,
      ownerMembershipId,
    ],
  )
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'upcoming')`,
    [year, schoolA, `EX-${suffix}`, YEAR_START, YEAR_END],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,13)`, [
    grade,
    schoolA,
    `Exam export ${suffix}`,
    `E${suffix.slice(0, 3)}`,
  ])
  const classTeacherStaff = await insertStaff('class')
  subjectTeacherStaff = await insertStaff('subject')
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [section, schoolA, year, grade, `EE-${suffix.slice(0, 4)}`, classTeacherStaff],
  )
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
    maths,
    schoolA,
    `Mathematics ${suffix}`,
    `EX${suffix}`,
  ])
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
    english,
    schoolA,
    `English ${suffix}`,
    `EY${suffix}`,
  ])
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,'Sibling','active')`,
    [sibling, schoolA, `EX/${suffix}/9`],
  )
  await pool.query(`INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`, [
    schoolA,
    grade,
    year,
    maths,
  ])
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [schoolA, subjectTeacherStaff, year, section, maths, YEAR_START],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [schoolA, subjectTeacherStaff, year, section, english, YEAR_START],
  )
  for (const [index, [id, name]] of ([
    [child, 'Own Child'],
    [stranger, 'Other Family'],
  ] as const).entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, schoolA, `EX/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), schoolA, id, year, section, index + 1, YEAR_START],
    )
  }
  await pool.query(
    `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline) VALUES
       ($1,$3,$4,'periodic_test_1','2026-05-04','2026-05-06','2026-05-10'),
       ($2,$3,$4,'half_yearly','2026-09-01','2026-09-10','2026-09-15')`,
    [pt1, halfYearly, schoolA, year],
  )
  await pool.query(
    `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES
       ($1,$3,$4,$5,$6,$7), ($2,$3,$8,$5,$6,$7)`,
    [mathsPt1Paper, mathsHalfPaper, schoolA, pt1, year, section, maths, halfYearly],
  )
  for (const studentId of [child, stranger]) {
    await mark(pt1, mathsPt1Paper, studentId, 'periodic_test', 80)
    await mark(halfYearly, mathsHalfPaper, studentId, 'notebook', 40)
    await mark(halfYearly, mathsHalfPaper, studentId, 'subject_enrichment', 50)
    await mark(halfYearly, mathsHalfPaper, studentId, 'written', studentId === child ? 600 : null)
  }
  for (const examId of [pt1, halfYearly]) {
    await pool.query(
      `INSERT INTO exam_publications (school_id, exam_id, academic_year_id, section_id, published_by_membership_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [schoolA, examId, year, section, ownerMembershipId],
    )
  }

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  subjectTeacher = await member({ roleKeys: ['teacher'], label: 'subject', staffId: subjectTeacherStaff })
  parent = await member({ roleKeys: ['parent'], label: 'parent', childIds: [child, sibling] })

  // The term 1 card, published through its own route.
  const published = await owner.fetch(
    `/api/schools/${schoolA}/report-cards/sections/${section}/cards/term_1/publish`,
    post({}),
  )
  assert.equal(published.status, 201, await published.text())
})

after(async () => {
  const pool = adminPool()
  // The report cards suite counts every card of the school, so the cards this
  // suite published go again. A published card is frozen for everybody, so
  // its trigger is lifted for the tidy-up alone.
  await pool.query('ALTER TABLE report_card_versions DISABLE TRIGGER report_card_versions_no_change')
  await pool.query('DELETE FROM report_card_versions WHERE school_id = $1 AND section_id = $2', [schoolA, section])
  await pool.query('ALTER TABLE report_card_versions ENABLE TRIGGER report_card_versions_no_change')
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [[ownerUserId, ...extraUserIds]])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await server.close()
  await closeAdminPool()
})

async function versionOf(studentId: string): Promise<string> {
  const found = await adminPool().query<{ id: string }>(
    `SELECT id FROM report_card_versions WHERE school_id = $1 AND student_id = $2 ORDER BY version_number DESC LIMIT 1`,
    [schoolA, studentId],
  )
  const id = found.rows[0]?.id
  assert.ok(id, 'the card was published')
  return id
}

let registerJob = ''
let parentCardJob = ''

test('the subject teacher makes and downloads the marks register, one audit row per download', async () => {
  const job = await fileOf(
    subjectTeacher,
    await subjectTeacher.fetch(`/api/schools/${schoolA}/exams/papers/${mathsHalfPaper}/export`, post({})),
    'xlsx',
  )
  registerJob = job.id
  assert.equal(await jobPermission(job.id), 'exams.export')
  assert.equal(await downloadAudits(job.id), 1)
  await download(subjectTeacher, job.id, 'xlsx')
  assert.equal(await downloadAudits(job.id), 2)

  // A path of the wrong shape, and a paper that is not there, are both not found.
  assert.equal((await subjectTeacher.fetch(`/api/schools/${schoolA}/exams/papers/nope/export`, post({}))).status, 404)
  assert.equal(
    (await subjectTeacher.fetch(`/api/schools/${schoolA}/exams/papers/${randomUUID()}/export`, post({}))).status,
    404,
  )
})

test("a parent prints their own child's card under report_cards.export, and not another family's", async () => {
  const own = await versionOf(child)
  const job = await fileOf(
    parent,
    await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${own}/export`, post({})),
    'pdf',
  )
  parentCardJob = job.id
  assert.equal(await jobPermission(job.id), 'report_cards.export')

  const theirs = await versionOf(stranger)
  const refused = await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${theirs}/export`, post({}))
  assert.equal(refused.status, 404, await refused.text())
})

test("the office prints a section's cards in one document, and nothing published is refused", async () => {
  await fileOf(
    owner,
    await owner.fetch(`/api/schools/${schoolA}/report-cards/sections/${section}/cards/term_1/export`, post({})),
    'pdf',
  )
  const empty = await owner.fetch(`/api/schools/${schoolA}/report-cards/sections/${section}/cards/final/export`, post({}))
  const bodyText = await empty.text()
  assert.equal(empty.status, 400, bodyText)
  assert.ok(!bodyText.includes('"reason"'), bodyText)
  // A parent holds no section-wide scope.
  const parentTry = await parent.fetch(
    `/api/schools/${schoolA}/report-cards/sections/${section}/cards/term_1/export`,
    post({}),
  )
  assert.equal(parentTry.status, 404, await parentTry.text())
})

test('a download decides the named record again', async () => {
  const pool = adminPool()
  // The teacher's assignment ends: their old register is no longer theirs.
  await pool.query(
    `UPDATE teaching_assignments SET effective_to = effective_from
      WHERE school_id = $1 AND staff_id = $2 AND subject_id = $3`,
    [schoolA, subjectTeacherStaff, maths],
  )
  const before = await downloadAudits(registerJob)
  const gone = await subjectTeacher.fetch(`/api/schools/${schoolA}/exports/${registerJob}/file`)
  assert.equal(gone.status, 404, await gone.text())
  assert.equal(await downloadAudits(registerJob), before)

  // The family's link is revoked: the card they printed is no longer theirs.
  await pool.query(
    `UPDATE guardian_student_access SET status = 'revoked', revoked_at = now() WHERE school_id = $1 AND student_id = $2`,
    [schoolA, child],
  )
  const revoked = await parent.fetch(`/api/schools/${schoolA}/exports/${parentCardJob}/file`)
  assert.equal(revoked.status, 404, await revoked.text())
})
