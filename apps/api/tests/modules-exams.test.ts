/**
 * The exams module (Task 21): exam dates, papers, the marks sheet, the
 * office's corrections, publishing and a pupil's results.
 *
 * The suite owns its own academic year, class, two sections, two subjects,
 * pupils and staff, so no other suite's rows can move a count. Its year
 * starts earlier than any other suite's, so the attendance calendar never
 * resolves a day to it. Every date is worked out from the database's today,
 * so the suite does not rot: an exam is made open, locked or not yet started
 * by where its dates fall around today.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { DEFAULT_GRADE_BANDS, DEFAULT_REPORT_CARD_LAYOUT, gradeFor } from '@erp/contracts'
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
const OWNER_EMAIL = `exam-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string

const suffix = randomUUID().slice(0, 8)
const examYear = randomUUID()
const examGrade = randomUUID()
const sectionOne = randomUUID()
const sectionTwo = randomUUID()
const maths = randomUUID()
const science = randomUUID()

const p1 = randomUUID()
const p2 = randomUUID()
const outsider = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let subjectTeacher: Client
let classTeacher: Client
let parent: Client
const extraUserIds: string[] = []

let today = ''
let yearStart = ''
let yearEnd = ''
const exams: Record<string, string> = {}

interface ErrorBody {
  error: { code: string; requestId: string; reason?: string }
}
interface NamedReference {
  id: string
  name: string
}
interface Schedule {
  id: string
  kind: string
  startsOn: string
  endsOn: string
  recheckDeadline: string
  locked: boolean
  sectionsTotal: number
  sectionsPublished: number
  version: number
  allowedActions: string[]
}
interface PaperSummary {
  id: string
  exam: { id: string; kind: string }
  section: NamedReference
  subject: NamedReference
  pupils: number
  entered: number
  expected: number
  published: boolean
  window: { state: string; record: boolean; recordBlockedBy?: string; correct: boolean; correctBlockedBy?: string }
  allowedActions: string[]
}
interface Sheet {
  paper: PaperSummary
  components: { key: string; maxMarks: number }[]
  rows: { student: { id: string }; cells: { component: string; value: number | string; revision: number; kind: string }[] }[]
}
interface SectionStatus {
  section: NamedReference
  pupils: number
  papers: { paperId: string; subject: NamedReference; entered: number; expected: number; complete: boolean }[]
  complete: boolean
  publication: { publishedAt: string; changedSince: boolean } | null
  readyToPublish: boolean
  blockedBy?: string
}
interface Overview {
  exam: Schedule
  sections: SectionStatus[]
}
interface Results {
  view: string
  displayMode: string
  section?: NamedReference
  exams: {
    exam: { id: string; kind: string }
    publishedAt?: string
    subjects: {
      subject: NamedReference
      components: { component: string; value?: number | string }[]
      percentage?: number | null
      grade: string | null
    }[]
  }[]
}
interface History {
  rows: { revision: number; kind: string; value: number | string; reasonKind?: string; recordedBy?: string }[]
}

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}
function put(value: unknown): RequestInit {
  return { ...post(value), method: 'PUT' }
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return (await response.json()) as T
}

async function failure(response: Response, status: number, reason?: string): Promise<ErrorBody> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  const body = JSON.parse(text) as ErrorBody
  if (reason !== undefined) assert.equal(body.error.reason, reason, text)
  return body
}

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

const base = () => `/api/schools/${schoolA}/exams`

async function markRows(paperId: string, studentId: string): Promise<
  { revision: number; status: string; marks_tenths: number | null; kind: string; reason_kind: string | null }[]
> {
  const found = await adminPool().query<{
    revision: number
    status: string
    marks_tenths: number | null
    kind: string
    reason_kind: string | null
  }>(
    `SELECT revision, status, marks_tenths, kind, reason_kind FROM exam_marks
      WHERE school_id = $1 AND paper_id = $2 AND student_id = $3 ORDER BY component, revision`,
    [schoolA, paperId, studentId],
  )
  return found.rows
}

async function markCount(): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM exam_marks WHERE school_id = $1 AND academic_year_id = $2',
    [schoolA, examYear],
  )
  return Number(found.rows[0]?.count)
}

async function auditRows(action: string, targetId: string): Promise<
  { safe_changes: Record<string, unknown>; note: string | null }[]
> {
  const found = await adminPool().query<{ safe_changes: Record<string, unknown>; note: string | null }>(
    `SELECT e.safe_changes, n.note FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.action = $2 AND e.target_id = $3::uuid
      ORDER BY e.created_at`,
    [schoolA, action, targetId],
  )
  return found.rows
}

async function papersOf(client: Client, query = ''): Promise<PaperSummary[]> {
  const listed = await ok<{ items: PaperSummary[] }>(
    await client.fetch(`${base()}/papers?academicYearId=${examYear}${query}`),
  )
  return listed.items
}

async function paperFor(kind: string, sectionId: string, subjectId: string): Promise<PaperSummary> {
  const found = (await papersOf(owner)).find(
    (paper) => paper.exam.kind === kind && paper.section.id === sectionId && paper.subject.id === subjectId,
  )
  assert.ok(found, `a ${kind} paper exists`)
  return found
}

function saveMarks(client: Client, paperId: string, body: unknown): Promise<Response> {
  return client.fetch(`${base()}/papers/${paperId}/marks`, put(body))
}

function correct(client: Client, paperId: string, body: unknown): Promise<Response> {
  return client.fetch(`${base()}/papers/${paperId}/corrections`, post(body))
}

async function results(client: Client, studentId: string): Promise<Results> {
  return ok<Results>(await client.fetch(`${base()}/students/${studentId}/results?academicYearId=${examYear}`))
}

async function member(input: {
  roleKeys: readonly string[]
  label: string
  withMfa: boolean
  staffId?: string
  childId?: string
}): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `exam-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, `Exams ${input.label}`, email])
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
  if (input.childId !== undefined) {
    const guardianId = randomUUID()
    await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [
      guardianId,
      schoolA,
      `Exams guardian ${input.label}`,
    ])
    await pool.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`,
      [schoolA, membershipId, guardianId],
    )
    await pool.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian')`,
      [schoolA, input.childId, guardianId],
    )
    await pool.query(
      `INSERT INTO guardian_student_access
         (school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
       VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
      [schoolA, guardianId, input.childId, ownerMembershipId],
    )
  }
  await setFixturePassword(server, userId, PASSWORD)
  extraUserIds.push(userId)
  return input.withMfa
    ? signInWithMfa(server, { userId, email, password: PASSWORD })
    : signInWithPassword(server, email, PASSWORD)
}

async function insertStaff(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active',$5)`,
    [id, schoolA, `EXM-${suffix}-${label}`, `Exams ${label}`, yearStart],
  )
  return id
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  const found = await pool.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata'))::date, 'YYYY-MM-DD') AS today
       FROM schools WHERE id = $1`,
    [schoolA],
  )
  today = found.rows[0]?.today ?? ''
  yearStart = shift(today, -300)
  yearEnd = shift(today, 200)

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'upcoming')`,
    [examYear, schoolA, `EXM-${suffix}`, yearStart, yearEnd],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,12)`, [
    examGrade,
    schoolA,
    `Exams ${suffix}`,
    `E${suffix.slice(0, 3)}`,
  ])
  const subjectTeacherStaff = await insertStaff('subject')
  const classTeacherStaff = await insertStaff('class')
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [sectionOne, schoolA, examYear, examGrade, `E1-${suffix.slice(0, 4)}`, classTeacherStaff],
  )
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`, [
    sectionTwo,
    schoolA,
    examYear,
    examGrade,
    `E2-${suffix.slice(0, 4)}`,
  ])
  for (const [id, name] of [
    [maths, 'Mathematics'],
    [science, 'Science'],
  ] as const) {
    await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
      id,
      schoolA,
      `${name} ${suffix}`,
      `${name.slice(0, 3).toUpperCase()}-${suffix}`,
    ])
    await pool.query(
      `INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`,
      [schoolA, examGrade, examYear, id],
    )
  }
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [schoolA, subjectTeacherStaff, examYear, sectionOne, maths, yearStart],
  )
  const pupils: [string, string, string][] = [
    [p1, 'First Pupil', sectionOne],
    [p2, 'Second Pupil', sectionOne],
    [outsider, 'Other Class', sectionTwo],
  ]
  for (const [index, [id, name, sectionId]] of pupils.entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, schoolA, `EXM/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), schoolA, id, examYear, sectionId, index + 1, yearStart],
    )
  }

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  subjectTeacher = await member({ roleKeys: ['teacher'], label: 'subject', withMfa: false, staffId: subjectTeacherStaff })
  classTeacher = await member({ roleKeys: ['teacher'], label: 'class', withMfa: false, staffId: classTeacherStaff })
  parent = await member({ roleKeys: ['parent'], label: 'parent', withMfa: false, childId: p1 })
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM exam_settings WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [[ownerUserId, ...extraUserIds]])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await server.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// Exam dates and papers.

test('the office creates exams and every section gets a paper per subject', async () => {
  const plan: [string, string, string, string][] = [
    // Open now: the teacher may still enter marks.
    ['periodic_test_1', shift(today, -5), shift(today, -4), shift(today, 3)],
    ['half_yearly', shift(today, -2), shift(today, -1), shift(today, 5)],
    // Not started yet.
    ['periodic_test_2', shift(today, 10), shift(today, 11), shift(today, 15)],
  ]
  for (const [kind, startsOn, endsOn, recheckDeadline] of plan) {
    const created = await ok<Schedule>(
      await owner.fetch(base(), post({ academicYearId: examYear, kind, startsOn, endsOn, recheckDeadline })),
      201,
    )
    assert.equal(created.kind, kind)
    assert.equal(created.sectionsTotal, 2)
    assert.equal(created.sectionsPublished, 0)
    assert.equal(created.locked, false)
    assert.ok(created.allowedActions.includes('exams.manage'))
    exams[kind] = created.id
    const audits = await auditRows('exams.manage', created.id)
    assert.equal(audits.length, 1)
    assert.equal(audits[0]?.safe_changes.papers, 4)
  }

  // One exam of each kind a year.
  await failure(
    await owner.fetch(
      base(),
      post({ academicYearId: examYear, kind: 'half_yearly', startsOn: today, endsOn: today, recheckDeadline: today }),
    ),
    400,
  )
  // Every date inside the year.
  await failure(
    await owner.fetch(
      base(),
      post({
        academicYearId: examYear,
        kind: 'annual',
        startsOn: shift(yearEnd, -1),
        endsOn: shift(yearEnd, -1),
        recheckDeadline: shift(yearEnd, 3),
      }),
    ),
    400,
    'exam_dates_outside_year',
  )
})

test('the exam list is the office’s; a teacher and a parent see none', async () => {
  const listed = await ok<{ items: Schedule[]; today: string }>(
    await owner.fetch(`${base()}?academicYearId=${examYear}`),
  )
  assert.deepEqual(
    listed.items.map((item) => item.kind),
    ['periodic_test_1', 'half_yearly', 'periodic_test_2'],
  )
  assert.equal(listed.today, today)
  for (const client of [subjectTeacher, classTeacher, parent]) {
    const theirs = await ok<{ items: Schedule[] }>(await client.fetch(`${base()}?academicYearId=${examYear}`))
    assert.deepEqual(theirs.items, [])
  }
  await failure(await owner.fetch(`${base()}?academicYearId=${randomUUID()}`), 400)
  // The overview is the exam's own row: a teacher is told it is not there.
  await failure(await subjectTeacher.fetch(`${base()}/${exams.periodic_test_1}`), 404)
})

test('a subject teacher sees their own subject; a class teacher sees the whole class', async () => {
  const office = await papersOf(owner)
  assert.equal(office.length, 12)

  const subject = await papersOf(subjectTeacher)
  assert.equal(subject.length, 3)
  assert.ok(subject.every((paper) => paper.section.id === sectionOne && paper.subject.id === maths))
  assert.ok(subject.every((paper) => paper.allowedActions.includes('exams.record_marks')))
  assert.deepEqual(
    subject.map((paper) => paper.exam.kind),
    ['periodic_test_1', 'half_yearly', 'periodic_test_2'],
  )

  const klass = await papersOf(classTeacher)
  assert.equal(klass.length, 6)
  assert.ok(klass.every((paper) => paper.section.id === sectionOne))
  assert.ok(klass.every((paper) => !paper.allowedActions.includes('exams.record_marks')))

  const filtered = await papersOf(owner, `&examId=${exams.half_yearly}&sectionId=${sectionTwo}`)
  assert.equal(filtered.length, 2)
  const hy = filtered[0]
  assert.equal(hy?.pupils, 1)
  assert.equal(hy?.expected, 3)
  assert.equal(hy?.entered, 0)
})

// ---------------------------------------------------------------------------
// The marks sheet.

test('a sheet save writes revision 1 and one audit row with no note', async () => {
  const paper = await paperFor('periodic_test_1', sectionOne, maths)
  const sheet = await ok<Sheet>(await subjectTeacher.fetch(`${base()}/papers/${paper.id}`))
  assert.deepEqual(
    sheet.rows.map((row) => row.student.id),
    [p1, p2],
  )
  assert.deepEqual(
    sheet.components.map((component) => [component.key, component.maxMarks]),
    [['periodic_test', 10]],
  )
  assert.equal(sheet.paper.window.record, true)

  const saved = await ok<Sheet>(
    await saveMarks(subjectTeacher, paper.id, {
      entries: [
        { studentId: p1, component: 'periodic_test', value: 8 },
        { studentId: p2, component: 'periodic_test', value: 'absent' },
      ],
    }),
  )
  assert.equal(saved.paper.entered, 2)
  assert.equal(saved.rows[0]?.cells[0]?.value, 8)
  assert.equal(saved.rows[1]?.cells[0]?.value, 'absent')
  const rows = await markRows(paper.id, p1)
  assert.deepEqual(
    rows.map((row) => [row.revision, row.status, row.marks_tenths, row.kind, row.reason_kind]),
    [[1, 'marked', 80, 'entry', null]],
  )
  const audits = await auditRows('exams.record_marks', paper.id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.note, null)
  assert.equal(audits[0]?.safe_changes.entered, 2)
  assert.equal(audits[0]?.safe_changes.changed, 0)
})

test('changing a saved mark needs a reason, which goes only to the note', async () => {
  const paper = await paperFor('periodic_test_1', sectionOne, maths)
  const before = await markCount()
  await failure(
    await saveMarks(subjectTeacher, paper.id, {
      entries: [
        { studentId: p1, component: 'periodic_test', value: 9 },
        { studentId: p2, component: 'periodic_test', value: 'absent' },
      ],
    }),
    400,
    'exam_change_needs_reason',
  )
  assert.equal(await markCount(), before, 'a refused save writes nothing')
  assert.equal((await auditRows('exams.record_marks', paper.id)).length, 1)

  const reason = 'Added the marks up wrongly.'
  const saved = await ok<Sheet>(
    await saveMarks(subjectTeacher, paper.id, {
      entries: [
        { studentId: p1, component: 'periodic_test', value: 9 },
        { studentId: p2, component: 'periodic_test', value: 'absent' },
      ],
      change: { reasonKind: 'entry_error', reason },
    }),
  )
  assert.equal(saved.rows[0]?.cells[0]?.revision, 2)
  const rows = await markRows(paper.id, p1)
  assert.deepEqual(
    rows.map((row) => [row.revision, row.marks_tenths, row.reason_kind]),
    [
      [1, 80, null],
      [2, 90, 'entry_error'],
    ],
  )
  assert.equal((await markRows(paper.id, p2)).length, 1, 'an unchanged cell is not written again')
  const audits = await auditRows('exams.record_marks', paper.id)
  assert.equal(audits.length, 2)
  assert.equal(audits[1]?.note, reason)
  assert.equal(audits[1]?.safe_changes.reasonKind, 'entry_error')
  assert.equal(audits[1]?.safe_changes.changed, 1)
  assert.ok(!JSON.stringify(audits[1]?.safe_changes).includes(reason))
})

test('an outsider, a component outside the exam and a mark above the maximum are refused', async () => {
  const pt1 = await paperFor('periodic_test_1', sectionOne, maths)
  const hy = await paperFor('half_yearly', sectionOne, maths)
  const before = await markCount()
  await failure(
    await saveMarks(subjectTeacher, pt1.id, {
      entries: [{ studentId: outsider, component: 'periodic_test', value: 5 }],
    }),
    400,
    'exam_pupil_not_on_roster',
  )
  await failure(
    await saveMarks(subjectTeacher, pt1.id, { entries: [{ studentId: p1, component: 'written', value: 5 }] }),
    400,
    'exam_component_not_in_exam',
  )
  await failure(
    await saveMarks(subjectTeacher, hy.id, {
      entries: [
        { studentId: p1, component: 'written', value: 60 },
        { studentId: p1, component: 'notebook', value: 6 },
      ],
    }),
    400,
    'exam_mark_above_maximum',
  )
  assert.equal(await markCount(), before)
})

test('a sheet before its exam starts is refused, and a teacher may not touch another subject', async () => {
  const pt2 = await paperFor('periodic_test_2', sectionOne, maths)
  assert.equal(pt2.window.state, 'not_started')
  await failure(
    await saveMarks(subjectTeacher, pt2.id, { entries: [{ studentId: p1, component: 'periodic_test', value: 5 }] }),
    400,
    'exam_not_started',
  )
  const science1 = await paperFor('periodic_test_1', sectionOne, science)
  await failure(
    await saveMarks(subjectTeacher, science1.id, {
      entries: [{ studentId: p1, component: 'periodic_test', value: 5 }],
    }),
    404,
  )
})

test('after the deadline the sheet is closed and publishing waits for every mark', async () => {
  // Moving the dates into the past locks the first periodic test.
  const current = await ok<{ items: Schedule[] }>(await owner.fetch(`${base()}?academicYearId=${examYear}`))
  const pt1 = current.items.find((item) => item.kind === 'periodic_test_1')
  assert.ok(pt1)
  const moved = await ok<Schedule>(
    await owner.fetch(
      `${base()}/${pt1.id}`,
      put({
        expectedVersion: pt1.version,
        startsOn: shift(today, -30),
        endsOn: shift(today, -29),
        recheckDeadline: shift(today, -20),
      }),
    ),
  )
  assert.equal(moved.locked, true)
  assert.equal(moved.version, pt1.version + 1)

  const paper = await paperFor('periodic_test_1', sectionOne, maths)
  assert.equal(paper.window.state, 'locked')
  await failure(
    await saveMarks(subjectTeacher, paper.id, { entries: [{ studentId: p1, component: 'periodic_test', value: 9 }] }),
    400,
    'exam_recheck_deadline_passed',
  )

  await failure(
    await owner.fetch(`${base()}/${exams.half_yearly}/sections/${sectionOne}/publish`, post({})),
    400,
    'exam_publish_before_deadline',
  )
  await failure(
    await owner.fetch(`${base()}/${exams.periodic_test_1}/sections/${sectionOne}/publish`, post({})),
    400,
    'exam_section_incomplete',
  )
})

test('a parent sees nothing before publishing', async () => {
  const theirs = await results(parent, p1)
  assert.equal(theirs.view, 'family')
  assert.deepEqual(theirs.exams, [])
  const staff = await results(owner, p1)
  assert.equal(staff.view, 'staff')
  assert.equal(staff.exams.length, 1)
  assert.equal(staff.exams[0]?.subjects[0]?.percentage, 90)
})

test('the office corrects after the deadline with a reason kept in the note', async () => {
  const paper = await paperFor('periodic_test_1', sectionOne, science)
  const reason = 'Filled in from the answer sheets.'
  const corrected = await ok<Sheet>(
    await correct(owner, paper.id, {
      entries: [
        { studentId: p1, component: 'periodic_test', value: 7 },
        { studentId: p2, component: 'periodic_test', value: 'medical' },
      ],
      reasonKind: 'other',
      reason,
    }),
    201,
  )
  assert.equal(corrected.paper.entered, 2)
  const rows = await markRows(paper.id, p1)
  assert.deepEqual(
    rows.map((row) => [row.revision, row.kind, row.reason_kind]),
    [[1, 'correction', 'other']],
  )
  const audits = await auditRows('exams.manage', paper.id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.note, reason)
  assert.equal(audits[0]?.safe_changes.corrected, 2)
  assert.equal(audits[0]?.safe_changes.afterPublication, false)
  assert.ok(!JSON.stringify(audits[0]?.safe_changes).includes(reason))

  // Sending the same values again changes nothing and writes nothing.
  const before = await markCount()
  await ok<Sheet>(
    await correct(owner, paper.id, {
      entries: [{ studentId: p1, component: 'periodic_test', value: 7 }],
      reasonKind: 'other',
      reason,
    }),
    201,
  )
  assert.equal(await markCount(), before)
  assert.equal((await auditRows('exams.manage', paper.id)).length, 1)
})

test('the overview counts each section, and a complete section publishes once', async () => {
  const overview = await ok<Overview>(await owner.fetch(`${base()}/${exams.periodic_test_1}`))
  const one = overview.sections.find((section) => section.section.id === sectionOne)
  const two = overview.sections.find((section) => section.section.id === sectionTwo)
  assert.equal(one?.pupils, 2)
  assert.equal(one?.complete, true)
  assert.equal(one?.readyToPublish, true)
  assert.equal(one?.blockedBy, undefined)
  assert.deepEqual(
    one?.papers.map((paper) => [paper.entered, paper.expected]),
    [
      [2, 2],
      [2, 2],
    ],
  )
  assert.equal(two?.pupils, 1)
  assert.equal(two?.complete, false)
  assert.equal(two?.blockedBy, 'exam_section_incomplete')

  const published = await ok<SectionStatus>(
    await owner.fetch(`${base()}/${exams.periodic_test_1}/sections/${sectionOne}/publish`, post({})),
    201,
  )
  assert.ok(published.publication)
  assert.equal(published.publication?.changedSince, false)
  assert.equal(published.blockedBy, 'exam_nothing_to_publish')
  const audits = await auditRows('exams.publish', sectionOne)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.safe_changes.republish, false)

  await failure(
    await owner.fetch(`${base()}/${exams.periodic_test_1}/sections/${sectionOne}/publish`, post({})),
    400,
    'exam_nothing_to_publish',
  )
  // Published results keep the dates they were marked against.
  const exam = await ok<Overview>(await owner.fetch(`${base()}/${exams.periodic_test_1}`))
  assert.equal(exam.exam.sectionsPublished, 1)
  await failure(
    await owner.fetch(
      `${base()}/${exams.periodic_test_1}`,
      put({ expectedVersion: exam.exam.version, startsOn: shift(today, -31), endsOn: shift(today, -29), recheckDeadline: shift(today, -20) }),
    ),
    400,
    'exam_already_published',
  )
})

test('a parent sees the published figures, and a later correction only after republishing', async () => {
  const published = await results(parent, p1)
  assert.equal(published.displayMode, 'marks')
  assert.equal(published.exams.length, 1)
  const exam = published.exams[0]
  assert.ok(exam?.publishedAt)
  const mathsResult = exam?.subjects.find((subject) => subject.subject.id === maths)
  assert.equal(mathsResult?.percentage, 90)
  assert.deepEqual(mathsResult?.components, [{ component: 'periodic_test', value: 9 }])
  assert.equal(mathsResult?.grade, gradeFor(DEFAULT_GRADE_BANDS, 90))
  assert.equal(exam?.subjects.find((subject) => subject.subject.id === science)?.percentage, 70)

  const paper = await paperFor('periodic_test_1', sectionOne, maths)
  await ok<Sheet>(
    await correct(owner, paper.id, {
      entries: [{ studentId: p1, component: 'periodic_test', value: 5 }],
      reasonKind: 'recheck',
      reason: 'Re-checked on request.',
    }),
    201,
  )
  const audits = await auditRows('exams.manage', paper.id)
  assert.equal(audits.at(-1)?.safe_changes.afterPublication, true)

  const unchanged = await results(parent, p1)
  assert.equal(unchanged.exams[0]?.subjects.find((subject) => subject.subject.id === maths)?.percentage, 90)
  const staff = await results(owner, p1)
  assert.equal(staff.exams[0]?.subjects.find((subject) => subject.subject.id === maths)?.percentage, 50)

  const overview = await ok<Overview>(await owner.fetch(`${base()}/${exams.periodic_test_1}`))
  const one = overview.sections.find((section) => section.section.id === sectionOne)
  assert.equal(one?.publication?.changedSince, true)
  assert.equal(one?.readyToPublish, true)

  const again = await ok<SectionStatus>(
    await owner.fetch(`${base()}/${exams.periodic_test_1}/sections/${sectionOne}/publish`, post({})),
    201,
  )
  assert.equal(again.publication?.changedSince, false)
  assert.equal((await auditRows('exams.publish', sectionOne)).at(-1)?.safe_changes.republish, true)
  const republished = await results(parent, p1)
  assert.equal(republished.exams[0]?.subjects.find((subject) => subject.subject.id === maths)?.percentage, 50)
})

test('a cell’s history lists every row, oldest first', async () => {
  const paper = await paperFor('periodic_test_1', sectionOne, maths)
  const history = await ok<History>(
    await owner.fetch(`${base()}/papers/${paper.id}/students/${p1}/history?component=periodic_test`),
  )
  assert.deepEqual(
    history.rows.map((row) => [row.revision, row.kind, row.value, row.reasonKind ?? null]),
    [
      [1, 'entry', 8, null],
      [2, 'entry', 9, 'entry_error'],
      [3, 'correction', 5, 'recheck'],
    ],
  )
  await failure(
    await owner.fetch(`${base()}/papers/${paper.id}/students/${outsider}/history?component=periodic_test`),
    404,
  )
})

test('under grades a family view shows grades alone; staff still see marks', async () => {
  await adminPool().query(
    `INSERT INTO exam_settings (school_id, display_mode, grade_bands, layout, updated_by_membership_id)
     VALUES ($1, 'grades', $2::jsonb, $3::jsonb, $4)`,
    [schoolA, JSON.stringify(DEFAULT_GRADE_BANDS), JSON.stringify(DEFAULT_REPORT_CARD_LAYOUT), ownerMembershipId],
  )
  try {
    const family = await results(parent, p1)
    assert.equal(family.displayMode, 'grades')
    const subject = family.exams[0]?.subjects.find((row) => row.subject.id === maths)
    assert.deepEqual(subject?.components, [])
    assert.equal(subject?.percentage, undefined)
    assert.equal(subject?.grade, gradeFor(DEFAULT_GRADE_BANDS, 50))

    const staff = await results(owner, p1)
    assert.equal(staff.displayMode, 'marks')
    assert.equal(staff.exams[0]?.subjects.find((row) => row.subject.id === maths)?.percentage, 50)
  } finally {
    await adminPool().query('DELETE FROM exam_settings WHERE school_id = $1', [schoolA])
  }
})
