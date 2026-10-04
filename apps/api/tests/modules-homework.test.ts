/**
 * The homework module (Task 25): the list, one item, setting, editing and
 * removing, the files, the check-off sheet and the report.
 *
 * The suite owns its own academic years, class, sections, subjects, pupils
 * and staff, so no other suite's rows can move a count. Every date is worked
 * out from the school's own today, and nothing here depends on the day of
 * the week: homework is set on any day, so the suite passes on a Sunday.
 * Items that must lie in the past (an old item whose teacher window has
 * closed, last year's item of a promoted child, the report's history) are
 * written with the migrator, because the API only ever sets an item today.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import ExcelJS from 'exceljs'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = `hw-owner-${randomUUID()}@example.test`
const SCHOOL_CODE = 'fixture-a'

const schoolA = fixtureIds.schoolA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string

const suffix = randomUUID().slice(0, 8)
const thisYear = randomUUID()
const lastYear = randomUUID()
const grade = randomUUID()
const sectionOne = randomUUID()
const sectionTwo = randomUUID()
const lastSection = randomUUID()
const maths = randomUUID()
const science = randomUUID()
const art = randomUUID()

const child = randomUUID()
const classmate = randomUUID()
const otherClass = randomUUID()
const lateJoiner = randomUUID()
const oldPupil = randomUUID()
const admission: Record<string, string> = {}

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let accountant: Client
let subjectTeacher: Client
let classTeacher: Client
let otherTeacher: Client
let parent: Client
let otherParent: Client
let lateParent: Client
let pupil: Client
const extraUserIds: string[] = []

let today = ''
let yearStart = ''
let yearEnd = ''
let lastStart = ''

/** Items written with the migrator, in the past. */
const past: Record<string, string> = {}

interface ErrorBody {
  error: { code: string; requestId: string; reason?: string }
}
interface Ref {
  id: string
  name: string
}
interface ChildStatus {
  student: Ref
  status: string
  remark?: string
  checkedAt?: string
}
interface Item {
  id: string
  version: number
  academicYear: Ref
  section: Ref
  grade: Ref
  subject?: Ref
  title: string
  setOn: string
  dueOn: string
  setBy?: string
  attachmentCount: number
  removedAt?: string
  progress?: { pupils: number; done: number; partlyDone: number; notDone: number; notChecked: number }
  child?: ChildStatus
  allowedActions: string[]
}
interface Detail extends Item {
  instructions: string
  attachments: { id: string; fileName: string; contentType: string; sizeBytes: number }[]
  updatedAt: string
  updatedBy?: string
  removedBy?: string
  checkWindow?: { state: string; teacherClosesOn: string; check: boolean; checkBlockedBy?: string }
  children?: ChildStatus[]
}
interface ListResponse {
  today: string
  items: Item[]
  truncated: boolean
  allowedActions: string[]
}
interface Sheet {
  homework: Item
  window: { state: string; teacherClosesOn: string; check: boolean; checkBlockedBy?: string }
  rows: {
    student: { id: string; name: string; admissionNumber: string; rollNumber?: number }
    check?: { id: string; version: number; status: string; remark?: string; checkedAt: string; checkedBy?: string }
  }[]
}
interface Report {
  from: string
  to: string
  threshold: number
  sets: {
    section: Ref
    subject?: Ref
    items: number
    done: number
    partlyDone: number
    notDone: number
    notChecked: number
  }[]
  repeatedNotDone: { student: { id: string }; section: Ref; notDone: number; checked: number }[]
  allowedActions: string[]
}

function send(method: string, value: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
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

const base = () => `/api/schools/${schoolA}/homework`

async function list(client: Client, query = ''): Promise<ListResponse> {
  return ok<ListResponse>(await client.fetch(`${base()}?academicYearId=${thisYear}${query}`))
}

async function listAll(client: Client, query = ''): Promise<ListResponse> {
  return ok<ListResponse>(await client.fetch(`${base()}${query === '' ? '' : `?${query}`}`))
}

async function detail(client: Client, id: string): Promise<Detail> {
  return ok<Detail>(await client.fetch(`${base()}/${id}`))
}

function create(client: Client, body: Record<string, unknown>): Promise<Response> {
  return client.fetch(base(), send('POST', body))
}

function saveChecks(client: Client, id: string, entries: unknown[]): Promise<Response> {
  return client.fetch(`${base()}/${id}/checks`, send('PUT', { entries }))
}

async function sheet(client: Client, id: string): Promise<Sheet> {
  return ok<Sheet>(await client.fetch(`${base()}/${id}/checks`))
}

async function auditRows(action: string, targetId: string): Promise<
  { summary: string; safe_changes: Record<string, unknown>; note: string | null; result: string }[]
> {
  const found = await adminPool().query<{
    summary: string
    safe_changes: Record<string, unknown>
    note: string | null
    result: string
  }>(
    `SELECT e.summary, e.safe_changes, n.note, e.result FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.action = $2 AND e.target_id = $3::uuid AND e.result = 'allowed'
      ORDER BY e.created_at`,
    [schoolA, action, targetId],
  )
  return found.rows
}

async function homeworkCount(): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM homework WHERE school_id = $1 AND academic_year_id = $2',
    [schoolA, thisYear],
  )
  return Number(found.rows[0]?.count)
}

/** An item written in the past, as if it had been set then. */
async function insertItem(input: {
  sectionId: string
  yearId: string
  subjectId: string | null
  setOn: string
  dueOn: string
  title: string
}): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO homework (id, school_id, academic_year_id, section_id, subject_id, title, set_on, due_on,
                           created_by_membership_id, updated_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [id, schoolA, input.yearId, input.sectionId, input.subjectId, input.title, input.setOn, input.dueOn, ownerMembershipId],
  )
  return id
}

async function insertCheck(itemId: string, studentId: string, status: string, remark: string | null = null): Promise<void> {
  await adminPool().query(
    `INSERT INTO homework_checks (school_id, homework_id, student_id, academic_year_id, section_id, subject_id, status,
                                  remark, checked_by_membership_id)
     SELECT school_id, id, $3, academic_year_id, section_id, subject_id, $4, $5, $6
       FROM homework WHERE school_id = $1 AND id = $2`,
    [schoolA, itemId, studentId, status, remark, ownerMembershipId],
  )
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
  const email = `hw-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, `Homework ${input.label}`, email])
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
      `Homework guardian ${input.label}`,
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

/** A pupil's own login, made as issuance makes it, signed in through the pupil's door. */
async function pupilLogin(studentId: string): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  await pool.query(`INSERT INTO auth_user(id,name,email) VALUES ($1::uuid,'Pupil',$1::text || '@student.invalid')`, [userId])
  await setFixturePassword(server, userId, PASSWORD)
  extraUserIds.push(userId)
  await pool.query(`INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'student','active')`, [
    membershipId,
    schoolA,
    userId,
  ])
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id) SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'student'`,
    [schoolA, membershipId],
  )
  await pool.query(`INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)`, [
    schoolA,
    membershipId,
    studentId,
  ])
  await resetRateLimits()
  const client = clientFor(server)
  const response = await client.fetch(
    '/api/student-sign-in',
    send('POST', { schoolCode: SCHOOL_CODE, admissionNumber: admission[studentId], password: PASSWORD }),
  )
  assert.equal(response.status, 200, await response.text())
  return client
}

async function insertStaff(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,last_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'Teacher','teaching','Teacher','active',$5)`,
    [id, schoolA, `HW-${suffix}-${label}`, `Hw${label}`, lastStart],
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
  lastStart = shift(today, -665)
  const lastEnd = shift(today, -301)

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES
       ($1,$2,$3,$4,$5,'upcoming'), ($6,$2,$7,$8,$9,'closed')`,
    [thisYear, schoolA, `HW-${suffix}`, yearStart, yearEnd, lastYear, `HW-last-${suffix}`, lastStart, lastEnd],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,13)`, [
    grade,
    schoolA,
    `Homework ${suffix}`,
    `W${suffix.slice(0, 3)}`,
  ])
  const subjectStaff = await insertStaff('subject')
  const classStaff = await insertStaff('class')
  const otherStaff = await insertStaff('other')
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES
       ($1,$2,$3,$4,$5,$6)`,
    [sectionOne, schoolA, thisYear, grade, `W1-${suffix.slice(0, 4)}`, classStaff],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5), ($6,$2,$7,$4,$8)`,
    [sectionTwo, schoolA, thisYear, grade, `W2-${suffix.slice(0, 4)}`, lastSection, lastYear, `WL-${suffix.slice(0, 4)}`],
  )
  for (const [id, name] of [
    [maths, 'Mathematics'],
    [science, 'Science'],
    [art, 'Art'],
  ] as const) {
    await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
      id,
      schoolA,
      `${name} ${suffix}`,
      `${name.slice(0, 3).toUpperCase()}-${suffix}`,
    ])
  }
  // Art is a subject of the school, not of this class.
  for (const [yearId, subjectId] of [
    [thisYear, maths],
    [thisYear, science],
    [lastYear, maths],
  ] as const) {
    await pool.query(
      `INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES ($1,$2,$3,$4)`,
      [schoolA, grade, yearId, subjectId],
    )
  }
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from) VALUES
       ($1,$2,$3,$4,$5,$6), ($1,$7,$3,$8,$9,$6)`,
    [schoolA, subjectStaff, thisYear, sectionOne, maths, yearStart, otherStaff, sectionTwo, science],
  )
  const pupils: [string, string, string, string, string | null][] = [
    // id, name, section this year, joined, last year's section
    [child, 'Asha Child', sectionOne, yearStart, lastSection],
    [classmate, 'Bina Classmate', sectionOne, yearStart, null],
    [otherClass, 'Chetan Other', sectionTwo, yearStart, null],
    [lateJoiner, 'Dev Late', sectionOne, shift(today, -5), null],
    [oldPupil, 'Esha Old', '', '', lastSection],
  ]
  for (const [index, [id, name, sectionId, joined, lastSectionId]] of pupils.entries()) {
    admission[id] = `HW/${suffix}/${index + 1}`
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, schoolA, admission[id], name],
    )
    if (lastSectionId !== null) {
      await pool.query(
        `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on,left_on,outcome)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'promoted')`,
        [randomUUID(), schoolA, id, lastYear, lastSectionId, index + 1, lastStart, lastEnd],
      )
    }
    if (sectionId !== '') {
      await pool.query(
        `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), schoolA, id, thisYear, sectionId, index + 1, joined],
      )
    }
  }

  // Last year's maths for the promoted child's old class, checked off then.
  past.lastYear = await insertItem({
    sectionId: lastSection,
    yearId: lastYear,
    subjectId: maths,
    setOn: shift(lastStart, 10),
    dueOn: shift(lastStart, 12),
    title: 'Last year fractions',
  })
  await insertCheck(past.lastYear, child, 'not_done', 'Left the book at home')
  await insertCheck(past.lastYear, oldPupil, 'done')
  // Maths in section one, due twenty days ago: the teacher's window has closed.
  past.old = await insertItem({
    sectionId: sectionOne,
    yearId: thisYear,
    subjectId: maths,
    setOn: shift(today, -30),
    dueOn: shift(today, -20),
    title: 'Old maths',
  })
  // General homework set ten days ago and due today: set before the late joiner came.
  past.beforeLate = await insertItem({
    sectionId: sectionOne,
    yearId: thisYear,
    subjectId: null,
    setOn: shift(today, -10),
    dueOn: today,
    title: 'Before the late joiner',
  })
  // Section two's science, the other teacher's.
  past.sectionTwo = await insertItem({
    sectionId: sectionTwo,
    yearId: thisYear,
    subjectId: science,
    setOn: shift(today, -3),
    dueOn: shift(today, 2),
    title: 'Section two science',
  })

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  accountant = await member({ roleKeys: ['accountant'], label: 'accountant', withMfa: true })
  subjectTeacher = await member({ roleKeys: ['teacher'], label: 'subject', withMfa: false, staffId: subjectStaff })
  classTeacher = await member({ roleKeys: ['teacher'], label: 'class', withMfa: false, staffId: classStaff })
  otherTeacher = await member({ roleKeys: ['teacher'], label: 'other', withMfa: false, staffId: otherStaff })
  parent = await member({ roleKeys: ['parent'], label: 'parent', withMfa: false, childId: child })
  otherParent = await member({ roleKeys: ['parent'], label: 'other-parent', withMfa: false, childId: otherClass })
  lateParent = await member({ roleKeys: ['parent'], label: 'late-parent', withMfa: false, childId: lateJoiner })
  pupil = await pupilLogin(classmate)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [[ownerUserId, ...extraUserIds]])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await server.close()
  await closeAdminPool()
})

/** Items set through the API by this suite. */
const items: Record<string, Item> = {}

// ---------------------------------------------------------------------------
// Setting homework.

test('the office sets homework for today, with one audit row and no words in it', async () => {
  const created = await ok<Detail>(
    await create(owner, {
      sectionId: sectionOne,
      subjectId: maths,
      title: 'Exercise 4.2',
      instructions: 'Questions 1 to 10',
      dueOn: today,
    }),
    201,
  )
  assert.equal(created.setOn, today)
  assert.equal(created.dueOn, today)
  assert.equal(created.version, 1)
  assert.equal(created.subject?.id, maths)
  assert.equal(created.instructions, 'Questions 1 to 10')
  assert.deepEqual(created.attachments, [])
  assert.ok(created.allowedActions.includes('homework.set'))
  assert.ok(created.allowedActions.includes('homework.check'))
  assert.ok(created.progress, 'staff see the figures')
  assert.equal(created.progress?.pupils, 3, 'child, classmate and the late joiner are on the roster today')
  assert.equal(created.progress?.notChecked, 3)
  assert.equal(created.checkWindow?.state, 'open')
  assert.equal(created.checkWindow?.check, true)
  items.officeMaths = created
  const audits = await auditRows('homework.set', created.id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.safe_changes.dueOn, today)
  assert.equal(audits[0]?.safe_changes.general, false)
  assert.ok(!JSON.stringify(audits[0]?.safe_changes).includes('Exercise'), 'the title is not in safe_changes')
  assert.ok(!JSON.stringify(audits[0]?.safe_changes).includes('Questions'))
})

test('the due date, the subject, the year and the section are checked', async () => {
  const before = await homeworkCount()
  await failure(
    await create(owner, { sectionId: sectionOne, subjectId: maths, title: 'Late', dueOn: shift(today, -1) }),
    400,
    'homework_due_out_of_range',
  )
  await failure(
    await create(owner, { sectionId: sectionOne, subjectId: maths, title: 'Far', dueOn: shift(today, 61) }),
    400,
    'homework_due_out_of_range',
  )
  await failure(
    await create(owner, { sectionId: sectionOne, subjectId: art, title: 'Paint', dueOn: today }),
    400,
    'homework_subject_not_in_class',
  )
  await failure(
    await create(owner, { sectionId: sectionOne, subjectId: randomUUID(), title: 'Nothing', dueOn: today }),
    400,
    'homework_subject_not_in_class',
  )
  await failure(
    await create(owner, { sectionId: lastSection, subjectId: maths, title: 'Old class', dueOn: today }),
    400,
    'homework_year_not_current',
  )
  await failure(await create(owner, { sectionId: randomUUID(), title: 'Nowhere', dueOn: today }), 400)
  await failure(await create(owner, { sectionId: sectionOne, title: '', dueOn: today }), 400)
  await failure(await create(owner, { sectionId: sectionOne, title: 'x'.repeat(121), dueOn: today }), 400)
  // Sixty days on is the last day allowed.
  const far = await ok<Detail>(
    await create(owner, { sectionId: sectionTwo, subjectId: science, title: 'Project', dueOn: shift(today, 60) }),
    201,
  )
  assert.equal(far.dueOn, shift(today, 60))
  items.officeFar = far
  assert.equal(await homeworkCount(), before + 1)
})

test('a subject teacher sets homework for their own section and subject only', async () => {
  const before = await homeworkCount()
  const created = await ok<Detail>(
    await create(subjectTeacher, { sectionId: sectionOne, subjectId: maths, title: 'Tables', dueOn: shift(today, 1) }),
    201,
  )
  assert.equal(created.setBy, 'Hwsubject Teacher')
  items.teacherMaths = created
  await failure(
    await create(subjectTeacher, { sectionId: sectionOne, subjectId: science, title: 'Not mine', dueOn: today }),
    403,
  )
  await failure(await create(subjectTeacher, { sectionId: sectionOne, title: 'General', dueOn: today }), 403)
  await failure(
    await create(subjectTeacher, { sectionId: sectionTwo, subjectId: maths, title: 'Other class', dueOn: today }),
    403,
  )
  await failure(
    await create(subjectTeacher, { sectionId: sectionOne, subjectId: art, title: 'Not the class', dueOn: today }),
    400,
    'homework_subject_not_in_class',
  )
  // The refused inserts rolled back.
  assert.equal(await homeworkCount(), before + 1)
})

test('the class teacher sets general homework for their own class, never a subject', async () => {
  const before = await homeworkCount()
  const created = await ok<Detail>(
    await create(classTeacher, { sectionId: sectionOne, subjectId: null, title: 'Bring a leaf', dueOn: today }),
    201,
  )
  assert.equal(created.subject, undefined)
  assert.ok(created.allowedActions.includes('homework.check'))
  items.general = created
  await failure(
    await create(classTeacher, { sectionId: sectionOne, subjectId: maths, title: 'Maths', dueOn: today }),
    403,
  )
  await failure(await create(classTeacher, { sectionId: sectionTwo, title: 'Other class', dueOn: today }), 403)
  await failure(await create(otherTeacher, { sectionId: sectionOne, subjectId: maths, title: 'No', dueOn: today }), 403)
  assert.equal(await homeworkCount(), before + 1)
})

test('families, pupils and the accountant set nothing', async () => {
  for (const client of [parent, pupil, accountant]) {
    await failure(await create(client, { sectionId: sectionOne, subjectId: maths, title: 'No', dueOn: today }), 403)
  }
})

// ---------------------------------------------------------------------------
// Reading.

test('staff lists are narrowed by the plan, with figures and per-item actions', async () => {
  const office = await list(owner)
  const officeIds = office.items.map((item) => item.id)
  for (const id of [items.officeMaths!.id, items.teacherMaths!.id, items.general!.id, past.old, past.beforeLate, past.sectionTwo]) {
    assert.ok(officeIds.includes(id!), `the office reads ${id}`)
  }
  assert.equal(office.today, today)
  assert.deepEqual(office.allowedActions.sort(), ['homework.check', 'homework.export', 'homework.read', 'homework.set'])
  assert.ok(office.items.every((item) => item.progress !== undefined && item.child === undefined))

  const subject = await list(subjectTeacher)
  assert.deepEqual(
    subject.items.map((item) => item.id).sort(),
    [items.officeMaths!.id, items.teacherMaths!.id, past.old].sort(),
    'maths in section one only',
  )
  assert.ok(subject.items.every((item) => item.allowedActions.includes('homework.set')))
  assert.deepEqual(subject.allowedActions.sort(), ['homework.check', 'homework.read', 'homework.set'])

  const klass = await list(classTeacher)
  assert.deepEqual(
    klass.items.map((item) => item.id).sort(),
    [items.officeMaths!.id, items.teacherMaths!.id, items.general!.id, past.old, past.beforeLate].sort(),
    'every item of the class',
  )
  const mathsForClass = klass.items.find((item) => item.id === items.teacherMaths!.id)
  assert.deepEqual(mathsForClass?.allowedActions, ['homework.read'], 'reads the subject item, never sets or checks it')
  const generalForClass = klass.items.find((item) => item.id === items.general!.id)
  assert.ok(generalForClass?.allowedActions.includes('homework.check'))

  const other = await list(otherTeacher)
  assert.deepEqual(other.items.map((item) => item.id).sort(), [items.officeFar!.id, past.sectionTwo].sort())

  // Filters.
  const general = await list(owner, '&general=true')
  assert.ok(general.items.every((item) => item.subject === undefined))
  assert.ok(general.items.some((item) => item.id === items.general!.id))
  const science2 = await list(owner, `&subjectId=${science}`)
  assert.ok(science2.items.every((item) => item.subject?.id === science))
  const sectionTwoOnly = await list(owner, `&sectionId=${sectionTwo}`)
  assert.ok(sectionTwoOnly.items.every((item) => item.section.id === sectionTwo))
  const upcoming = await list(owner, '&status=upcoming')
  assert.ok(upcoming.items.every((item) => item.dueOn >= today))
  for (let i = 1; i < upcoming.items.length; i += 1) assert.ok(upcoming.items[i - 1]!.dueOn <= upcoming.items[i]!.dueOn)
  const pastItems = await list(owner, '&status=past')
  assert.deepEqual(pastItems.items.map((item) => item.id), [past.old])
  const ranged = await list(owner, `&from=${shift(today, 1)}&to=${shift(today, 2)}`)
  assert.ok(ranged.items.every((item) => item.dueOn >= shift(today, 1) && item.dueOn <= shift(today, 2)))
  await failure(await owner.fetch(`${base()}?subjectId=${maths}&general=true`), 400)
  await failure(await owner.fetch(`${base()}?from=${today}&to=${shift(today, -1)}`), 400)
})

test('a family reads its own child’s items with the child’s status, every year, and nothing else', async () => {
  const mine = await listAll(parent)
  const ids = mine.items.map((item) => item.id)
  for (const id of [items.officeMaths!.id, items.teacherMaths!.id, items.general!.id, past.old, past.beforeLate, past.lastYear]) {
    assert.ok(ids.includes(id!), `the parent reads ${id}`)
  }
  assert.ok(!ids.includes(past.sectionTwo!), 'not another class')
  assert.ok(!ids.includes(items.officeFar!.id))
  assert.deepEqual(mine.allowedActions, ['homework.read'])
  for (const item of mine.items) {
    assert.equal(item.progress, undefined, 'no class figures for a family')
    assert.equal(item.child?.student.id, child)
    assert.deepEqual(item.allowedActions, ['homework.read'])
  }
  const lastYearItem = mine.items.find((item) => item.id === past.lastYear)
  assert.equal(lastYearItem?.child?.status, 'not_done', 'last year’s check-off of the promoted child')
  assert.equal(lastYearItem?.child?.remark, 'Left the book at home')
  const old = mine.items.find((item) => item.id === past.old)
  assert.equal(old?.child?.status, 'not_checked')
  const tomorrow = mine.items.find((item) => item.id === items.teacherMaths!.id)
  assert.equal(tomorrow?.child?.status, 'not_due')

  // The other family sees section two only.
  const theirs = await listAll(otherParent)
  assert.deepEqual(theirs.items.map((item) => item.id).sort(), [items.officeFar!.id, past.sectionTwo].sort())
  assert.ok(theirs.items.every((item) => item.child?.student.id === otherClass))

  // A pupil who joined late does not read what was set before they came.
  const late = await listAll(lateParent)
  const lateIds = late.items.map((item) => item.id)
  assert.ok(lateIds.includes(items.officeMaths!.id))
  assert.ok(!lateIds.includes(past.beforeLate!), 'set before the pupil joined')
  assert.ok(!lateIds.includes(past.old!))

  // Asking for another family's child is an empty list, not a leak.
  const asked = await listAll(parent, `studentId=${otherClass}`)
  assert.deepEqual(asked.items, [])
  const own = await listAll(parent, `studentId=${child}`)
  assert.equal(own.items.length, mine.items.length)
})

test('a pupil with a login reads their own items and their own status only', async () => {
  const mine = await listAll(pupil)
  const ids = mine.items.map((item) => item.id)
  assert.ok(ids.includes(items.officeMaths!.id))
  assert.ok(ids.includes(items.general!.id))
  assert.ok(!ids.includes(past.lastYear!), 'the classmate was not in last year’s class')
  assert.ok(!ids.includes(past.sectionTwo!))
  assert.ok(mine.items.every((item) => item.child?.student.id === classmate && item.progress === undefined))
})

test('the accountant reads no homework at all', async () => {
  await failure(await accountant.fetch(`${base()}?academicYearId=${thisYear}`), 403)
  await failure(await accountant.fetch(`${base()}/${items.officeMaths!.id}`), 403)
  await failure(await accountant.fetch(`${base()}/${items.officeMaths!.id}/checks`), 403)
  await failure(await accountant.fetch(`${base()}/report?from=${today}&to=${today}`), 403)
})

test('one item: staff see the figures and the window, a family its children, an outsider nothing', async () => {
  const staff = await detail(subjectTeacher, items.teacherMaths!.id)
  assert.equal(staff.checkWindow?.state, 'not_due')
  assert.equal(staff.checkWindow?.check, false)
  assert.equal(staff.checkWindow?.checkBlockedBy, 'homework_not_due_yet')
  assert.equal(staff.checkWindow?.teacherClosesOn, shift(today, 15))
  assert.equal(staff.children, undefined)

  // The class teacher reads the subject item but holds no check on it.
  const klass = await detail(classTeacher, items.teacherMaths!.id)
  assert.ok(klass.progress)
  assert.equal(klass.checkWindow, undefined)

  const family = await detail(parent, past.lastYear!)
  assert.equal(family.progress, undefined)
  assert.equal(family.checkWindow, undefined)
  assert.equal(family.children?.length, 1)
  assert.equal(family.children?.[0]?.student.id, child)
  assert.equal(family.children?.[0]?.status, 'not_done')
  assert.equal(family.updatedBy, undefined)

  await failure(await otherParent.fetch(`${base()}/${items.officeMaths!.id}`), 404)
  await failure(await pupil.fetch(`${base()}/${past.lastYear}`), 404)
  await failure(await lateParent.fetch(`${base()}/${past.beforeLate}`), 404)
  await failure(await otherTeacher.fetch(`${base()}/${items.officeMaths!.id}`), 404)
  await failure(await subjectTeacher.fetch(`${base()}/${items.general!.id}`), 404)
  await failure(await owner.fetch(`${base()}/${randomUUID()}`), 404)
  await failure(await owner.fetch(`${base()}/not-a-uuid`), 404)
  // A pupil's id is a face of the resource, never an item.
  await failure(await parent.fetch(`${base()}/${child}`), 404)
})

// ---------------------------------------------------------------------------
// Editing.

test('editing changes the words and the due date at the version read', async () => {
  const id = items.teacherMaths!.id
  const edited = await ok<Detail>(
    await subjectTeacher.fetch(
      `${base()}/${id}`,
      send('PATCH', { expectedVersion: 1, title: 'Tables 2 to 5', instructions: 'Write them twice', dueOn: shift(today, 2) }),
    ),
  )
  assert.equal(edited.version, 2)
  assert.equal(edited.title, 'Tables 2 to 5')
  assert.equal(edited.dueOn, shift(today, 2))
  assert.equal(edited.setOn, today, 'the day it was set never moves')
  assert.equal(edited.updatedBy, 'Hwsubject Teacher')
  items.teacherMaths = edited

  await failure(await subjectTeacher.fetch(`${base()}/${id}`, send('PATCH', { expectedVersion: 1, title: 'Stale' })), 409)
  await failure(
    await subjectTeacher.fetch(`${base()}/${id}`, send('PATCH', { expectedVersion: 2, dueOn: shift(today, -1) })),
    400,
    'homework_due_out_of_range',
  )
  await failure(
    await subjectTeacher.fetch(`${base()}/${id}`, send('PATCH', { expectedVersion: 2, dueOn: shift(today, 61) })),
    400,
    'homework_due_out_of_range',
  )
  await failure(await subjectTeacher.fetch(`${base()}/${id}`, send('PATCH', { expectedVersion: 2 })), 400)
  // Section and subject are not in the contract at all.
  await failure(
    await subjectTeacher.fetch(`${base()}/${id}`, send('PATCH', { expectedVersion: 2, sectionId: sectionTwo })),
    400,
  )
  // The class teacher reads it but may not change it; the other teacher does not see it.
  await failure(await classTeacher.fetch(`${base()}/${id}`, send('PATCH', { expectedVersion: 2, title: 'Mine' })), 403)
  await failure(await otherTeacher.fetch(`${base()}/${id}`, send('PATCH', { expectedVersion: 2, title: 'Mine' })), 404)
  await failure(await parent.fetch(`${base()}/${id}`, send('PATCH', { expectedVersion: 2, title: 'Mine' })), 403)

  // A replacement teacher carries on: the office's item is the subject teacher's to change too.
  const carried = await ok<Detail>(
    await subjectTeacher.fetch(`${base()}/${items.officeMaths!.id}`, send('PATCH', { expectedVersion: 1, title: 'Exercise 4.3' })),
  )
  assert.equal(carried.version, 2)
  items.officeMaths = carried

  const audits = await auditRows('homework.set', id)
  assert.equal(audits.length, 2, 'set, then one change')
  assert.deepEqual(audits[1]?.safe_changes.changed, ['title', 'instructions', 'dueOn'])
  assert.equal(audits[1]?.safe_changes.previousDueOn, shift(today, 1))
  assert.ok(!JSON.stringify(audits[1]?.safe_changes).includes('Tables'))
})

// ---------------------------------------------------------------------------
// Files.

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n')

function upload(client: Client, id: string, version: number, bytes: Uint8Array, type = 'application/pdf', name = 'sheet.pdf') {
  return client.fetch(`${base()}/${id}/attachments?expectedVersion=${version}&fileName=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: new Blob([Buffer.from(bytes)]),
  })
}

test('files: up to three PDF, JPEG or PNG, each a version, downloaded only after a fresh decision', async () => {
  const id = items.officeMaths!.id
  let version = items.officeMaths!.version
  const first = await ok<Detail>(await upload(subjectTeacher, id, version, PDF, 'application/pdf', '../worksheet one.pdf'))
  assert.equal(first.version, version + 1)
  assert.equal(first.attachmentCount, 1)
  assert.equal(first.attachments[0]?.fileName, 'worksheet one.pdf', 'no directory in the name')
  assert.equal(first.attachments[0]?.contentType, 'application/pdf')
  version = first.version
  const fileId = first.attachments[0]!.id

  await failure(await upload(subjectTeacher, id, version - 1, PDF), 409)
  await failure(await upload(subjectTeacher, id, version, Buffer.from('plain words, not a file')), 400, 'homework_attachment_type')
  await failure(await upload(classTeacher, id, version, PDF), 403)
  await failure(await upload(parent, id, version, PDF), 403)
  const tooBig = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20)
  tooBig.write('%PDF-', 0, 'latin1')
  const big = await upload(subjectTeacher, id, version, tooBig)
  assert.equal(big.status, 413)

  for (let i = 0; i < 2; i += 1) {
    const added = await ok<Detail>(await upload(owner, id, version, PDF, 'application/pdf', `extra-${i}.pdf`))
    version = added.version
  }
  await failure(await upload(owner, id, version, PDF), 400, 'homework_too_many_attachments')

  // Downloads: the families of the class and staff who read it.
  for (const client of [parent, pupil, classTeacher, owner]) {
    const response = await client.fetch(`${base()}/${id}/attachments/${fileId}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/pdf')
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename=/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), PDF)
  }
  for (const client of [otherParent, otherTeacher]) {
    const response = await client.fetch(`${base()}/${id}/attachments/${fileId}`)
    assert.equal(response.status, 404)
  }
  assert.equal((await accountant.fetch(`${base()}/${id}/attachments/${fileId}`)).status, 403)
  // A file is reached only under its own item.
  assert.equal((await owner.fetch(`${base()}/${items.general!.id}/attachments/${fileId}`)).status, 404)

  // Taking one off.
  await failure(await subjectTeacher.fetch(`${base()}/${id}/attachments/${fileId}?expectedVersion=${version - 1}`, { method: 'DELETE' }), 409)
  await failure(await classTeacher.fetch(`${base()}/${id}/attachments/${fileId}?expectedVersion=${version}`, { method: 'DELETE' }), 403)
  const removed = await ok<Detail>(
    await subjectTeacher.fetch(`${base()}/${id}/attachments/${fileId}?expectedVersion=${version}`, { method: 'DELETE' }),
  )
  assert.equal(removed.attachmentCount, 2)
  assert.ok(!removed.attachments.some((file) => file.id === fileId))
  assert.equal((await owner.fetch(`${base()}/${id}/attachments/${fileId}`)).status, 404)
  items.officeMaths = removed

  const audits = await auditRows('homework.set', id)
  assert.equal(audits.filter((row) => row.summary === 'Attached a file to homework.').length, 3)
  assert.equal(audits.filter((row) => row.summary === 'Removed a file from homework.').length, 1)
  const keys = JSON.stringify(audits.map((row) => row.safe_changes))
  assert.ok(!keys.includes('homework/'), 'no storage key in an audit row')
})

// ---------------------------------------------------------------------------
// Checking off.

test('the sheet opens on the due date and lists the pupils enrolled that day', async () => {
  const notYet = items.teacherMaths!
  await failure(
    await saveChecks(subjectTeacher, notYet.id, [{ studentId: child, status: 'done', expectedVersion: 0 }]),
    400,
    'homework_not_due_yet',
  )
  const before = await sheet(subjectTeacher, notYet.id)
  assert.equal(before.window.state, 'not_due')
  assert.equal(before.window.check, false)

  const due = await sheet(subjectTeacher, items.officeMaths!.id)
  assert.equal(due.window.state, 'open')
  assert.equal(due.window.check, true)
  assert.deepEqual(due.rows.map((row) => row.student.id), [child, classmate, lateJoiner], 'in roll order')
  assert.ok(due.rows.every((row) => row.check === undefined))
  assert.equal(due.rows[0]?.student.admissionNumber, admission[child])
  assert.equal(due.rows[0]?.student.rollNumber, 1)

  // A family has no sheet; the class teacher reads it without the right to check.
  await failure(await parent.fetch(`${base()}/${items.officeMaths!.id}/checks`), 403)
  await failure(await pupil.fetch(`${base()}/${items.officeMaths!.id}/checks`), 403)
  const read = await sheet(classTeacher, items.officeMaths!.id)
  assert.equal(read.window.check, false)
  assert.equal(read.window.checkBlockedBy, undefined)
  await failure(await otherTeacher.fetch(`${base()}/${items.officeMaths!.id}/checks`), 404)
})

test('a save writes the changed lines at their versions, one audit row, remarks to the note only', async () => {
  const id = items.officeMaths!.id
  const saved = await ok<Sheet>(
    await saveChecks(subjectTeacher, id, [
      { studentId: child, status: 'done', expectedVersion: 0 },
      { studentId: classmate, status: 'not_done', remark: 'Did not bring the notebook', expectedVersion: 0 },
    ]),
  )
  const byId = new Map(saved.rows.map((row) => [row.student.id, row]))
  assert.equal(byId.get(child)?.check?.status, 'done')
  assert.equal(byId.get(child)?.check?.version, 1)
  assert.equal(byId.get(classmate)?.check?.remark, 'Did not bring the notebook')
  assert.equal(byId.get(classmate)?.check?.checkedBy, 'Hwsubject Teacher')
  assert.equal(byId.get(lateJoiner)?.check, undefined)
  assert.deepEqual(saved.homework.progress, { pupils: 3, done: 1, partlyDone: 0, notDone: 1, notChecked: 1 })

  let audits = await auditRows('homework.check', id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.safe_changes.checked, 2)
  assert.equal(audits[0]?.safe_changes.changed, 0)
  assert.equal(audits[0]?.safe_changes.pupils, 3)
  assert.equal(audits[0]?.note, 'Did not bring the notebook')
  assert.ok(!JSON.stringify(audits[0]?.safe_changes).includes('notebook'))

  // A line written from a check-off that has moved refuses the whole save.
  await failure(
    await saveChecks(subjectTeacher, id, [
      { studentId: lateJoiner, status: 'done', expectedVersion: 0 },
      { studentId: child, status: 'partly_done', expectedVersion: 0 },
    ]),
    409,
  )
  assert.equal((await sheet(owner, id)).rows.find((row) => row.student.id === lateJoiner)?.check, undefined)

  await failure(
    await saveChecks(subjectTeacher, id, [{ studentId: otherClass, status: 'done', expectedVersion: 0 }]),
    400,
    'homework_pupil_not_on_roster',
  )
  await failure(
    await saveChecks(subjectTeacher, id, [{ studentId: child, status: 'done', remark: 'x'.repeat(201), expectedVersion: 1 }]),
    400,
  )
  await failure(
    await saveChecks(subjectTeacher, id, [
      { studentId: child, status: 'done', expectedVersion: 1 },
      { studentId: child, status: 'done', expectedVersion: 1 },
    ]),
    400,
  )

  // A change, and an unchanged line, in one save.
  const changed = await ok<Sheet>(
    await saveChecks(subjectTeacher, id, [
      { studentId: child, status: 'partly_done', expectedVersion: 1 },
      { studentId: classmate, status: 'not_done', expectedVersion: 1 },
      { studentId: lateJoiner, status: 'done', expectedVersion: 0 },
    ]),
  )
  const after = new Map(changed.rows.map((row) => [row.student.id, row]))
  assert.equal(after.get(child)?.check?.version, 2)
  assert.equal(after.get(classmate)?.check?.version, 1, 'an unchanged line is not rewritten')
  assert.equal(after.get(classmate)?.check?.remark, 'Did not bring the notebook', 'a left-out remark is kept')
  audits = await auditRows('homework.check', id)
  assert.equal(audits.length, 2)
  assert.equal(audits[1]?.safe_changes.changed, 1)
  assert.equal(audits[1]?.safe_changes.checked, 1)
  assert.equal(audits[1]?.note, null)

  // Clearing a remark.
  const cleared = await ok<Sheet>(
    await saveChecks(subjectTeacher, id, [{ studentId: classmate, status: 'not_done', remark: null, expectedVersion: 1 }]),
  )
  assert.equal(cleared.rows.find((row) => row.student.id === classmate)?.check?.remark, undefined)

  // A save that changes nothing writes nothing.
  await ok<Sheet>(await saveChecks(subjectTeacher, id, [{ studentId: lateJoiner, status: 'done', expectedVersion: 1 }]))
  assert.equal((await auditRows('homework.check', id)).length, 3)
})

test('families read their own child’s status and never another pupil’s', async () => {
  const id = items.officeMaths!.id
  const mine = await detail(parent, id)
  assert.deepEqual(mine.children?.map((row) => [row.student.id, row.status]), [[child, 'partly_done']])
  const own = await detail(pupil, id)
  assert.deepEqual(own.children?.map((row) => [row.student.id, row.status]), [[classmate, 'not_done']])
  const listed = await listAll(pupil)
  const item = listed.items.find((entry) => entry.id === id)
  assert.equal(item?.child?.status, 'not_done')
  assert.ok(!JSON.stringify(mine).includes(classmate))
  assert.ok(!JSON.stringify(own).includes(child))
})

test('who checks what: the class teacher general items, the subject teacher their subject, families nothing', async () => {
  await failure(
    await saveChecks(classTeacher, items.officeMaths!.id, [{ studentId: lateJoiner, status: 'done', expectedVersion: 1 }]),
    403,
  )
  await failure(
    await saveChecks(otherTeacher, items.officeMaths!.id, [{ studentId: lateJoiner, status: 'done', expectedVersion: 1 }]),
    404,
  )
  await failure(
    await saveChecks(subjectTeacher, items.general!.id, [{ studentId: child, status: 'done', expectedVersion: 0 }]),
    404,
  )
  for (const client of [parent, pupil, accountant]) {
    await failure(
      await saveChecks(client, items.general!.id, [{ studentId: child, status: 'done', expectedVersion: 0 }]),
      403,
    )
  }
  const saved = await ok<Sheet>(
    await saveChecks(classTeacher, items.general!.id, [{ studentId: child, status: 'done', expectedVersion: 0 }]),
  )
  assert.equal(saved.rows.find((row) => row.student.id === child)?.check?.status, 'done')
})

test('a teacher’s window closes fourteen days after the due date; the office’s never does', async () => {
  const id = past.old!
  const teacherView = await sheet(subjectTeacher, id)
  assert.equal(teacherView.window.state, 'closed')
  assert.equal(teacherView.window.check, false)
  assert.equal(teacherView.window.checkBlockedBy, 'homework_check_window_closed')
  assert.equal(teacherView.window.teacherClosesOn, shift(today, -6))
  await failure(
    await saveChecks(subjectTeacher, id, [{ studentId: child, status: 'done', expectedVersion: 0 }]),
    400,
    'homework_check_window_closed',
  )
  const officeView = await sheet(owner, id)
  assert.equal(officeView.window.state, 'closed')
  assert.equal(officeView.window.check, true)
  // The roster is the pupils enrolled on the due date: the late joiner came after it.
  assert.deepEqual(officeView.rows.map((row) => row.student.id), [child, classmate])
  await ok<Sheet>(
    await saveChecks(owner, id, [
      { studentId: child, status: 'done', expectedVersion: 0 },
      { studentId: classmate, status: 'not_done', expectedVersion: 0 },
    ]),
  )
  await failure(
    await saveChecks(owner, id, [{ studentId: lateJoiner, status: 'done', expectedVersion: 0 }]),
    400,
    'homework_pupil_not_on_roster',
  )
  const audits = await auditRows('homework.check', id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.safe_changes.afterTeacherWindow, true)

  // The edge: due exactly fourteen days ago is still open to the teacher.
  const edge = await insertItem({
    sectionId: sectionOne,
    yearId: thisYear,
    subjectId: maths,
    setOn: shift(today, -20),
    dueOn: shift(today, -14),
    title: 'Edge of the window',
  })
  const edgeView = await sheet(subjectTeacher, edge)
  assert.equal(edgeView.window.state, 'open')
  assert.equal(edgeView.window.check, true)
})

test('status filters: to_check for staff, upcoming and past for everyone', async () => {
  const toCheck = await list(owner, '&status=to_check')
  const ids = toCheck.items.map((item) => item.id)
  assert.ok(ids.includes(past.beforeLate!), 'due today, nobody checked')
  assert.ok(ids.includes(items.general!.id), 'one pupil checked of three')
  assert.ok(!ids.includes(past.old!), 'everyone on its roster is checked')
  assert.ok(!ids.includes(items.teacherMaths!.id), 'not due yet')
  assert.ok(toCheck.items.every((item) => (item.progress?.notChecked ?? 0) > 0))
  const familyToCheck = await listAll(parent, 'status=to_check')
  assert.deepEqual(familyToCheck.items, [], 'a family has nothing to check')
})

// ---------------------------------------------------------------------------
// Removing.

test('removing is for good: hidden from families, kept for staff, nothing changes after', async () => {
  const target = items.teacherMaths!
  await failure(await classTeacher.fetch(`${base()}/${target.id}/remove`, send('POST', { expectedVersion: target.version })), 403)
  await failure(await subjectTeacher.fetch(`${base()}/${target.id}/remove`, send('POST', { expectedVersion: 1 })), 409)
  const removed = await ok<Detail>(
    await subjectTeacher.fetch(
      `${base()}/${target.id}/remove`,
      send('POST', { expectedVersion: target.version, reason: 'Set for the wrong day' }),
    ),
  )
  assert.ok(removed.removedAt)
  assert.equal(removed.removedBy, 'Hwsubject Teacher')
  assert.deepEqual(removed.allowedActions, ['homework.read'])
  const audits = await auditRows('homework.set', target.id)
  const last = audits.at(-1)
  assert.equal(last?.summary, 'Removed homework.')
  assert.equal(last?.note, 'Set for the wrong day')
  assert.ok(!JSON.stringify(last?.safe_changes).includes('wrong day'))

  // Families no longer see it, in the list or by its id.
  assert.ok(!(await listAll(parent)).items.some((item) => item.id === target.id))
  assert.deepEqual((await listAll(parent, 'status=removed')).items, [])
  await failure(await parent.fetch(`${base()}/${target.id}`), 404)
  // Staff: not in the ordinary list, only with the removed filter.
  assert.ok(!(await list(owner)).items.some((item) => item.id === target.id))
  const removedList = await list(owner, '&status=removed')
  assert.deepEqual(removedList.items.map((item) => item.id), [target.id])
  assert.ok(removedList.items[0]?.removedAt)
  assert.ok((await list(classTeacher, '&status=removed')).items.some((item) => item.id === target.id))

  await failure(
    await subjectTeacher.fetch(`${base()}/${target.id}`, send('PATCH', { expectedVersion: removed.version, title: 'Back' })),
    400,
    'homework_removed',
  )
  await failure(
    await subjectTeacher.fetch(`${base()}/${target.id}/remove`, send('POST', { expectedVersion: removed.version })),
    400,
    'homework_removed',
  )
  await failure(await upload(subjectTeacher, target.id, removed.version, PDF), 400, 'homework_removed')
  await failure(
    await saveChecks(owner, target.id, [{ studentId: child, status: 'done', expectedVersion: 0 }]),
    400,
    'homework_removed',
  )
  const removedSheet = await sheet(owner, target.id)
  assert.equal(removedSheet.window.check, false)
  assert.equal(removedSheet.window.checkBlockedBy, 'homework_removed')
})

test('a removed item’s files are not downloaded by a family', async () => {
  const created = await ok<Detail>(
    await create(owner, { sectionId: sectionOne, subjectId: maths, title: 'With a file', dueOn: today }),
    201,
  )
  const withFile = await ok<Detail>(await upload(owner, created.id, created.version, PDF))
  const fileId = withFile.attachments[0]!.id
  assert.equal((await parent.fetch(`${base()}/${created.id}/attachments/${fileId}`)).status, 200)
  await ok<Detail>(await owner.fetch(`${base()}/${created.id}/remove`, send('POST', { expectedVersion: withFile.version })))
  assert.equal((await parent.fetch(`${base()}/${created.id}/attachments/${fileId}`)).status, 404)
  assert.equal((await owner.fetch(`${base()}/${created.id}/attachments/${fileId}`)).status, 200)
  await failure(
    await owner.fetch(`${base()}/${created.id}/attachments/${fileId}?expectedVersion=${withFile.version + 1}`, {
      method: 'DELETE',
    }),
    400,
    'homework_removed',
  )
})

// ---------------------------------------------------------------------------
// The report.

test('the report: items per section and subject, and pupils who keep not doing it, narrowed by the plan', async () => {
  // Three more maths items in the past, the classmate not doing any of them.
  const from = shift(today, -40)
  for (let i = 0; i < 3; i += 1) {
    const id = await insertItem({
      sectionId: sectionOne,
      yearId: thisYear,
      subjectId: maths,
      setOn: shift(today, -40 + i),
      dueOn: shift(today, -38 + i),
      title: `Report maths ${i}`,
    })
    await insertCheck(id, classmate, 'not_done', `Remark ${i}`)
    await insertCheck(id, child, 'done')
  }
  // A removed item never counts.
  const removedItem = await insertItem({
    sectionId: sectionOne,
    yearId: thisYear,
    subjectId: maths,
    setOn: shift(today, -40),
    dueOn: shift(today, -39),
    title: 'Removed from the report',
  })
  await insertCheck(removedItem, child, 'not_done')
  await adminPool().query(
    'UPDATE homework SET removed_at = now(), removed_by_membership_id = $3 WHERE school_id = $1 AND id = $2',
    [schoolA, removedItem, ownerMembershipId],
  )

  const query = `from=${from}&to=${shift(today, -1)}&academicYearId=${thisYear}`
  const office = await ok<Report>(await owner.fetch(`${base()}/report?${query}`))
  assert.equal(office.threshold, 3)
  assert.deepEqual(office.allowedActions, ['homework.export'])
  const mathsRow = office.sets.find((row) => row.section.id === sectionOne && row.subject?.id === maths)
  // Three report items, the old item (due twenty days ago) and the window's edge item (due fourteen days ago,
  // nobody checked: the child and the classmate; the late joiner came after it). The removed one is left out.
  assert.equal(mathsRow?.items, 5)
  assert.equal(mathsRow?.done, 4)
  assert.equal(mathsRow?.notDone, 4)
  assert.equal(mathsRow?.notChecked, 2)
  assert.deepEqual(
    office.repeatedNotDone.map((row) => [row.student.id, row.notDone, row.checked]),
    [[classmate, 4, 4]],
  )
  assert.equal(office.repeatedNotDone[0]?.section.id, sectionOne)

  // The subject teacher: the same maths figures, no export.
  const subject = await ok<Report>(await subjectTeacher.fetch(`${base()}/report?${query}`))
  assert.deepEqual(subject.allowedActions, [])
  assert.ok(subject.sets.every((row) => row.subject?.id === maths && row.section.id === sectionOne))
  assert.equal(subject.repeatedNotDone[0]?.student.id, classmate)

  // The class teacher checks general items only, so the maths figures are not theirs.
  const klass = await ok<Report>(await classTeacher.fetch(`${base()}/report?${query}`))
  assert.ok(klass.sets.every((row) => row.subject === undefined))
  assert.deepEqual(klass.repeatedNotDone, [])

  // The other teacher's scope holds none of it.
  const other = await ok<Report>(await otherTeacher.fetch(`${base()}/report?${query}`))
  assert.ok(other.sets.every((row) => row.section.id === sectionTwo))
  assert.deepEqual(other.repeatedNotDone, [])

  // Not done counts from the threshold only.
  const narrow = await ok<Report>(await owner.fetch(`${base()}/report?from=${shift(today, -38)}&to=${shift(today, -37)}`))
  assert.deepEqual(narrow.repeatedNotDone, [])

  await failure(await parent.fetch(`${base()}/report?${query}`), 403)
  await failure(await pupil.fetch(`${base()}/report?${query}`), 403)
  await failure(await owner.fetch(`${base()}/report?from=${today}&to=${shift(today, -1)}`), 400)
  await failure(await owner.fetch(`${base()}/report?from=${shift(today, -400)}&to=${today}`), 400)
})

test('a refused write is recorded as a denial and changes nothing', async () => {
  const before = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events WHERE school_id = $1 AND action = 'homework.set' AND result = 'denied'`,
    [schoolA],
  )
  await failure(await create(classTeacher, { sectionId: sectionOne, subjectId: maths, title: 'No', dueOn: today }), 403)
  const after = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events WHERE school_id = $1 AND action = 'homework.set' AND result = 'denied'`,
    [schoolA],
  )
  assert.equal(Number(after.rows[0]?.count), Number(before.rows[0]?.count) + 1)
})

/** A one-pixel PNG with a text chunk, as a phone might write it. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, data, Buffer.alloc(4)])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0Taken at home', 'latin1')),
    chunk('IDAT', deflateSync(Buffer.from([0x00, 0x00]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('a picture is typed by its bytes, not its claim, and stored without its description', async () => {
  const created = await ok<Detail>(
    await create(classTeacher, { sectionId: sectionOne, title: 'Draw a leaf', dueOn: shift(today, 1) }),
    201,
  )
  // Sent as a PDF, it is a PNG.
  const added = await ok<Detail>(await upload(classTeacher, created.id, created.version, png(), 'application/pdf', 'leaf.png'))
  assert.equal(added.attachments[0]?.contentType, 'image/png')
  const response = await parent.fetch(`${base()}/${created.id}/attachments/${added.attachments[0]!.id}`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.ok(!bytes.toString('latin1').includes('Taken at home'), 'the text chunk is gone')
  // A type the parser does not take is refused before the handler.
  const plain = await classTeacher.fetch(
    `${base()}/${created.id}/attachments?expectedVersion=${added.version}&fileName=a.txt`,
    { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'words' },
  )
  assert.ok(plain.status === 415 || plain.status === 400, String(plain.status))
})

// ---------------------------------------------------------------------------
// The dashboard cards (Task 25). Asked for a day 100 days ahead, which no other
// test here reaches, so nothing above moves a count.

interface DueCard {
  today: { homeworkId: string; subject?: Ref; title: string; dueOn: string; status: string }[]
  tomorrow: { homeworkId: string; subject?: Ref; title: string; dueOn: string; status: string }[]
}
interface ToCheckItem {
  homeworkId: string
  section: Ref
  subject?: Ref
  title: string
  dueOn: string
  pupils: number
  notChecked: number
}

async function home(client: Client, date: string): Promise<Record<string, unknown>> {
  return ok<Record<string, unknown>>(await client.fetch(`/api/schools/${schoolA}/dashboard?date=${date}`))
}

function dueOf(body: Record<string, unknown>, studentId: string): DueCard | undefined {
  const children = (body.children ?? []) as { student: Ref; homeworkDue?: DueCard }[]
  return children.find((entry) => entry.student.id === studentId)?.homeworkDue
}

test('the dashboard: homework due for a family and a pupil, to check for a teacher, through the plans', async () => {
  const probe = shift(today, 100)
  const card = (input: { sectionId?: string; subjectId?: string | null; set: number; due: number; title: string }) =>
    insertItem({
      sectionId: input.sectionId ?? sectionOne,
      yearId: thisYear,
      subjectId: input.subjectId ?? null,
      setOn: shift(probe, input.set),
      dueOn: shift(probe, input.due),
      title: input.title,
    })
  const dueToday = await card({ set: -2, due: 0, title: 'Card due today' })
  const dueTomorrow = await card({ subjectId: maths, set: -2, due: 1, title: 'Card due tomorrow' })
  await card({ set: -2, due: 2, title: 'Card later' })
  const removed = await card({ set: -2, due: 0, title: 'Card removed' })
  await adminPool().query(
    `UPDATE homework SET removed_at = now(), removed_by_membership_id = $3 WHERE school_id = $1 AND id = $2`,
    [schoolA, removed, ownerMembershipId],
  )
  const otherSection = await card({ sectionId: sectionTwo, subjectId: science, set: -2, due: 0, title: 'Card section two' })
  const checkGeneral = await card({ set: -6, due: -3, title: 'Card check general' })
  const checkMaths = await card({ subjectId: maths, set: -6, due: -3, title: 'Card check maths' })
  await card({ set: -25, due: -20, title: 'Card too old for a teacher' })
  const allChecked = await card({ set: -6, due: -4, title: 'Card all checked' })
  await insertCheck(dueToday, child, 'done')
  await insertCheck(checkGeneral, child, 'done')
  for (const pupilId of [child, classmate, lateJoiner]) await insertCheck(allChecked, pupilId, 'partly_done')

  // A parent: their own child's items due that day and the next, with the child's own status.
  const family = await home(parent, probe)
  assert.equal(family.audience, 'parent')
  assert.deepEqual(dueOf(family, child), {
    today: [{ homeworkId: dueToday, title: 'Card due today', dueOn: probe, status: 'done' }],
    tomorrow: [
      { homeworkId: dueTomorrow, subject: { id: maths, name: `Mathematics ${suffix}` }, title: 'Card due tomorrow', dueOn: shift(probe, 1), status: 'not_due' },
    ],
  })
  // Another family sees their own child's class, and nothing of this one.
  const other = await home(otherParent, probe)
  assert.deepEqual(dueOf(other, otherClass)?.today.map((row) => row.homeworkId), [otherSection])
  assert.deepEqual(dueOf(other, otherClass)?.tomorrow, [])
  assert.equal(dueOf(other, child), undefined)

  // A pupil with a login: their own card, and the classmate's check-off is not theirs.
  const own = await home(pupil, probe)
  assert.equal(own.audience, 'student')
  const me = own.me as { student: Ref; homeworkDue?: DueCard }
  assert.equal(me.student.id, classmate)
  assert.deepEqual(me.homeworkDue?.today.map((row) => [row.homeworkId, row.status]), [[dueToday, 'not_checked']])
  assert.deepEqual(me.homeworkDue?.tomorrow.map((row) => row.homeworkId), [dueTomorrow])

  // Teachers: only what each may check, due by that day, inside their window, with pupils not checked.
  const classCard = (await home(classTeacher, probe)).homeworkToCheck as ToCheckItem[] | undefined
  assert.deepEqual(
    classCard?.map((row) => [row.homeworkId, row.pupils, row.notChecked]),
    [
      [checkGeneral, 3, 2],
      [dueToday, 3, 2],
    ],
  )
  const subjectCard = (await home(subjectTeacher, probe)).homeworkToCheck as ToCheckItem[] | undefined
  assert.deepEqual(subjectCard?.map((row) => [row.homeworkId, row.notChecked]), [[checkMaths, 3]])
  assert.equal(subjectCard?.[0]?.subject?.id, maths)
  const otherCard = (await home(otherTeacher, probe)).homeworkToCheck as ToCheckItem[] | undefined
  assert.deepEqual(otherCard?.map((row) => row.homeworkId), [otherSection])
  // The day after the window closes on the general item, it leaves the card.
  const closed = (await home(classTeacher, shift(probe, 12))).homeworkToCheck as ToCheckItem[] | undefined
  assert.ok(!closed?.some((row) => row.homeworkId === checkGeneral))
  // A family's home has no teacher card, and a parent's card never carries a removed item.
  assert.equal(family.homeworkToCheck, undefined)
  assert.ok(!JSON.stringify(family).includes(removed))
})

test('the dashboard leaves the homework cards out for a member who holds no homework key', async () => {
  const body = await home(accountant, shift(today, 100))
  assert.equal(body.audience, 'accountant')
  assert.ok(!JSON.stringify(body).includes('homework'))
})

// ---------------------------------------------------------------------------
// The report as a spreadsheet (homework_report).

test('the report exports as a spreadsheet for the office only, read again under the requester’s plan', async () => {
  const body = { from: shift(today, -40), to: shift(today, -1), academicYearId: thisYear }
  const path = `${base()}/report/export`
  // Teachers see the report for their scope but hold no export key; families nothing.
  for (const client of [subjectTeacher, classTeacher, parent, pupil, accountant])
    await failure(await client.fetch(path, send('POST', body)), 403)
  await failure(await owner.fetch(path, send('POST', { ...body, to: shift(today, -50) })), 400)

  const job = await ok<{ id: string; status: string; fileName?: string; format?: string }>(
    await owner.fetch(path, send('POST', body)),
    202,
  )
  assert.equal(job.status, 'ready')
  assert.equal(job.format, 'xlsx')
  assert.match(job.fileName ?? '', /^homework-report-.*\.xlsx$/)
  const audits = await auditRows('homework.export', job.id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.safe_changes.from, body.from)

  const download = await owner.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(download.status, 200, await download.clone().text())
  // Somebody else's file is not theirs to download.
  assert.notEqual((await subjectTeacher.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)).status, 200)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await download.arrayBuffer()) as unknown as ArrayBuffer)
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Homework set', 'Not done 3 or more'])
  const values = (sheet: ExcelJS.Worksheet) =>
    sheet.getSheetValues().slice(1).map((row) => (Array.isArray(row) ? row.slice(1) : []))
  const [setHeader, ...setRows] = values(workbook.worksheets[0]!)
  assert.deepEqual(setHeader?.slice(0, 8), ['Class', 'Section', 'Subject', 'Items', 'Done', 'Partly done', 'Not done', 'Not checked'])
  const mathsRow = setRows.find((row) => row[2] === `Mathematics ${suffix}`)
  assert.deepEqual(mathsRow?.slice(3, 8), [5, 4, 0, 4, 2])
  const [, ...pupilRows] = values(workbook.worksheets[1]!)
  assert.deepEqual(
    pupilRows.map((row) => [row[3], row[5], row[6]]),
    [[admission[classmate], 4, 4]],
  )
})
