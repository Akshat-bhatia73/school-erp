/**
 * Leave applications (migration 0029).
 *
 * A parent applies for their own child and a staff member for themselves. A
 * pupil's application is decided by the class teacher of the pupil's section
 * or by the office, whoever acts first; a staff member's by the office. An
 * approval writes the leave record in the same transaction, and the applicant
 * hears the decision through the automatic messages.
 *
 * The suite builds a school of its own, with a current year around today, so
 * its pupils sit in a class of the current year (which is where a family
 * message is addressed) and no other suite's applications can move a count.
 * Section A is looked after by the class teacher and taught by the subject
 * teacher; section B is looked after by the other class teacher. The parent
 * is a guardian of pupil A, who agreed to messages.
 *
 * Nothing here sends a message through a route, so the pump runs only when a
 * test calls it.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import type { DispatchDependencies } from '../src/modules/communication/common.ts'
import { runMessagePump } from '../src/modules/communication/pump.ts'
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
const suffix = randomUUID().slice(0, 8)

const school = randomUUID()
const year = randomUUID()
const grade = randomUUID()
const sectionA = randomUUID()
const sectionB = randomUUID()
const subject = randomUUID()
const pupilA = randomUUID()
const pupilB = randomUUID()
const pupilC = randomUUID()

let server: TestServer
let deps: DispatchDependencies
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let classTeacher: Client
let subjectTeacher: Client
let otherClassTeacher: Client
let unlinkedTeacher: Client
let parent: Client
let ownerMembership = ''
let parentMembership = ''
let classTeacherMembership = ''
let classStaff = ''
let subjectStaff = ''
let today = ''

interface ErrorBody {
  error: { code: string; reason?: string }
}
interface Common {
  id: string
  version: number
  startsOn: string
  endsOn: string
  days: number
  reason: string
  status: 'pending' | 'approved' | 'refused' | 'withdrawn'
  appliedAt: string
  appliedBy?: string
  mine: boolean
  decidedAt?: string
  decidedBy?: string
  decisionNote?: string
  leaveRecordId?: string
  allowedActions: string[]
}
interface PupilApplication extends Common {
  student: { id: string; name: string }
  section?: { id: string; name: string }
}
interface StaffApplication extends Common {
  staff: { id: string; name: string }
  leaveType: 'sick' | 'casual' | 'other'
}
interface List<T> {
  items: T[]
  allowedActions: string[]
}

const path = (rest: string) => `/api/schools/${school}/leave-applications${rest}`

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return (await response.json()) as T
}

async function refused(response: Response, status: number, reason?: string): Promise<void> {
  const text = await response.text()
  assert.equal(response.status, status, text)
  if (reason !== undefined) assert.equal((JSON.parse(text) as ErrorBody).error.reason, reason, text)
}

function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

async function auditRows(targetId: string): Promise<{ action: string; result: string; safe_changes: Record<string, unknown> }[]> {
  const found = await adminPool().query<{ action: string; result: string; safe_changes: Record<string, unknown> }>(
    `SELECT action, result, safe_changes FROM audit_events
      WHERE school_id = $1 AND target_type = 'leave_application' AND target_id = $2 AND result = 'allowed'
      ORDER BY created_at`,
    [school, targetId],
  )
  return found.rows
}

async function decisionMessages(applicationId: string): Promise<
  { kind: string; audience: string; recipients: string | null; student_id: string | null; staff_id: string | null; title: string; body: string; dedupe_key: string }[]
> {
  const found = await adminPool().query<{
    kind: string
    audience: string
    recipients: string | null
    student_id: string | null
    staff_id: string | null
    title: string
    body: string
    dedupe_key: string
  }>(
    `SELECT kind, audience, recipients, student_id, staff_id, title, body, dedupe_key FROM messages
      WHERE school_id = $1 AND dedupe_key LIKE $2 ORDER BY created_at`,
    [school, `leave_decision:${applicationId}:%`],
  )
  return found.rows
}

/** The pump once, waiting for any runner that holds the school's lock to finish. */
async function pump(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const counts = await runMessagePump(deps, school, `leave-pump-${randomUUID()}`)
    if (counts.skipped === undefined) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the pump never got the school lock')
}

async function member(
  roleKeys: readonly string[],
  options: { mfa?: boolean; staffId?: string } = {},
): Promise<{ client: Client; membershipId: string }> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `leave-app-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Leave member', email])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [membershipId, school, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [school, membershipId, [...roleKeys]],
  )
  if (options.staffId)
    await pool.query('INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)', [
      school,
      membershipId,
      options.staffId,
    ])
  await setFixturePassword(server, userId, PASSWORD)
  const client = options.mfa
    ? await signInWithMfa(server, { userId, email, password: PASSWORD })
    : await signInWithPassword(server, email, PASSWORD)
  return { client, membershipId }
}

async function staffRow(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active','2020-04-01')`,
    [id, school, `LA-${suffix}-${label}`, `Teacher ${label}`],
  )
  return id
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(
    `INSERT INTO schools(id,login_code,name,short_name,timezone) VALUES ($1,$2,$3,'LAP','Asia/Kolkata')`,
    [school, `leave-${suffix}`, `Leave School ${suffix}`],
  )
  for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
    const role = await pool.query<{ id: string }>(
      `INSERT INTO roles(school_id,key,name,is_system) VALUES ($1,$2,$3,true) RETURNING id`,
      [school, key, template.displayName],
    )
    for (const grant of template.grants)
      await pool.query(
        `INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [school, role.rows[0]?.id, grant.permission, grant.scope],
      )
  }
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,current_date - 100,current_date + 200,'current')`,
    [year, school, `LA-${suffix}`],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [school, year])
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'Class 7','C7',7)`, [
    grade,
    school,
  ])
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths',$3,'scholastic')`, [
    subject,
    school,
    `LA${suffix}`,
  ])
  classStaff = await staffRow('class')
  subjectStaff = await staffRow('subject')
  const otherClassStaff = await staffRow('otherclass')
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$2,$3,$4,'A',$5),($6,$2,$3,$4,'B',$7)`,
    [sectionA, school, year, grade, classStaff, sectionB, otherClassStaff],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
    [school, subjectStaff, year, sectionA, subject],
  )
  for (const [index, [id, sectionId]] of [
    [pupilA, sectionA],
    [pupilB, sectionA],
    [pupilC, sectionB],
  ].entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,$4,'Leave','active')`,
      [id, school, `LA/${suffix}/${index}`, `Pupil${index}`],
    )
    await pool.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,current_date - 100)`,
      [school, id, year, sectionId, index + 1],
    )
  }
  const found = await pool.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today`,
  )
  today = found.rows[0]?.today ?? ''

  server = await startTestServer()
  deps = { pools: server.pools, delivery: server.delivery, documents: server.documents, config: server.config }
  const office = await member(['owner'], { mfa: true })
  owner = office.client
  ownerMembership = office.membershipId
  const ct = await member(['teacher'], { staffId: classStaff })
  classTeacher = ct.client
  classTeacherMembership = ct.membershipId
  subjectTeacher = (await member(['teacher'], { staffId: subjectStaff })).client
  otherClassTeacher = (await member(['teacher'], { staffId: otherClassStaff })).client
  unlinkedTeacher = (await member(['teacher'])).client

  // The parent: a guardian of pupil A with an account, portal access and
  // agreement to messages.
  const guardianId = randomUUID()
  await pool.query(`INSERT INTO guardians(id,school_id,first_name,last_name) VALUES ($1,$2,'Asha','Parent')`, [
    guardianId,
    school,
  ])
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation,receives_notifications)
     VALUES ($1,$2,$3,'mother',true)`,
    [school, pupilA, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_consents(school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id,recorded_at)
     VALUES ($1,$2,$3,'communication','given','signed_form',$4,now() - interval '1 day')`,
    [school, pupilA, guardianId, ownerMembership],
  )
  const family = await member(['parent'])
  parent = family.client
  parentMembership = family.membershipId
  await pool.query(
    `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at) VALUES ($1,$2,$3,now())`,
    [school, parentMembership, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_student_access(school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
     VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
    [school, guardianId, pupilA, ownerMembership],
  )

  // Automatic messages start the first time the pump runs for the school, so
  // every decision below is after that moment.
  await pump()
})

after(async () => {
  await server?.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// Applying.

let childApplication: PupilApplication
let lateApplication: PupilApplication
let pupilCApplication: PupilApplication
let classStaffApplication: StaffApplication
let subjectStaffApplication: StaffApplication

test('a parent applies for their own child in one audit row, and never for another child', async () => {
  childApplication = await ok<PupilApplication>(
    await parent.fetch(
      path('/pupils'),
      post({ studentId: pupilA, startsOn: addDays(today, 10), endsOn: addDays(today, 12), reason: 'A family wedding.' }),
    ),
    201,
  )
  assert.equal(childApplication.student.id, pupilA)
  assert.equal(childApplication.section?.id, sectionA)
  assert.equal(childApplication.status, 'pending')
  assert.equal(childApplication.days, 3)
  assert.equal(childApplication.version, 1)
  assert.equal(childApplication.mine, true)
  assert.equal(childApplication.appliedBy, 'Asha Parent')
  assert.deepEqual(
    [...childApplication.allowedActions].sort(),
    ['leave_applications.apply', 'leave_applications.read'],
    'the parent may withdraw it, never decide it',
  )
  const audits = await auditRows(childApplication.id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.action, 'leave_applications.apply')
  assert.equal(audits[0]?.safe_changes.studentId, pupilA)

  // Another child of the school, and a pupil of another class: never.
  await refused(
    await parent.fetch(path('/pupils'), post({ studentId: pupilB, startsOn: addDays(today, 10), endsOn: addDays(today, 10), reason: 'x' })),
    404,
  )
  // A class teacher reads the pupil's applications but applies for no child.
  await refused(
    await classTeacher.fetch(path('/pupils'), post({ studentId: pupilB, startsOn: addDays(today, 10), endsOn: addDays(today, 10), reason: 'x' })),
    403,
  )
})

test('an application may start at most seven days back', async () => {
  await refused(
    await parent.fetch(path('/pupils'), post({ studentId: pupilA, startsOn: addDays(today, -8), endsOn: addDays(today, -8), reason: 'Fever.' })),
    400,
    'leave_application_too_far_back',
  )
  lateApplication = await ok<PupilApplication>(
    await parent.fetch(path('/pupils'), post({ studentId: pupilA, startsOn: addDays(today, -7), endsOn: addDays(today, -6), reason: 'Fever.' })),
    201,
  )
  assert.equal(lateApplication.status, 'pending')
})

test('an application may not share a day with a waiting one or with active leave', async () => {
  await refused(
    await parent.fetch(path('/pupils'), post({ studentId: pupilA, startsOn: addDays(today, 12), endsOn: addDays(today, 14), reason: 'Again.' })),
    400,
    'leave_overlaps',
  )
  await ok(
    await owner.fetch(
      `/api/schools/${school}/attendance/leave`,
      post({ studentId: pupilA, startsOn: addDays(today, 30), endsOn: addDays(today, 31) }),
    ),
    201,
  )
  await refused(
    await parent.fetch(path('/pupils'), post({ studentId: pupilA, startsOn: addDays(today, 31), endsOn: addDays(today, 33), reason: 'Trip.' })),
    400,
    'leave_overlaps',
  )
})

test('a staff member applies for themselves; no staff record means nobody to apply for', async () => {
  classStaffApplication = await ok<StaffApplication>(
    await classTeacher.fetch(
      path('/staff'),
      post({ leaveType: 'sick', startsOn: addDays(today, 20), endsOn: addDays(today, 20), reason: 'Surgery.' }),
    ),
    201,
  )
  assert.equal(classStaffApplication.staff.id, classStaff)
  assert.equal(classStaffApplication.leaveType, 'sick')
  assert.equal(classStaffApplication.mine, true)
  assert.equal(classStaffApplication.days, 1)
  assert.deepEqual([...classStaffApplication.allowedActions].sort(), ['leave_applications.apply', 'leave_applications.read'])
  assert.equal((await auditRows(classStaffApplication.id)).length, 1)

  subjectStaffApplication = await ok<StaffApplication>(
    await subjectTeacher.fetch(
      path('/staff'),
      post({ leaveType: 'casual', startsOn: addDays(today, 21), endsOn: addDays(today, 22), reason: 'Travel.' }),
    ),
    201,
  )
  // A parent passes the gate (they may apply for their child) but has no staff record.
  await refused(
    await parent.fetch(path('/staff'), post({ leaveType: 'other', startsOn: addDays(today, 5), endsOn: addDays(today, 5), reason: 'x' })),
    400,
    'leave_application_no_staff_record',
  )
  // A teacher with no staff record holds the apply key nowhere at all.
  await refused(
    await unlinkedTeacher.fetch(path('/staff'), post({ leaveType: 'other', startsOn: addDays(today, 5), endsOn: addDays(today, 5), reason: 'x' })),
    403,
  )

  pupilCApplication = await insertPupilApplication(pupilC)
})

/**
 * A pupil C application as a family of C would make it. C has no parent
 * account in this suite, so the row is written directly, naming the office
 * member as the applicant, and read back through the office list.
 */
async function insertPupilApplication(studentId: string): Promise<PupilApplication> {
  const found = await adminPool().query<{ id: string }>(
    `INSERT INTO leave_applications(school_id,person_kind,student_id,starts_on,ends_on,reason,applied_by_membership_id)
     VALUES ($1,'student',$2,$3::date,$3::date,'Dentist.',$4) RETURNING id`,
    [school, studentId, addDays(today, 15), ownerMembership],
  )
  const list = await ok<List<PupilApplication>>(await owner.fetch(path('/pupils')))
  const item = list.items.find((entry) => entry.id === found.rows[0]?.id)
  assert.ok(item)
  return item
}

// ---------------------------------------------------------------------------
// Reading.

test('each role lists exactly the applications its scope reaches', async () => {
  const ids = <T extends Common>(list: List<T>) => list.items.map((item) => item.id).sort()

  const parentPupils = await ok<List<PupilApplication>>(await parent.fetch(path('/pupils')))
  assert.deepEqual(ids(parentPupils), [childApplication.id, lateApplication.id].sort())
  assert.ok(parentPupils.allowedActions.includes('leave_applications.apply'), 'a parent may apply for a child')
  const parentStaff = await ok<List<StaffApplication>>(await parent.fetch(path('/staff')))
  assert.deepEqual(parentStaff.items, [])
  assert.deepEqual(parentStaff.allowedActions, ['leave_applications.read'])

  const classPupils = await ok<List<PupilApplication>>(await classTeacher.fetch(path('/pupils')))
  assert.deepEqual(ids(classPupils), [childApplication.id, lateApplication.id].sort(), 'their class, not section B')
  assert.ok(classPupils.allowedActions.includes('leave_applications.decide'))
  assert.ok(!classPupils.allowedActions.includes('leave_applications.apply'), 'a teacher applies for no child')
  const waiting = classPupils.items.find((item) => item.id === childApplication.id)
  assert.equal(waiting?.mine, false)
  assert.ok(waiting?.allowedActions.includes('leave_applications.decide'))
  const classStaffList = await ok<List<StaffApplication>>(await classTeacher.fetch(path('/staff')))
  assert.deepEqual(ids(classStaffList), [classStaffApplication.id], 'their own, never a colleague’s')
  assert.ok(classStaffList.allowedActions.includes('leave_applications.apply'))
  assert.ok(!classStaffList.allowedActions.includes('leave_applications.decide'), 'a class teacher decides no staff leave')
  const own = classStaffList.items[0]
  assert.ok(own !== undefined && !own.allowedActions.includes('leave_applications.decide'))

  const subjectPupils = await ok<List<PupilApplication>>(await subjectTeacher.fetch(path('/pupils')))
  assert.deepEqual(subjectPupils.items, [], 'teaching a subject in the class is not looking after it')
  const otherPupils = await ok<List<PupilApplication>>(await otherClassTeacher.fetch(path('/pupils')))
  assert.deepEqual(ids(otherPupils), [pupilCApplication.id])

  const officePupils = await ok<List<PupilApplication>>(await owner.fetch(path('/pupils')))
  assert.deepEqual(ids(officePupils), [childApplication.id, lateApplication.id, pupilCApplication.id].sort())
  assert.equal(officePupils.items[0]?.status, 'pending')
  const officeStaff = await ok<List<StaffApplication>>(await owner.fetch(path('/staff')))
  assert.deepEqual(ids(officeStaff), [classStaffApplication.id, subjectStaffApplication.id].sort())
  assert.equal(officeStaff.items.find((item) => item.id === classStaffApplication.id)?.appliedBy, 'Teacher class')

  // The filters.
  const mine = await ok<List<StaffApplication>>(await owner.fetch(path('/staff?mine=true')))
  assert.deepEqual(mine.items, [])
  const later = await ok<List<PupilApplication>>(await owner.fetch(path(`/pupils?from=${addDays(today, 11)}`)))
  assert.deepEqual(ids(later), [childApplication.id, pupilCApplication.id].sort())
  await refused(await owner.fetch(path(`/pupils?from=${addDays(today, 5)}&to=${addDays(today, 1)}`)), 400)
})

test('the office sees the waiting applications, and the class teacher their class’s', async () => {
  const office = await ok<{ attention: { key: string; count: number }[] }>(
    await owner.fetch(`/api/schools/${school}/dashboard?date=${today}`),
  )
  assert.deepEqual(office.attention.find((item) => item.key === 'leave_applications_pending'), {
    key: 'leave_applications_pending',
    count: 5,
  })
  const teacher = await ok<{ audience: string; leaveApplicationsPending?: number }>(
    await classTeacher.fetch(`/api/schools/${school}/dashboard?date=${today}`),
  )
  assert.equal(teacher.audience, 'teacher')
  assert.equal(teacher.leaveApplicationsPending, 2)
  const subjectOnly = await ok<{ leaveApplicationsPending?: number }>(
    await subjectTeacher.fetch(`/api/schools/${school}/dashboard?date=${today}`),
  )
  assert.equal(subjectOnly.leaveApplicationsPending, undefined)
})

// ---------------------------------------------------------------------------
// Deciding.

test('a subject teacher and another class’s teacher cannot decide; a stale version conflicts', async () => {
  const body = { expectedVersion: 1, decision: 'approve' }
  await refused(await subjectTeacher.fetch(path(`/pupils/${childApplication.id}/decide`), post(body)), 403)
  await refused(await otherClassTeacher.fetch(path(`/pupils/${childApplication.id}/decide`), post(body)), 404)
  await refused(await parent.fetch(path(`/pupils/${childApplication.id}/decide`), post(body)), 403)
  await refused(
    await classTeacher.fetch(path(`/pupils/${childApplication.id}/decide`), post({ ...body, expectedVersion: 2 })),
    409,
  )
  // A pupil application is not answered on the staff routes.
  await refused(await owner.fetch(path(`/staff/${childApplication.id}/decide`), post(body)), 404)
  assert.equal((await auditRows(childApplication.id)).length, 1, 'a refusal writes no allowed row')
})

test('the class teacher approves their class: the leave record is written and linked, once', async () => {
  const approved = await ok<PupilApplication>(
    await classTeacher.fetch(path(`/pupils/${childApplication.id}/decide`), post({ expectedVersion: 1, decision: 'approve' })),
  )
  assert.equal(approved.status, 'approved')
  assert.equal(approved.version, 2)
  assert.ok(approved.leaveRecordId)
  assert.equal(approved.decidedBy, 'Teacher class')
  assert.ok(approved.decidedAt)
  assert.deepEqual(approved.allowedActions, ['leave_applications.read'])

  const record = await adminPool().query<{ recorded_by_membership_id: string; reason: string; starts_on: string }>(
    `SELECT recorded_by_membership_id, reason, to_char(starts_on,'YYYY-MM-DD') AS starts_on
       FROM leave_records WHERE school_id = $1 AND id = $2 AND cancelled_at IS NULL`,
    [school, approved.leaveRecordId],
  )
  assert.equal(record.rows[0]?.recorded_by_membership_id, classTeacherMembership)
  assert.equal(record.rows[0]?.reason, 'A family wedding.')
  assert.equal(record.rows[0]?.starts_on, addDays(today, 10))
  const leaveList = await ok<{ items: { id: string }[] }>(
    await owner.fetch(`/api/schools/${school}/attendance/leave?personId=${pupilA}`),
  )
  assert.ok(leaveList.items.some((item) => item.id === approved.leaveRecordId), 'the Leave screen lists it')

  const audits = await auditRows(childApplication.id)
  assert.equal(audits.length, 2, 'the approval is one row; the record rides on it')
  assert.equal(audits[1]?.action, 'leave_applications.decide')
  assert.equal(audits[1]?.safe_changes.leaveRecordId, approved.leaveRecordId)
  const recordAudits = await adminPool().query(
    `SELECT 1 FROM audit_events WHERE school_id = $1 AND target_type = 'leave_record' AND target_id = $2`,
    [school, approved.leaveRecordId],
  )
  assert.equal(recordAudits.rows.length, 0)

  // Deciding twice is refused, whoever tries.
  await refused(
    await owner.fetch(path(`/pupils/${childApplication.id}/decide`), post({ expectedVersion: 2, decision: 'refuse', note: 'No.' })),
    400,
    'leave_application_not_pending',
  )
})

test('a refusal needs a note, which the applicant reads', async () => {
  await refused(
    await owner.fetch(path(`/pupils/${lateApplication.id}/decide`), post({ expectedVersion: 1, decision: 'refuse' })),
    400,
  )
  const refusedOne = await ok<PupilApplication>(
    await owner.fetch(
      path(`/pupils/${lateApplication.id}/decide`),
      post({ expectedVersion: 1, decision: 'refuse', note: 'Please bring a doctor’s note.' }),
    ),
  )
  assert.equal(refusedOne.status, 'refused')
  assert.equal(refusedOne.leaveRecordId, undefined)
  const seen = (await ok<List<PupilApplication>>(await parent.fetch(path('/pupils')))).items.find(
    (item) => item.id === lateApplication.id,
  )
  assert.equal(seen?.decisionNote, 'Please bring a doctor’s note.')
  assert.equal(seen?.status, 'refused')
})

test('only the office decides staff leave; the approval shows on the staff register', async () => {
  const body = { expectedVersion: 1, decision: 'approve' }
  // Not a colleague's, and not their own either.
  await refused(await classTeacher.fetch(path(`/staff/${subjectStaffApplication.id}/decide`), post(body)), 404)
  await refused(await classTeacher.fetch(path(`/staff/${classStaffApplication.id}/decide`), post(body)), 403)
  const approved = await ok<StaffApplication>(
    await owner.fetch(path(`/staff/${classStaffApplication.id}/decide`), post({ ...body, note: 'Get well soon.' })),
  )
  assert.equal(approved.status, 'approved')
  assert.equal(approved.decisionNote, 'Get well soon.')
  const register = await ok<{ rows: { staff: { id: string }; onLeave: boolean }[] }>(
    await owner.fetch(`/api/schools/${school}/staff-attendance/days/${addDays(today, 20)}`),
  )
  assert.equal(register.rows.find((row) => row.staff.id === classStaff)?.onLeave, true)
  assert.equal(register.rows.find((row) => row.staff.id === subjectStaff)?.onLeave, false)
  assert.equal((await auditRows(classStaffApplication.id)).length, 2)
})

test('only the applicant withdraws, only while it waits', async () => {
  const waiting = await ok<PupilApplication>(
    await parent.fetch(path('/pupils'), post({ studentId: pupilA, startsOn: addDays(today, 40), endsOn: addDays(today, 40), reason: 'Exam.' })),
    201,
  )
  // The class teacher reads it but did not make it.
  await refused(await classTeacher.fetch(path(`/pupils/${waiting.id}/withdraw`), post({ expectedVersion: 1 })), 403)
  await refused(await parent.fetch(path(`/pupils/${waiting.id}/withdraw`), post({ expectedVersion: 2 })), 409)
  const withdrawn = await ok<PupilApplication>(
    await parent.fetch(path(`/pupils/${waiting.id}/withdraw`), post({ expectedVersion: 1 })),
  )
  assert.equal(withdrawn.status, 'withdrawn')
  assert.deepEqual(withdrawn.allowedActions, ['leave_applications.read'])
  const audits = await auditRows(waiting.id)
  assert.equal(audits.length, 2)
  assert.equal(audits[1]?.action, 'leave_applications.apply')
  await refused(
    await parent.fetch(path(`/pupils/${waiting.id}/withdraw`), post({ expectedVersion: 2 })),
    400,
    'leave_application_not_pending',
  )
  await refused(
    await parent.fetch(path(`/pupils/${childApplication.id}/withdraw`), post({ expectedVersion: 2 })),
    400,
    'leave_application_not_pending',
  )
  // A decided application cannot be decided after withdrawing either.
  await refused(
    await owner.fetch(path(`/pupils/${waiting.id}/decide`), post({ expectedVersion: 2, decision: 'approve' })),
    400,
    'leave_application_not_pending',
  )
  // The staff side: only the member who applied.
  await refused(
    await owner.fetch(path(`/staff/${subjectStaffApplication.id}/withdraw`), post({ expectedVersion: 1 })),
    403,
  )
})

// ---------------------------------------------------------------------------
// Telling the applicant.

test('each decision is told once, to the family or to the staff member', async () => {
  await pump()
  await pump()
  const pupilMessages = await decisionMessages(childApplication.id)
  assert.equal(pupilMessages.length, 1, 'once, however often the pump runs')
  const message = pupilMessages[0]
  assert.equal(message?.kind, 'leave_decision_pupil')
  assert.equal(message?.audience, 'pupil')
  assert.equal(message?.recipients, 'families')
  assert.equal(message?.student_id, pupilA)
  assert.equal(message?.dedupe_key, `leave_decision:${childApplication.id}:approved`)
  assert.equal(message?.title, 'Leave for Pupil0 approved')
  assert.match(message?.body ?? '', / to /)
  assert.match(message?.body ?? '', / was approved\./)

  const refusal = await decisionMessages(lateApplication.id)
  assert.equal(refusal.length, 1)
  assert.equal(refusal[0]?.title, 'Leave for Pupil0 not approved')
  assert.match(refusal[0]?.body ?? '', /doctor’s note/)

  const staffMessages = await decisionMessages(classStaffApplication.id)
  assert.equal(staffMessages.length, 1)
  assert.equal(staffMessages[0]?.kind, 'leave_decision_staff')
  assert.equal(staffMessages[0]?.audience, 'staff_member')
  assert.equal(staffMessages[0]?.recipients, null)
  assert.equal(staffMessages[0]?.staff_id, classStaff)
  assert.equal(staffMessages[0]?.title, 'Your leave application was approved')
  // A one-day leave names the one date.
  assert.ok(!(staffMessages[0]?.body ?? '').includes(' to '))

  // The family reads it in their inbox.
  const inbox = await ok<{ items: { title: string }[] }>(await parent.fetch(`/api/schools/${school}/messages/inbox`))
  assert.ok(inbox.items.some((item) => item.title === 'Leave for Pupil0 approved'))

  // A withdrawal is nobody's decision and tells nobody.
  const withdrawn = await adminPool().query<{ id: string }>(
    `SELECT id FROM leave_applications WHERE school_id = $1 AND status = 'withdrawn'`,
    [school],
  )
  for (const row of withdrawn.rows) assert.equal((await decisionMessages(row.id)).length, 0)
})

test('with the setting off, a decision tells nobody', async () => {
  await adminPool().query('UPDATE communication_settings SET leave_decisions_enabled = false WHERE school_id = $1', [
    school,
  ])
  try {
    await ok(
      await owner.fetch(path(`/staff/${subjectStaffApplication.id}/decide`), post({ expectedVersion: 1, decision: 'approve' })),
    )
    await ok(
      await otherClassTeacher.fetch(path(`/pupils/${pupilCApplication.id}/decide`), post({ expectedVersion: 1, decision: 'approve' })),
    )
    await pump()
    assert.equal((await decisionMessages(subjectStaffApplication.id)).length, 0)
    assert.equal((await decisionMessages(pupilCApplication.id)).length, 0)
  } finally {
    await adminPool().query('UPDATE communication_settings SET leave_decisions_enabled = true WHERE school_id = $1', [
      school,
    ])
  }
  const settings = await ok<{ leaveDecisionsEnabled: boolean }>(await owner.fetch(`/api/schools/${school}/messages/settings`))
  assert.equal(settings.leaveDecisionsEnabled, true)
})

test('nobody decides their own application', async () => {
  // An application the office member made themselves: the list does not
  // offer them the decision, and the route refuses it.
  const own = await insertPupilApplication(pupilC)
  assert.equal(own.mine, true)
  assert.equal(own.status, 'pending')
  assert.equal(own.allowedActions.includes('leave_applications.decide'), false)
  await refused(
    await owner.fetch(path(`/pupils/${own.id}/decide`), post({ expectedVersion: own.version, decision: 'approve' })),
    403,
  )
})
