/**
 * Matrix rows: exams and report cards.
 *
 * The adversarial half of Task 21. The module's own suites prove the figures
 * are right; this file asks who may read a mark, who may write one, and what
 * a family sees before and after the office publishes. A subject teacher
 * reaches their own subject in their own class and nothing beside it, the
 * class teacher reads the whole class but records nothing they do not teach,
 * a relationship that ended takes the class with it, the accountant is kept
 * out altogether, and an id from the school next door reads exactly like an
 * id that was never real.
 *
 * Every refusal is measured twice: the answer it gave, and a fingerprint of
 * the exam tables, which a refusal may never change.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createMember,
  grantPortalAccess,
  postBody,
  putBody,
  signInMember,
  signInOffice,
  type Client,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerA = fixtureIds.ownerA as string
const ownerB = fixtureIds.ownerB as string
const studentB = fixtureIds.studentB as string

const suffix = randomUUID().slice(0, 8)

// School A: this year, and last year the children were promoted out of.
const year = randomUUID()
const lastYear = randomUUID()
const grade = randomUUID()
const sectionOne = randomUUID()
const sectionTwo = randomUUID()
const lastSection = randomUUID()
const maths = randomUUID()
const science = randomUUID()
const child = randomUUID()
const stranger = randomUUID()
const pupilTwo = randomUUID()

// This year's exams: two locked, one open now. Last year's two, both locked.
const pt1 = randomUUID()
const halfYearly = randomUUID()
const pt2 = randomUUID()
const lastPt1 = randomUUID()
const lastHalfYearly = randomUUID()
/** `${examId}:${sectionId}:${subjectId}` to the paper id. */
const papers = new Map<string, string>()
const paper = (examId: string, sectionId: string, subjectId: string): string => {
  const id = papers.get(`${examId}:${sectionId}:${subjectId}`)
  assert.ok(id, 'the paper exists')
  return id
}

// School B's rows. None of them is ever reachable through school A's paths.
const yearB = randomUUID()
const gradeB = randomUUID()
const sectionB = randomUUID()
const subjectB = randomUUID()
const examB = randomUUID()
const paperB = randomUUID()
let markB = ''
let versionB = ''

let server: TestServer
let office: Client
let subjectTeacher: Client
let classTeacher: Client
let endedTeacher: Client
let accountant: Client
let parent: Client
let strangerParent: Client
let accountantMembershipId = ''

let today = ''
let yearStart = ''
let lastStart = ''
let lastEnd = ''

interface ErrorBody {
  error: { code: string; reason?: string }
}
interface PaperSummary {
  id: string
}
interface Results {
  view: string
  exams: {
    exam: { id: string; kind: string }
    publishedAt?: string
    subjects: { subject: { id: string }; components: { component: string; value?: number | string }[]; percentage?: number | null; grade: string | null }[]
  }[]
}
interface StudentCards {
  cards: { id: string; versionNumber: number; latest: boolean }[]
}
interface CardView {
  id: string
  view: string
  content: unknown
}

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

interface Route {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  body?: unknown
}

function call(client: Client, route: Route, schoolId = schoolA): Promise<Response> {
  const path = `/api/schools/${schoolId}${route.path}`
  if (route.method === 'GET') return client.fetch(path)
  const init = route.method === 'PUT' ? putBody(route.body ?? {}) : postBody(route.body ?? {})
  return client.fetch(path, init)
}

/** Every exam and report card table of a school, as one fingerprint. */
async function fingerprint(schoolId: string): Promise<string> {
  const found = await adminPool().query<{ fingerprint: string }>(
    `SELECT concat_ws('/',
       (SELECT count(*) FROM exams WHERE school_id = $1),
       (SELECT COALESCE(sum(version), 0) FROM exams WHERE school_id = $1),
       (SELECT count(*) FROM exam_papers WHERE school_id = $1),
       (SELECT count(*) FROM exam_marks WHERE school_id = $1),
       (SELECT count(*) FROM exam_publications WHERE school_id = $1),
       (SELECT count(*) FROM report_card_entries WHERE school_id = $1),
       (SELECT COALESCE(sum(version), 0) FROM report_card_entries WHERE school_id = $1),
       (SELECT count(*) FROM report_card_versions WHERE school_id = $1),
       (SELECT COALESCE(sum(version), 0) FROM exam_settings WHERE school_id = $1),
       (SELECT count(*) FROM export_jobs WHERE school_id = $1)) AS fingerprint`,
    [schoolId],
  )
  return found.rows[0]?.fingerprint ?? ''
}

async function deniedRows(membershipId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND actor_membership_id = $2 AND result = 'denied'
        AND (action LIKE 'exams.%' OR action LIKE 'report_cards.%')`,
    [schoolA, membershipId],
  )
  return Number(found.rows[0]?.count)
}

async function reasonOf(response: Response): Promise<string | undefined> {
  return (await body<ErrorBody>(response)).error.reason
}

/** One mark straight into the table, for rows no route would write (a closed year) or to set a scene. */
async function insertMark(
  paperId: string,
  examId: string,
  yearId: string,
  sectionId: string,
  subjectId: string,
  studentId: string,
  component: string,
  value: number | 'absent' | 'medical' | 'exempt',
): Promise<string> {
  const found = await adminPool().query<{ id: string }>(
    `INSERT INTO exam_marks(school_id,paper_id,exam_id,academic_year_id,section_id,subject_id,student_id,
                            component,status,marks_tenths,revision,kind,recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'entry',$11) RETURNING id`,
    [
      schoolA,
      paperId,
      examId,
      yearId,
      sectionId,
      subjectId,
      studentId,
      component,
      typeof value === 'number' ? 'marked' : value,
      typeof value === 'number' ? Math.round(value * 10) : null,
      ownerA,
    ],
  )
  return found.rows[0]?.id as string
}

const COMPONENTS: Record<string, readonly string[]> = {
  periodic_test_1: ['periodic_test'],
  half_yearly: ['notebook', 'subject_enrichment', 'written'],
  periodic_test_2: ['periodic_test'],
}
const TOP: Record<string, number> = { periodic_test: 10, notebook: 5, subject_enrichment: 5, written: 80 }

/** Fill every cell of one exam in one section, so it can be published. */
async function fillExam(
  examId: string,
  kind: string,
  yearId: string,
  sectionId: string,
  subjectIds: readonly string[],
  pupils: readonly string[],
): Promise<void> {
  for (const subjectId of subjectIds) {
    for (const [index, pupil] of pupils.entries()) {
      for (const component of COMPONENTS[kind]!) {
        await insertMark(
          paper(examId, sectionId, subjectId),
          examId,
          yearId,
          sectionId,
          subjectId,
          pupil,
          component,
          TOP[component]! - index - 1,
        )
      }
    }
  }
}

async function staffRow(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active',$5)`,
    [id, schoolA, `SEC-EXM-${suffix}-${label}`, `Security ${label}`, lastStart],
  )
  return id
}

async function teacherWith(
  label: string,
  assignments: readonly { sectionId: string; subjectId: string; effectiveTo?: string }[],
  classOf?: string,
): Promise<Client> {
  const pool = adminPool()
  const member = await createMember(schoolA, ['teacher'], `Exams ${label}`)
  const staffId = await staffRow(label)
  await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
    schoolA,
    member.membershipId,
    staffId,
  ])
  for (const assignment of assignments) {
    await pool.query(
      `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from,effective_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [schoolA, staffId, year, assignment.sectionId, assignment.subjectId, yearStart, assignment.effectiveTo ?? null],
    )
  }
  if (classOf !== undefined) {
    await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [classOf, staffId])
  }
  return signInMember(server, member)
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  const found = await pool.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata'))::date, 'YYYY-MM-DD') AS today
       FROM schools WHERE id = $1`,
    [schoolA],
  )
  today = found.rows[0]?.today ?? ''
  yearStart = shift(today, -300)
  lastStart = shift(today, -700)
  lastEnd = shift(today, -301)

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,$5,'upcoming'),($6,$2,$7,$8,$9,'upcoming')`,
    [year, schoolA, `SEC-EXM-${suffix}`, yearStart, shift(today, 200), lastYear, `SEC-EXM-OLD-${suffix}`, lastStart, lastEnd],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,720)`, [
    grade,
    schoolA,
    `Sec exams ${suffix}`,
    `SX${suffix.slice(0, 3)}`,
  ])
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name)
     VALUES ($1,$2,$3,$4,$5),($6,$2,$3,$4,$7),($8,$2,$9,$4,$10)`,
    [
      sectionOne, schoolA, year, grade, `XA-${suffix.slice(0, 4)}`,
      sectionTwo, `XB-${suffix.slice(0, 4)}`,
      lastSection, lastYear, `XO-${suffix.slice(0, 4)}`,
    ],
  )
  for (const [id, name] of [
    [maths, 'Maths'],
    [science, 'Science'],
  ] as const) {
    await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
      id,
      schoolA,
      `${name} ${suffix}`,
      `SX${name.slice(0, 2)}${suffix}`,
    ])
    await pool.query(
      `INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`,
      [schoolA, grade, year, id],
    )
  }
  await pool.query(
    `INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`,
    [schoolA, grade, lastYear, maths],
  )

  // The child and the stranger sat last year's class together and were
  // promoted into section one. Pupil two sits in section two.
  for (const [index, [pupil, name]] of [
    [child, 'Sec Exam Child'],
    [stranger, 'Sec Exam Stranger'],
    [pupilTwo, 'Sec Exam Other'],
  ].entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [pupil, schoolA, `SX/${suffix}/${index + 1}`, name],
    )
  }
  for (const [index, pupil] of [child, stranger].entries()) {
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on,left_on,outcome)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,'promoted'),
              (gen_random_uuid(),$1,$2,$8,$9,$5,$10,NULL,'ongoing')`,
      [schoolA, pupil, lastYear, lastSection, index + 1, lastStart, lastEnd, year, sectionOne, yearStart],
    )
  }
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,1,$5)`,
    [schoolA, pupilTwo, year, sectionTwo, yearStart],
  )

  const exams: [string, string, string, number][] = [
    [pt1, year, 'periodic_test_1', -120],
    [halfYearly, year, 'half_yearly', -60],
    [lastPt1, lastYear, 'periodic_test_1', -600],
    [lastHalfYearly, lastYear, 'half_yearly', -450],
  ]
  for (const [id, yearId, kind, offset] of exams) {
    await pool.query(
      `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, schoolA, yearId, kind, shift(today, offset), shift(today, offset + 2), shift(today, offset + 10)],
    )
  }
  // The one exam open now: the subject teacher may still enter marks.
  await pool.query(
    `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline)
     VALUES ($1,$2,$3,'periodic_test_2',$4,$5,$6)`,
    [pt2, schoolA, year, shift(today, -5), shift(today, -4), shift(today, 3)],
  )
  for (const examId of [pt1, halfYearly, pt2]) {
    for (const sectionId of [sectionOne, sectionTwo]) {
      for (const subjectId of [maths, science]) {
        const id = randomUUID()
        papers.set(`${examId}:${sectionId}:${subjectId}`, id)
        await pool.query(
          `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, schoolA, examId, year, sectionId, subjectId],
        )
      }
    }
  }
  for (const examId of [lastPt1, lastHalfYearly]) {
    const id = randomUUID()
    papers.set(`${examId}:${lastSection}:${maths}`, id)
    await pool.query(
      `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, schoolA, examId, lastYear, lastSection, maths],
    )
  }
  // This year's locked exams are complete in section one, and nothing is published.
  await fillExam(pt1, 'periodic_test_1', year, sectionOne, [maths, science], [child, stranger])
  await fillExam(halfYearly, 'half_yearly', year, sectionOne, [maths, science], [child, stranger])
  await fillExam(pt1, 'periodic_test_1', year, sectionTwo, [maths], [pupilTwo])

  // School B: a class, a pupil, an exam, a paper, a mark and a published card.
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'upcoming')`,
    [yearB, schoolB, `SEC-EXM-B-${suffix}`, yearStart, shift(today, 200)],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,720)`, [
    gradeB,
    schoolB,
    `Sec exams B ${suffix}`,
    `SY${suffix.slice(0, 3)}`,
  ])
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`, [
    sectionB,
    schoolB,
    yearB,
    gradeB,
    `XB-${suffix.slice(0, 4)}`,
  ])
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
    subjectB,
    schoolB,
    `B maths ${suffix}`,
    `SXB${suffix}`,
  ])
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,1,$5)`,
    [schoolB, studentB, yearB, sectionB, yearStart],
  )
  await pool.query(
    `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline)
     VALUES ($1,$2,$3,'periodic_test_2',$4,$5,$6)`,
    [examB, schoolB, yearB, shift(today, -5), shift(today, -4), shift(today, 3)],
  )
  await pool.query(
    `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [paperB, schoolB, examB, yearB, sectionB, subjectB],
  )
  markB = (
    await pool.query<{ id: string }>(
      `INSERT INTO exam_marks(school_id,paper_id,exam_id,academic_year_id,section_id,subject_id,student_id,
                              component,status,marks_tenths,revision,kind,recorded_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'periodic_test','marked',70,1,'entry',$8) RETURNING id`,
      [schoolB, paperB, examB, yearB, sectionB, subjectB, studentB, ownerB],
    )
  ).rows[0]?.id as string
  versionB = (
    await pool.query<{ id: string }>(
      `INSERT INTO report_card_versions(school_id,student_id,academic_year_id,section_id,card,version_number,
                                        content,content_hash,published_by_membership_id)
       VALUES ($1,$2,$3,$4,'term_1',1,'{}'::jsonb,$5,$6) RETURNING id`,
      [schoolB, studentB, yearB, sectionB, `security-${suffix}-0123456789`, ownerB],
    )
  ).rows[0]?.id as string

  // The subject teacher teaches maths in section one and nothing else. The
  // class teacher of section one teaches maths in section two only. The
  // third teacher taught maths in section one until last month and still
  // teaches science in section two, so they pass the route gate.
  subjectTeacher = await teacherWith('subject', [{ sectionId: sectionOne, subjectId: maths }])
  classTeacher = await teacherWith('class', [{ sectionId: sectionTwo, subjectId: maths }], sectionOne)
  endedTeacher = await teacherWith('ended', [
    { sectionId: sectionOne, subjectId: maths, effectiveTo: shift(today, -35) },
    { sectionId: sectionTwo, subjectId: science },
  ])

  const accountantMember = await createMember(schoolA, ['accountant'], 'Exams Accountant')
  accountantMembershipId = accountantMember.membershipId
  accountant = await signInOffice(server, accountantMember)
  const officeMember = await createMember(schoolA, ['principal'], 'Exams Office')
  office = await signInOffice(server, officeMember)

  const parentMember = await createMember(schoolA, ['parent'], 'Exams Parent')
  await grantPortalAccess({ schoolId: schoolA, membershipId: parentMember.membershipId, studentId: child, approvedBy: ownerA })
  parent = await signInMember(server, parentMember)
  const strangerMember = await createMember(schoolA, ['parent'], 'Exams Other Parent')
  await grantPortalAccess({
    schoolId: schoolA,
    membershipId: strangerMember.membershipId,
    studentId: stranger,
    approvedBy: ownerA,
  })
  strangerParent = await signInMember(server, strangerMember)
})

after(async () => {
  // The settings row is the school's, not this file's; the next suite starts
  // from the defaults again.
  await adminPool().query('DELETE FROM exam_settings WHERE school_id = $1', [schoolA])
  await server.close()
  await closeAdminPool()
})

/** Every exam and report card route, each naming one id of the kind given. */
function routesNaming(id: string): Route[] {
  const openPaper = paper(pt2, sectionOne, maths)
  return [
    // The exam.
    { method: 'GET', path: `/exams/${id}` },
    { method: 'GET', path: `/exams?academicYearId=${id}` },
    { method: 'GET', path: `/exams/papers?academicYearId=${id}` },
    {
      method: 'PUT',
      path: `/exams/${id}`,
      body: { expectedVersion: 1, startsOn: today, endsOn: today, recheckDeadline: today },
    },
    { method: 'POST', path: `/exams/${id}/sections/${sectionOne}/publish`, body: {} },
    // The section.
    { method: 'POST', path: `/exams/${halfYearly}/sections/${id}/publish`, body: {} },
    { method: 'GET', path: `/report-cards/sections/${id}/cards/term_1` },
    { method: 'POST', path: `/report-cards/sections/${id}/cards/term_1/publish`, body: {} },
    { method: 'POST', path: `/report-cards/sections/${id}/cards/term_1/export`, body: {} },
    { method: 'GET', path: `/report-cards/sections/${id}/terms/term_1/entries` },
    {
      method: 'PUT',
      path: `/report-cards/sections/${id}/terms/term_1/entries`,
      body: {
        rows: [
          {
            studentId: child,
            expectedVersion: 0,
            grades: { work_education: 'A', art_education: 'A', health_physical_education: 'A', discipline: 'A' },
            remarks: null,
          },
        ],
      },
    },
    // The paper.
    { method: 'GET', path: `/exams/papers/${id}` },
    { method: 'PUT', path: `/exams/papers/${id}/marks`, body: { entries: [{ studentId: child, component: 'periodic_test', value: 5 }] } },
    {
      method: 'POST',
      path: `/exams/papers/${id}/corrections`,
      body: { entries: [{ studentId: child, component: 'periodic_test', value: 5 }], reasonKind: 'other', reason: 'Security suite' },
    },
    { method: 'POST', path: `/exams/papers/${id}/export`, body: {} },
    { method: 'GET', path: `/exams/papers/${id}/students/${child}/history?component=periodic_test` },
    // The pupil.
    { method: 'GET', path: `/exams/papers/${openPaper}/students/${id}/history?component=periodic_test` },
    { method: 'GET', path: `/exams/students/${id}/results?academicYearId=${year}` },
    { method: 'GET', path: `/report-cards/students/${id}?academicYearId=${year}` },
    // The version.
    { method: 'GET', path: `/report-cards/versions/${id}` },
    { method: 'POST', path: `/report-cards/versions/${id}/export`, body: {} },
  ]
}

test('[exams] school B’s ids answer exactly like ids that were never real, on every read and write', async () => {
  const beforeA = await fingerprint(schoolA)
  const beforeB = await fingerprint(schoolB)
  const invented = randomUUID()
  const inventedAnswers = new Map<number, string>()
  for (const [index, route] of routesNaming(invented).entries()) {
    const response = await call(office, route)
    const text = await response.text()
    inventedAnswers.set(index, `${response.status} ${text.replace(/"requestId":"[^"]*"/, '')}`)
  }
  for (const foreign of [studentB, sectionB, subjectB, examB, paperB, markB, versionB, yearB]) {
    for (const [index, route] of routesNaming(foreign).entries()) {
      const response = await call(office, route)
      const text = await response.text()
      assert.equal(
        `${response.status} ${text.replace(/"requestId":"[^"]*"/, '')}`,
        inventedAnswers.get(index),
        `${route.method} ${route.path} told school B’s id apart from an invented one`,
      )
    }
  }

  // A paper filtered by school B's section or subject is simply an empty list.
  for (const filter of [`sectionId=${sectionB}`, `subjectId=${subjectB}`, `examId=${examB}`]) {
    const response = await office.fetch(`/api/schools/${schoolA}/exams/papers?academicYearId=${year}&${filter}`)
    if (response.status === 200) {
      assert.deepEqual((await body<{ items: unknown[] }>(response)).items, [], filter)
    } else {
      assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND', filter)
    }
  }

  // School B's pupil named in the body of this school's own paper is not a
  // stranger to the school: they are simply not on the roster.
  const notOnRoster = await office.fetch(
    `/api/schools/${schoolA}/exams/papers/${paper(pt2, sectionOne, maths)}/marks`,
    putBody({ entries: [{ studentId: studentB, component: 'periodic_test', value: 5 }] }),
  )
  assert.equal(notOnRoster.status, 400, await notOnRoster.clone().text())
  assert.equal(await reasonOf(notOnRoster), 'exam_pupil_not_on_roster')

  assert.equal(await fingerprint(schoolA), beforeA, 'nothing of school A moved')
  assert.equal(await fingerprint(schoolB), beforeB, 'nothing of school B moved')
})

test('[exams] a subject teacher reaches their subject in their class, and nothing beside it', async () => {
  const listed = await body<{ items: PaperSummary[] }>(
    await subjectTeacher.fetch(`/api/schools/${schoolA}/exams/papers?academicYearId=${year}`),
  )
  const mine = [pt1, halfYearly, pt2].map((examId) => paper(examId, sectionOne, maths))
  assert.deepEqual(listed.items.map((item) => item.id).sort(), [...mine].sort())

  // The list and the detail agree, paper by paper.
  const listedIds = new Set(listed.items.map((item) => item.id))
  for (const id of papers.values()) {
    const response = await subjectTeacher.fetch(`/api/schools/${schoolA}/exams/papers/${id}`)
    assert.equal(response.status === 200, listedIds.has(id), `${id} disagrees with the list`)
    if (response.status !== 200) assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
  }

  const before = await fingerprint(schoolA)
  const line = { entries: [{ studentId: child, component: 'periodic_test', value: 5 }] }
  for (const other of [paper(pt2, sectionOne, science), paper(pt2, sectionTwo, maths)]) {
    const response = await subjectTeacher.fetch(`/api/schools/${schoolA}/exams/papers/${other}/marks`, putBody(line))
    assert.equal(response.status, 404, await response.clone().text())
    assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
  }
  // A report card is the whole class, and teaching one subject opens none of it.
  const entries = await subjectTeacher.fetch(`/api/schools/${schoolA}/report-cards/sections/${sectionOne}/terms/term_1/entries`)
  assert.equal(entries.status, 403, await entries.clone().text())
  assert.equal(await fingerprint(schoolA), before)
})

test('[exams] the class teacher reads the whole class but records no subject they do not teach', async () => {
  const listed = await body<{ items: PaperSummary[] }>(
    await classTeacher.fetch(`/api/schools/${schoolA}/exams/papers?academicYearId=${year}`),
  )
  const expected = [
    ...[pt1, halfYearly, pt2].flatMap((examId) => [paper(examId, sectionOne, maths), paper(examId, sectionOne, science)]),
    ...[pt1, halfYearly, pt2].map((examId) => paper(examId, sectionTwo, maths)),
  ]
  assert.deepEqual(listed.items.map((item) => item.id).sort(), [...expected].sort())

  const science1 = paper(pt2, sectionOne, science)
  const read = await classTeacher.fetch(`/api/schools/${schoolA}/exams/papers/${science1}`)
  assert.equal(read.status, 200, await read.clone().text())

  const before = await fingerprint(schoolA)
  const saved = await classTeacher.fetch(
    `/api/schools/${schoolA}/exams/papers/${science1}/marks`,
    putBody({ entries: [{ studentId: child, component: 'periodic_test', value: 5 }] }),
  )
  assert.equal(saved.status, 404, await saved.clone().text())
  assert.equal(await codeOf(saved), 'RESOURCE_NOT_FOUND')
  assert.equal(await fingerprint(schoolA), before)

  // The entries of their own class open; the class next door does not.
  const own = await classTeacher.fetch(`/api/schools/${schoolA}/report-cards/sections/${sectionOne}/terms/term_1/entries`)
  assert.equal(own.status, 200, await own.clone().text())
  const next = await classTeacher.fetch(`/api/schools/${schoolA}/report-cards/sections/${sectionTwo}/terms/term_1/entries`)
  assert.equal(next.status, 404, await next.clone().text())
})

test('[exams] an assignment that ended last month takes the class with it', async () => {
  const listed = await body<{ items: PaperSummary[] }>(
    await endedTeacher.fetch(`/api/schools/${schoolA}/exams/papers?academicYearId=${year}`),
  )
  assert.deepEqual(
    listed.items.map((item) => item.id).sort(),
    [pt1, halfYearly, pt2].map((examId) => paper(examId, sectionTwo, science)).sort(),
  )
  const before = await fingerprint(schoolA)
  const maths1 = paper(pt2, sectionOne, maths)
  const read = await endedTeacher.fetch(`/api/schools/${schoolA}/exams/papers/${maths1}`)
  assert.equal(read.status, 404, await read.clone().text())
  const saved = await endedTeacher.fetch(
    `/api/schools/${schoolA}/exams/papers/${maths1}/marks`,
    putBody({ entries: [{ studentId: child, component: 'periodic_test', value: 5 }] }),
  )
  assert.equal(saved.status, 404, await saved.clone().text())
  const results = await endedTeacher.fetch(`/api/schools/${schoolA}/exams/students/${child}/results?academicYearId=${year}`)
  assert.equal(results.status, 404, await results.clone().text())
  assert.equal(await fingerprint(schoolA), before)
})

test('[exams] the accountant is refused on every exam and report card route, one denied row each', async () => {
  const before = await fingerprint(schoolA)
  const denials = await deniedRows(accountantMembershipId)
  const routes: Route[] = [
    // Every route that names a record, with a real record of this school.
    ...routesNaming(child).filter((route) => route.path.includes(`students/${child}`)),
    ...routesNaming(sectionOne).filter((route) => route.path.includes(`sections/${sectionOne}`)),
    ...routesNaming(paper(pt2, sectionOne, maths)).filter((route) => route.path.startsWith('/exams/papers/')),
    ...routesNaming(pt2).filter((route) => route.path.startsWith(`/exams/${pt2}`)),
    { method: 'GET', path: `/exams?academicYearId=${year}` },
    { method: 'GET', path: `/exams/papers?academicYearId=${year}` },
    { method: 'GET', path: `/exams/${pt2}` },
    {
      method: 'POST',
      path: '/exams',
      body: { academicYearId: year, kind: 'annual', startsOn: today, endsOn: today, recheckDeadline: today },
    },
    { method: 'GET', path: `/report-cards/sections?academicYearId=${year}&card=term_1` },
    { method: 'GET', path: '/report-cards/settings' },
    {
      method: 'PUT',
      path: '/report-cards/settings',
      body: {
        expectedVersion: 0,
        displayMode: 'marks',
        gradeBands: [
          { label: 'P', min: 50, max: 100 },
          { label: 'Q', min: 0, max: 49 },
        ],
        layout: {
          showLogo: true,
          headerLines: { schoolName: true, affiliationNumber: true, address: true, contact: true },
          blocks: ['scholastic'],
          signatures: [],
          footerNote: '',
        },
      },
    },
  ]
  // One route per path and method, so the count is exact.
  const unique = [...new Map(routes.map((route) => [`${route.method} ${route.path}`, route])).values()]
  for (const route of unique) {
    const response = await call(accountant, route)
    assert.equal(response.status, 403, `${route.method} ${route.path} answered ${response.status}`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', `${route.method} ${route.path}`)
  }
  assert.equal(await fingerprint(schoolA), before)
  assert.equal(await deniedRows(accountantMembershipId), denials + unique.length)
})

test('[exams] before publishing a parent sees no result, no card, no dashboard figure and no marks in their copy', async () => {
  const results = await body<Results>(
    await parent.fetch(`/api/schools/${schoolA}/exams/students/${child}/results?academicYearId=${year}`),
  )
  assert.equal(results.view, 'family')
  assert.deepEqual(results.exams, [])
  const cards = await body<StudentCards>(
    await parent.fetch(`/api/schools/${schoolA}/report-cards/students/${child}?academicYearId=${year}`),
  )
  assert.deepEqual(cards.cards, [])
  const dashboard = await body<{ children: { student: { id: string }; latestReportCard?: unknown }[] }>(
    await parent.fetch(`/api/schools/${schoolA}/dashboard`),
  )
  const mine = dashboard.children.find((entry) => entry.student.id === child)
  assert.ok(mine, 'the child is on the dashboard')
  assert.equal(mine.latestReportCard, undefined)
  const copy = await parent.fetch(`/api/schools/${schoolA}/students/${child}/subject-access`)
  assert.equal(copy.status, 200, await copy.clone().text())
  const exported = await body<{ exams?: unknown[]; reportCards?: unknown[] }>(copy)
  assert.deepEqual(exported.exams ?? [], [])
  assert.deepEqual(exported.reportCards ?? [], [])

  // Another family's child is not there at all, in any form.
  for (const path of [
    `/exams/students/${stranger}/results?academicYearId=${year}`,
    `/report-cards/students/${stranger}?academicYearId=${year}`,
  ]) {
    const response = await parent.fetch(`/api/schools/${schoolA}${path}`)
    assert.equal(response.status, 404, path)
    assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND', path)
  }
})

test('[exams] a body naming a pupil not on the roster is refused and writes nothing', async () => {
  const before = await fingerprint(schoolA)
  const response = await subjectTeacher.fetch(
    `/api/schools/${schoolA}/exams/papers/${paper(pt2, sectionOne, maths)}/marks`,
    putBody({
      entries: [
        { studentId: child, component: 'periodic_test', value: 7 },
        { studentId: pupilTwo, component: 'periodic_test', value: 7 },
      ],
    }),
  )
  assert.equal(response.status, 400, await response.clone().text())
  assert.equal(await reasonOf(response), 'exam_pupil_not_on_roster')
  assert.equal(await fingerprint(schoolA), before, 'the valid line before it was not written either')
})

test('[exams] after the deadline the teacher is refused, and the office corrects only with a reason', async () => {
  const locked = paper(halfYearly, sectionOne, maths)
  const original = await adminPool().query<{ id: string; marks_tenths: number }>(
    `SELECT id, marks_tenths FROM exam_marks WHERE school_id = $1 AND paper_id = $2 AND student_id = $3
        AND component = 'written' AND revision = 1`,
    [schoolA, locked, child],
  )
  const originalRow = original.rows[0]
  assert.ok(originalRow)

  const before = await fingerprint(schoolA)
  const late = await subjectTeacher.fetch(
    `/api/schools/${schoolA}/exams/papers/${locked}/marks`,
    putBody({
      entries: [{ studentId: child, component: 'written', value: 12 }],
      change: { reasonKind: 'recheck', reason: 'Re-checked after the deadline' },
    }),
  )
  assert.equal(late.status, 400, await late.clone().text())
  assert.equal(await reasonOf(late), 'exam_recheck_deadline_passed')

  const noReason = await office.fetch(
    `/api/schools/${schoolA}/exams/papers/${locked}/corrections`,
    postBody({ entries: [{ studentId: child, component: 'written', value: 12 }] }),
  )
  assert.equal(noReason.status, 400, await noReason.clone().text())
  assert.equal(await fingerprint(schoolA), before)

  const corrected = await office.fetch(
    `/api/schools/${schoolA}/exams/papers/${locked}/corrections`,
    postBody({
      entries: [{ studentId: child, component: 'written', value: 12 }],
      reasonKind: 'entry_error',
      reason: 'Security suite: transposed digits',
    }),
  )
  assert.ok(corrected.status < 300, await corrected.clone().text())
  const rows = await adminPool().query<{ id: string; revision: number; marks_tenths: number; kind: string; reason_kind: string | null }>(
    `SELECT id, revision, marks_tenths, kind, reason_kind FROM exam_marks
      WHERE school_id = $1 AND paper_id = $2 AND student_id = $3 AND component = 'written' ORDER BY revision`,
    [schoolA, locked, child],
  )
  assert.equal(rows.rows[0]?.id, originalRow.id, 'the original row is still there')
  assert.equal(rows.rows[0]?.marks_tenths, originalRow.marks_tenths)
  assert.deepEqual(
    rows.rows.slice(1).map((row) => [row.revision, row.marks_tenths, row.kind, row.reason_kind]),
    [[2, 120, 'correction', 'entry_error']],
  )
})

let childVersion = ''

test('[exams] after publishing a parent sees the published figures, and list and detail agree', async () => {
  for (const examId of [pt1, halfYearly]) {
    const published = await office.fetch(
      `/api/schools/${schoolA}/exams/${examId}/sections/${sectionOne}/publish`,
      postBody({}),
    )
    assert.ok(published.status < 300, await published.clone().text())
  }
  const results = await body<Results>(
    await parent.fetch(`/api/schools/${schoolA}/exams/students/${child}/results?academicYearId=${year}`),
  )
  assert.deepEqual(
    results.exams.map((exam) => exam.exam.id),
    [pt1, halfYearly],
  )
  const half = results.exams.find((exam) => exam.exam.id === halfYearly)
  const mathsRow = half?.subjects.find((subject) => subject.subject.id === maths)
  // 4 + 4 + the corrected 12 written: 20 out of 90.
  assert.equal(mathsRow?.components.find((part) => part.component === 'written')?.value, 12)
  assert.equal(mathsRow?.percentage, 22.2)
  assert.ok(half?.publishedAt)

  const cardsPublished = await office.fetch(
    `/api/schools/${schoolA}/report-cards/sections/${sectionOne}/cards/term_1/publish`,
    postBody({}),
  )
  assert.ok(cardsPublished.status < 300, await cardsPublished.clone().text())
  const cards = await body<StudentCards>(
    await parent.fetch(`/api/schools/${schoolA}/report-cards/students/${child}?academicYearId=${year}`),
  )
  assert.equal(cards.cards.length, 1)
  childVersion = cards.cards[0]!.id
  // Every card on the list opens, as the family's view.
  for (const card of cards.cards) {
    const view = await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${card.id}`)
    assert.equal(view.status, 200, await view.clone().text())
    assert.equal((await body<CardView>(view)).view, 'family')
  }
  const strangerVersions = await adminPool().query<{ id: string }>(
    'SELECT id FROM report_card_versions WHERE school_id = $1 AND student_id = $2',
    [schoolA, stranger],
  )
  assert.equal(strangerVersions.rowCount, 1)
  const theirs = await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${strangerVersions.rows[0]!.id}`)
  assert.equal(theirs.status, 404, 'another family’s card is not there')

  const dashboard = await body<{ children: { student: { id: string }; latestReportCard?: { versionId: string } }[] }>(
    await parent.fetch(`/api/schools/${schoolA}/dashboard`),
  )
  assert.equal(dashboard.children.find((entry) => entry.student.id === child)?.latestReportCard?.versionId, childVersion)

  const copy = await body<{ exams?: Results[]; reportCards?: { id: string }[] }>(
    await parent.fetch(`/api/schools/${schoolA}/students/${child}/subject-access`),
  )
  assert.deepEqual(
    copy.exams?.flatMap((entry) => entry.exams.map((exam) => exam.exam.id)),
    [pt1, halfYearly],
  )
  assert.deepEqual(
    copy.reportCards?.map((card) => card.id),
    [childVersion],
  )
})

test('[exams] a published card does not move when the bands, the layout or a mark change', async () => {
  const frozen = async () =>
    (
      await adminPool().query<{ content: unknown; content_hash: string }>(
        'SELECT content, content_hash FROM report_card_versions WHERE id = $1',
        [childVersion],
      )
    ).rows[0]
  const before = await frozen()
  const seenBefore = await body<CardView>(await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${childVersion}`))

  const settings = await body<{ version: number; layout: { footerNote: string } & Record<string, unknown> }>(
    await office.fetch(`/api/schools/${schoolA}/report-cards/settings`),
  )
  const saved = await office.fetch(
    `/api/schools/${schoolA}/report-cards/settings`,
    putBody({
      expectedVersion: settings.version,
      displayMode: 'grades',
      gradeBands: [
        { label: 'P', min: 50, max: 100 },
        { label: 'Q', min: 0, max: 49 },
      ],
      layout: { ...settings.layout, footerNote: 'Changed by the security suite' },
    }),
  )
  assert.equal(saved.status, 200, await saved.clone().text())
  const corrected = await office.fetch(
    `/api/schools/${schoolA}/exams/papers/${paper(halfYearly, sectionOne, maths)}/corrections`,
    postBody({
      entries: [{ studentId: child, component: 'written', value: 70 }],
      reasonKind: 'recheck',
      reason: 'Security suite: re-check',
    }),
  )
  assert.ok(corrected.status < 300, await corrected.clone().text())

  assert.deepEqual(await frozen(), before, 'the stored card is exactly as published')
  const seenAfter = await body<CardView>(await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${childVersion}`))
  assert.deepEqual(seenAfter.content, seenBefore.content, 'and the family reads the same card')

  // The correction is not the family's until the office publishes again.
  const results = await body<Results>(
    await parent.fetch(`/api/schools/${schoolA}/exams/students/${child}/results?academicYearId=${year}`),
  )
  const half = results.exams.find((exam) => exam.exam.id === halfYearly)
  const mathsGrade = half?.subjects.find((subject) => subject.subject.id === maths)
  assert.deepEqual(mathsGrade?.components, [], 'grades only now, with no component values')
  assert.equal(mathsGrade?.percentage, undefined)
  assert.equal(mathsGrade?.grade, 'Q', 'the published 22.2, not the corrected 86.7')
})

test('[exams] the promoted child’s last year stays readable to their parent, and never to another family', async () => {
  // Last year's results, published and carded while the year was open.
  await fillExam(lastPt1, 'periodic_test_1', lastYear, lastSection, [maths], [child, stranger])
  await fillExam(lastHalfYearly, 'half_yearly', lastYear, lastSection, [maths], [child, stranger])
  for (const examId of [lastPt1, lastHalfYearly]) {
    const published = await office.fetch(
      `/api/schools/${schoolA}/exams/${examId}/sections/${lastSection}/publish`,
      postBody({}),
    )
    assert.ok(published.status < 300, await published.clone().text())
  }
  const carded = await office.fetch(
    `/api/schools/${schoolA}/report-cards/sections/${lastSection}/cards/term_1/publish`,
    postBody({}),
  )
  assert.ok(carded.status < 300, await carded.clone().text())
  await adminPool().query(`UPDATE academic_years SET status = 'closed' WHERE id = $1`, [lastYear])

  const cards = await body<StudentCards>(
    await parent.fetch(`/api/schools/${schoolA}/report-cards/students/${child}?academicYearId=${lastYear}`),
  )
  assert.equal(cards.cards.length, 1)
  const card = await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${cards.cards[0]!.id}`)
  assert.equal(card.status, 200, await card.clone().text())
  const results = await body<Results>(
    await parent.fetch(`/api/schools/${schoolA}/exams/students/${child}/results?academicYearId=${lastYear}`),
  )
  assert.deepEqual(
    results.exams.map((exam) => exam.exam.id),
    [lastPt1, lastHalfYearly],
  )

  const strangerLast = await adminPool().query<{ id: string }>(
    'SELECT id FROM report_card_versions WHERE school_id = $1 AND student_id = $2 AND academic_year_id = $3',
    [schoolA, stranger, lastYear],
  )
  assert.equal(strangerLast.rowCount, 1)
  for (const yearId of [year, lastYear]) {
    for (const [reader, pupil] of [
      [parent, stranger],
      [strangerParent, child],
    ] as const) {
      for (const path of [
        `/report-cards/students/${pupil}?academicYearId=${yearId}`,
        `/exams/students/${pupil}/results?academicYearId=${yearId}`,
      ]) {
        const response = await reader.fetch(`/api/schools/${schoolA}${path}`)
        assert.equal(response.status, 404, `${path}: ${await response.clone().text()}`)
        assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
      }
    }
  }
  const theirs = await parent.fetch(`/api/schools/${schoolA}/report-cards/versions/${strangerLast.rows[0]!.id}`)
  assert.equal(theirs.status, 404)
  const mine = await strangerParent.fetch(`/api/schools/${schoolA}/report-cards/versions/${cards.cards[0]!.id}`)
  assert.equal(mine.status, 404)
})
