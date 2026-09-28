/**
 * Recorded leave (migration 0028).
 *
 * The office records leave ahead of time for a pupil or a staff member and
 * may cancel it; nothing is ever removed. These tests are about the records
 * themselves: who may write them, who may read which, the refusals, the
 * version and the audit row. What leave does to the register and its figures
 * is asked in modules-attendance.test.ts, which owns a year around today.
 *
 * The suite owns its own year, far ahead of every other suite's dates, with
 * one class taught by its own teacher, one class next door, a parent of one
 * pupil, and staff of its own. The one thing it borrows is the school.
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
const OWNER_EMAIL = `leave-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string
const studentB = fixtureIds.studentB as string

const suffix = randomUUID().slice(0, 8)

// A year nobody else's dates reach, so no calendar of another suite resolves
// to it. It is upcoming, never current, and never closed.
const leaveYear = randomUUID()
const YEAR_START = '2031-04-01'
const YEAR_END = '2032-03-31'
const leaveGrade = randomUUID()
const mySection = randomUUID()
const otherSection = randomUUID()

const pupilMine = randomUUID()
const pupilOther = randomUUID()
const pupilLeft = randomUUID()

let teacherStaffId = ''
let otherStaffId = ''
let retiredStaffId = ''
const staffInB = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let teacher: Client
let parent: Client
const extraUserIds: string[] = []

interface ErrorBody {
  error: { code: string; requestId: string; reason?: string }
}
interface LeaveCommon {
  id: string
  version: number
  startsOn: string
  endsOn: string
  days: number
  reason?: string
  status: 'active' | 'cancelled'
  recordedAt: string
  recordedBy?: string
  cancelledAt?: string
  allowedActions: string[]
}
interface PupilLeave extends LeaveCommon {
  student: { id: string; name: string; admissionNumber: string; rollNumber?: number }
  section?: { id: string; name: string }
  grade?: { id: string; name: string }
}
interface StaffLeave extends LeaveCommon {
  staff: { id: string; name: string; employeeCode: string }
}
interface PupilList {
  items: PupilLeave[]
  allowedActions: string[]
}
interface StaffList {
  items: StaffLeave[]
  allowedActions: string[]
}

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
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

async function leaveRows(): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM leave_records WHERE school_id = $1',
    [schoolA],
  )
  return Number(found.rows[0]?.count)
}

async function auditRows(targetId: string): Promise<
  { action: string; summary: string; safe_changes: Record<string, unknown>; note: string | null }[]
> {
  const found = await adminPool().query<{
    action: string
    summary: string
    safe_changes: Record<string, unknown>
    note: string | null
  }>(
    `SELECT e.action, e.summary, e.safe_changes, n.note FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.target_type = 'leave_record' AND e.target_id = $2
      ORDER BY e.created_at`,
    [schoolA, targetId],
  )
  return found.rows
}

const pupilPath = `/api/schools/${schoolA}/attendance/leave`
const staffPath = `/api/schools/${schoolA}/staff-attendance/leave`

async function recordPupil(client: Client, body: Record<string, unknown>): Promise<Response> {
  return client.fetch(pupilPath, post(body))
}
async function recordStaff(client: Client, body: Record<string, unknown>): Promise<Response> {
  return client.fetch(staffPath, post(body))
}
async function listPupils(client: Client, query = ''): Promise<PupilList> {
  return ok<PupilList>(await client.fetch(`${pupilPath}${query}`))
}
async function listStaff(client: Client, query = ''): Promise<StaffList> {
  return ok<StaffList>(await client.fetch(`${staffPath}${query}`))
}

/** A brand new member of school A with the roles named, signed in. */
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
  const email = `leave-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, `Leave ${input.label}`, email])
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
      `Leave guardian ${input.label}`,
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

async function insertStaff(label: string, status = 'active', schoolId = schoolA, id = randomUUID()): Promise<string> {
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher',$5,'2020-04-01')`,
    [id, schoolId, `LV-${suffix}-${label}`, `Leave ${label}`, status],
  )
  return id
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,$4,$5,'upcoming')`,
    [leaveYear, schoolA, `LV-${suffix}`, YEAR_START, YEAR_END],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,12)`, [
    leaveGrade,
    schoolA,
    `Leave ${suffix}`,
    `L${suffix.slice(0, 3)}`,
  ])
  teacherStaffId = await insertStaff('teacher')
  otherStaffId = await insertStaff('other')
  retiredStaffId = await insertStaff('retired', 'retired')
  await insertStaff('b', 'active', schoolB, staffInB)
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id) VALUES ($1,$2,$3,$4,$5,$6)`,
    [mySection, schoolA, leaveYear, leaveGrade, `LS-${suffix.slice(0, 4)}`, teacherStaffId],
  )
  await pool.query(`INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`, [
    otherSection,
    schoolA,
    leaveYear,
    leaveGrade,
    `LX-${suffix.slice(0, 4)}`,
  ])
  const pupils: [string, string, string, string][] = [
    [pupilMine, 'Mine Pupil', mySection, 'active'],
    [pupilOther, 'Other Pupil', otherSection, 'active'],
    [pupilLeft, 'Gone Pupil', mySection, 'left'],
  ]
  for (const [index, [id, name, sectionId, status]] of pupils.entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,$5)`,
      [id, schoolA, `LV/${suffix}/${index + 1}`, name, status],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), schoolA, id, leaveYear, sectionId, index + 1, YEAR_START],
    )
  }

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  teacher = await member({ roleKeys: ['teacher'], label: 'teacher', withMfa: false, staffId: teacherStaffId })
  parent = await member({ roleKeys: ['parent'], label: 'parent', withMfa: false, childId: pupilMine })
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

// ---------------------------------------------------------------------------
// Pupils.

let mineLeave: PupilLeave

test('the office records pupil leave, named with the class of its first day, in one audit row', async () => {
  const before = await leaveRows()
  mineLeave = await ok<PupilLeave>(
    await recordPupil(owner, {
      studentId: pupilMine,
      startsOn: '2031-05-05',
      endsOn: '2031-05-09',
      reason: 'A family wedding.',
    }),
    201,
  )
  assert.equal(mineLeave.student.id, pupilMine)
  assert.equal(mineLeave.student.rollNumber, 1)
  assert.equal(mineLeave.section?.id, mySection)
  assert.equal(mineLeave.grade?.id, leaveGrade)
  assert.equal(mineLeave.days, 5)
  assert.equal(mineLeave.status, 'active')
  assert.equal(mineLeave.version, 1)
  assert.equal(mineLeave.reason, 'A family wedding.')
  assert.equal(mineLeave.cancelledAt, undefined)
  assert.deepEqual(mineLeave.allowedActions, ['attendance.read', 'attendance.manage'])
  assert.equal(await leaveRows(), before + 1)

  const audits = await auditRows(mineLeave.id)
  assert.equal(audits.length, 1, 'one write is one audit row')
  assert.equal(audits[0]?.action, 'attendance.manage')
  assert.deepEqual(audits[0]?.safe_changes, {
    personKind: 'student',
    studentId: pupilMine,
    startsOn: '2031-05-05',
    endsOn: '2031-05-09',
    days: 5,
    reasonGiven: true,
  })
  assert.equal(audits[0]?.note, null, 'the reason stays on the record, not in the audit log')
})

test('a second active record may not share a day with the first', async () => {
  const before = await leaveRows()
  await failure(
    await recordPupil(owner, { studentId: pupilMine, startsOn: '2031-05-09', endsOn: '2031-05-12' }),
    400,
    'leave_overlaps',
  )
  await failure(
    await recordPupil(owner, { studentId: pupilMine, startsOn: '2031-05-01', endsOn: '2031-05-20' }),
    400,
    'leave_overlaps',
  )
  assert.equal(await leaveRows(), before)
  // The day after is free, and so is the same range for somebody else.
  await ok<PupilLeave>(
    await recordPupil(owner, { studentId: pupilMine, startsOn: '2031-05-10', endsOn: '2031-05-10' }),
    201,
  )
  await ok<PupilLeave>(
    await recordPupil(owner, { studentId: pupilOther, startsOn: '2031-05-05', endsOn: '2031-05-09' }),
    201,
  )
})

test('dates the contract refuses, a pupil who has left and ids of another school are refused', async () => {
  const before = await leaveRows()
  await failure(
    await recordPupil(owner, { studentId: pupilMine, startsOn: '2031-06-10', endsOn: '2031-06-01' }),
    400,
  )
  await failure(
    await recordPupil(owner, { studentId: pupilLeft, startsOn: '2031-06-01', endsOn: '2031-06-02' }),
    400,
    'leave_person_not_active',
  )
  // Another school's pupil, a made-up id and a section id are all records
  // that are not there.
  for (const studentId of [studentB, randomUUID(), mySection]) {
    await failure(await recordPupil(owner, { studentId, startsOn: '2031-06-01', endsOn: '2031-06-02' }), 404)
  }
  assert.equal(await leaveRows(), before)
})

test('a teacher reads the leave of their own class only, and may not record any', async () => {
  const mine = await listPupils(teacher, '?from=2031-05-01&to=2031-05-31')
  assert.ok(mine.items.length > 0)
  assert.ok(mine.items.every((item) => item.student.id === pupilMine), 'nobody from the class next door')
  assert.ok(mine.items.every((item) => item.allowedActions.join() === 'attendance.read'))
  assert.deepEqual(mine.allowedActions, ['attendance.read'])

  const refused = await recordPupil(teacher, { studentId: pupilMine, startsOn: '2031-07-01', endsOn: '2031-07-01' })
  assert.equal(refused.status, 403)
  assert.equal(((await refused.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
})

test('a parent reads their own child’s leave and nobody else’s', async () => {
  const body = await listPupils(parent, '?from=2031-05-01&to=2031-05-31')
  assert.deepEqual([...new Set(body.items.map((item) => item.student.id))], [pupilMine])
  assert.deepEqual(body.allowedActions, ['attendance.read'])
  const other = await listPupils(parent, `?personId=${pupilOther}&from=2031-05-01`)
  assert.deepEqual(other.items, [])
})

test('the office list follows the window and the person asked for', async () => {
  const all = await listPupils(owner, '?from=2031-05-01&to=2031-05-31')
  const ours = all.items.filter((item) => [pupilMine, pupilOther].includes(item.student.id as typeof pupilMine))
  assert.equal(ours.length, 3)
  assert.deepEqual(all.allowedActions, ['attendance.read', 'attendance.manage'])

  const narrow = await listPupils(owner, `?from=2031-05-10&to=2031-05-10&personId=${pupilMine}`)
  assert.deepEqual(
    narrow.items.map((item) => [item.startsOn, item.endsOn]),
    [['2031-05-10', '2031-05-10']],
  )
  // With no window, records that have not ended yet: every one of these.
  const upcoming = await listPupils(owner, `?personId=${pupilMine}`)
  assert.equal(upcoming.items.length, 2)
  await failure(await owner.fetch(`${pupilPath}?from=2031-06-01&to=2031-05-01`), 400)
})

test('cancelling keeps the record, needs the current version and happens once', async () => {
  const path = `${pupilPath}/${mineLeave.id}/cancel`
  await failure(await owner.fetch(path, post({ expectedVersion: mineLeave.version + 1 })), 409)

  const refused = await teacher.fetch(path, post({ expectedVersion: mineLeave.version }))
  assert.equal(refused.status, 403)

  const cancelled = await ok<PupilLeave>(
    await owner.fetch(path, post({ expectedVersion: mineLeave.version, reason: 'The wedding moved.' })),
  )
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.version, mineLeave.version + 1)
  assert.ok(cancelled.cancelledAt)
  assert.deepEqual(cancelled.allowedActions, ['attendance.read'], 'a cancelled record is not cancelled again')

  const audits = await auditRows(mineLeave.id)
  assert.equal(audits.length, 2, 'the record and the cancel: one audit row each')
  assert.equal(audits[1]?.summary, 'Cancelled leave for a pupil.')
  assert.equal(audits[1]?.note, 'The wedding moved.')

  await failure(await owner.fetch(path, post({ expectedVersion: cancelled.version })), 400, 'leave_already_cancelled')
  assert.equal((await auditRows(mineLeave.id)).length, 2)

  // Out of the list unless asked for, and its days are free again.
  const listed = await listPupils(owner, `?personId=${pupilMine}&from=2031-05-01&to=2031-05-09`)
  assert.equal(listed.items.length, 0)
  const withCancelled = await listPupils(
    owner,
    `?personId=${pupilMine}&from=2031-05-01&to=2031-05-09&includeCancelled=true`,
  )
  assert.deepEqual(
    withCancelled.items.map((item) => item.status),
    ['cancelled'],
  )
  await ok<PupilLeave>(
    await recordPupil(owner, { studentId: pupilMine, startsOn: '2031-05-06', endsOn: '2031-05-07' }),
    201,
  )
})

test('a leave record of another school, or no record at all, cannot be cancelled', async () => {
  const pool = adminPool()
  const inB = randomUUID()
  await pool.query(
    `INSERT INTO leave_records(id,school_id,person_kind,student_id,starts_on,ends_on,recorded_by_membership_id)
     VALUES ($1,$2,'student',$3,'2031-05-01','2031-05-02',$4)`,
    [inB, schoolB, studentB, fixtureIds.ownerB],
  )
  await failure(await owner.fetch(`${pupilPath}/${inB}/cancel`, post({ expectedVersion: 1 })), 404)
  await failure(await owner.fetch(`${pupilPath}/${randomUUID()}/cancel`, post({ expectedVersion: 1 })), 404)
  await failure(await owner.fetch(`${pupilPath}/not-an-id/cancel`, post({ expectedVersion: 1 })), 404)
  const still = await pool.query<{ cancelled_at: string | null }>('SELECT cancelled_at FROM leave_records WHERE id = $1', [
    inB,
  ])
  assert.equal(still.rows[0]?.cancelled_at, null)
})

// ---------------------------------------------------------------------------
// Staff.

test('the office records and cancels staff leave; a teacher reads only their own', async () => {
  const before = await leaveRows()
  const theirs = await ok<StaffLeave>(
    await recordStaff(owner, { staffId: otherStaffId, startsOn: '2031-08-03', endsOn: '2031-08-04' }),
    201,
  )
  assert.equal(theirs.staff.id, otherStaffId)
  assert.equal(theirs.days, 2)
  assert.deepEqual(theirs.allowedActions, ['staff_attendance.read', 'staff_attendance.manage'])
  const own = await ok<StaffLeave>(
    await recordStaff(owner, { staffId: teacherStaffId, startsOn: '2031-08-03', endsOn: '2031-08-05', reason: 'Training.' }),
    201,
  )
  assert.equal(await leaveRows(), before + 2)
  const audits = await auditRows(own.id)
  assert.equal(audits.length, 1)
  assert.equal(audits[0]?.action, 'staff_attendance.manage')
  assert.equal(audits[0]?.safe_changes?.staffId, teacherStaffId)

  await failure(
    await recordStaff(owner, { staffId: otherStaffId, startsOn: '2031-08-04', endsOn: '2031-08-06' }),
    400,
    'leave_overlaps',
  )
  await failure(
    await recordStaff(owner, { staffId: retiredStaffId, startsOn: '2031-08-04', endsOn: '2031-08-06' }),
    400,
    'leave_person_not_active',
  )
  await failure(await recordStaff(owner, { staffId: staffInB, startsOn: '2031-08-04', endsOn: '2031-08-06' }), 404)
  assert.equal(await leaveRows(), before + 2)

  const office = await listStaff(owner, '?from=2031-08-01&to=2031-08-31')
  const ids = office.items.map((item) => item.staff.id)
  assert.ok(ids.includes(otherStaffId) && ids.includes(teacherStaffId))
  assert.deepEqual(office.allowedActions, ['staff_attendance.read', 'staff_attendance.manage'])

  const mine = await listStaff(teacher, '?from=2031-08-01&to=2031-08-31')
  assert.deepEqual(
    mine.items.map((item) => item.staff.id),
    [teacherStaffId],
  )
  assert.deepEqual(mine.items[0]?.allowedActions, ['staff_attendance.read'])
  assert.deepEqual(mine.allowedActions, ['staff_attendance.read'])
  const refused = await teacher.fetch(`${staffPath}/${own.id}/cancel`, post({ expectedVersion: own.version }))
  assert.equal(refused.status, 403)

  // A parent reads no staff register at all.
  const parentRead = await parent.fetch(staffPath)
  assert.equal(parentRead.status, 403)

  const path = `${staffPath}/${theirs.id}/cancel`
  await failure(await owner.fetch(path, post({ expectedVersion: 7 })), 409)
  const cancelled = await ok<StaffLeave>(await owner.fetch(path, post({ expectedVersion: 1, reason: 'Back early.' })))
  assert.equal(cancelled.status, 'cancelled')
  await failure(await owner.fetch(path, post({ expectedVersion: 2 })), 400, 'leave_already_cancelled')
  const cancelAudits = await auditRows(theirs.id)
  assert.equal(cancelAudits.length, 2)
  assert.equal(cancelAudits[1]?.note, 'Back early.')

  // A pupil leave id is not a staff leave id, whichever way it is asked.
  await failure(await owner.fetch(`${staffPath}/${mineLeave.id}/cancel`, post({ expectedVersion: 2 })), 404)
})
