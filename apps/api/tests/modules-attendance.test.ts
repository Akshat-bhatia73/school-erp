/**
 * The attendance module (Task 20).
 *
 * Nothing about a percentage is stored, so almost every assertion here is the
 * same question asked twice: what the register holds, and what the day list,
 * the pupil's month, the section's month and the dashboard each say about it.
 * They must never disagree.
 *
 * The suite owns its own academic year, class, section, pupils and staff, so
 * no other suite's rows can move a figure. The year starts before the current
 * month and runs to the end of March, and it starts later than the fixture
 * year, so the calendar resolves every day of this suite to it. The one thing
 * it borrows is the school, and it pins its own year as the current one so
 * the dashboard card is about the register it wrote; the pin is put back.
 *
 * The register is only open on today itself, so the suite needs today to be a
 * school day with at least three earlier school days in the same month. That
 * is true on every weekday after the fourth working day of a month.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { attendancePercentage, type AttendanceMark } from '@erp/contracts'
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
const OWNER_EMAIL = `att-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string
const yearA = fixtureIds.yearA as string

const suffix = randomUUID().slice(0, 8)

// The calendar resolves a day to the year with the latest start date, and
// settles a tie on the lowest id. Another suite of this run owns a year of
// the same school, so this one takes the lowest id there is and a start date
// no earlier than any other: every day of this suite is then its own.
const attYear = '00000000-0000-4000-8000-0000000000a1'
const YEAR_START = '2026-06-01'
const YEAR_END = '2027-03-31'
const attGrade = randomUUID()
const attSection = randomUUID()
const otherSection = randomUUID()

// Three pupils on the roll of the suite's own class, and one in the class
// next door, which is the pupil a mark may never name.
const p1 = randomUUID()
const p2 = randomUUID()
const p3 = randomUUID()
const outsider = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let teacher: Client
let principal: Client
let accountant: Client
let parent: Client

let teacherStaffId = ''
let principalStaffId = ''
const extraUserIds: string[] = []
let previousCurrentYear: string | null = null

/** Today in the school's timezone, and the days around it. */
let today = ''
let sunday = ''
let holiday = ''
let past: string[] = []

interface ErrorBody {
  error: { code: string; requestId: string; reason?: string }
}
interface NamedReference {
  id: string
  name: string
}
interface CalendarDay {
  date: string
  kind: 'school_day' | 'sunday' | 'holiday' | 'outside_year'
  holidayName?: string
  future: boolean
}
interface EntryRef {
  id: string
  revision: number
  kind: 'marking' | 'correction'
  recordedAt: string
}
interface Pupil {
  id: string
  name: string
  admissionNumber: string
  rollNumber?: number
}
interface DayResponse {
  section: NamedReference
  grade: NamedReference
  academicYear: NamedReference
  date: string
  day: CalendarDay
  window: {
    record: boolean
    recordBlockedBy?: string
    correct: boolean
    correctBlockedBy?: string
  }
  marked: boolean
  rows: { student: Pupil; mark?: AttendanceMark; entry?: EntryRef }[]
  allowedActions: string[]
}
interface SectionsResponse {
  date: string
  day: CalendarDay
  academicYear: NamedReference | null
  items: {
    section: NamedReference
    grade: NamedReference
    strength: number
    marked: boolean
    counts?: { present: number; absent: number; late: number; leave: number; halfDay: number }
    lastRecordedAt?: string
    allowedActions: string[]
  }[]
}
interface Summary {
  schoolDays: number
  present: number
  absent: number
  late: number
  leave: number
  halfDay: number
  unmarked: number
  percentage: number | null
}
interface MonthDay extends CalendarDay {
  enrolled: boolean
  mark?: AttendanceMark
  corrected?: boolean
}
interface StudentMonth {
  student: Pupil
  academicYear: NamedReference
  month: string
  section?: NamedReference
  days: MonthDay[]
  summary: Summary
  allowedActions: string[]
}
interface SectionMonth {
  section: NamedReference
  month: string
  days: (CalendarDay & { marked: boolean })[]
  rows: {
    student: Pupil
    marks: { date: string; enrolled: boolean; mark?: AttendanceMark; corrected?: boolean }[]
    summary: Summary
  }[]
}
interface StaffDay {
  date: string
  day: CalendarDay
  window: { record: boolean; correct: boolean }
  marked: boolean
  rows: {
    staff: { id: string; name: string; employeeCode: string; designation?: string }
    mark?: AttendanceMark
    entry?: EntryRef
    self: boolean
  }[]
  allowedActions: string[]
}
interface StaffMemberMonth {
  staff: { id: string; name: string }
  month: string
  days: (CalendarDay & { onRegister: boolean; mark?: AttendanceMark })[]
  summary: Summary
  allowedActions: string[]
}

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}
function put(value: unknown): RequestInit {
  return { ...post(value), method: 'PUT' }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  assert.equal(response.status, status, await response.clone().text())
  return json<T>(response)
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

function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/** Every mark of one pupil and date, oldest first, straight from the table. */
async function entriesOf(studentId: string, date: string): Promise<
  { id: string; revision: number; mark: string; kind: string; supersedes_entry_id: string | null }[]
> {
  const found = await adminPool().query<{
    id: string
    revision: number
    mark: string
    kind: string
    supersedes_entry_id: string | null
  }>(
    `SELECT id, revision, mark, kind, supersedes_entry_id FROM attendance_entries
      WHERE school_id = $1 AND student_id = $2 AND date = $3::date ORDER BY revision`,
    [schoolA, studentId, date],
  )
  return found.rows
}

async function entryCount(): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM attendance_entries WHERE school_id = $1',
    [schoolA],
  )
  return Number(found.rows[0]?.count)
}

async function staffEntryCount(): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM staff_attendance_entries WHERE school_id = $1',
    [schoolA],
  )
  return Number(found.rows[0]?.count)
}

async function auditRows(action: string, targetId: string | null): Promise<
  { action: string; result: string; safe_changes: Record<string, unknown>; note: string | null }[]
> {
  const found = await adminPool().query<{
    action: string
    result: string
    safe_changes: Record<string, unknown>
    note: string | null
  }>(
    `SELECT e.action, e.result, e.safe_changes, n.note FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.action = $2
        AND (($3::uuid IS NULL AND e.target_id IS NULL) OR e.target_id = $3::uuid)
      ORDER BY e.created_at`,
    [schoolA, action, targetId],
  )
  return found.rows
}

async function readDay(client: Client, sectionId: string, date: string): Promise<DayResponse> {
  return ok<DayResponse>(
    await client.fetch(`/api/schools/${schoolA}/attendance/sections/${sectionId}/days/${date}`),
  )
}

/** The whole roll marked the same way, which is what a save must accept. */
function everyone(day: DayResponse, mark: AttendanceMark): { studentId: string; mark: AttendanceMark }[] {
  return day.rows.map((row) => ({ studentId: row.student.id, mark }))
}

async function markDay(
  client: Client,
  date: string,
  marks: { studentId: string; mark: AttendanceMark }[],
): Promise<Response> {
  return client.fetch(`/api/schools/${schoolA}/attendance/sections/${attSection}/days/${date}`, put({ marks }))
}

async function correctDay(
  client: Client,
  date: string,
  marks: { studentId: string; mark: AttendanceMark }[],
  reason = 'The office checked the register.',
): Promise<Response> {
  return client.fetch(
    `/api/schools/${schoolA}/attendance/sections/${attSection}/days/${date}/corrections`,
    post({ marks, reason }),
  )
}

async function studentMonth(client: Client, studentId: string, month: string): Promise<StudentMonth> {
  return ok<StudentMonth>(
    await client.fetch(`/api/schools/${schoolA}/attendance/students/${studentId}/months/${month}`),
  )
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
  const email = `att-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [
    userId,
    `Attendance ${input.label}`,
    email,
  ])
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
    await pool.query(
      'INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)',
      [schoolA, membershipId, input.staffId],
    )
  }
  if (input.childId !== undefined) {
    // The family link the portal grant hangs on: a guardian, a verified
    // membership link, the relation and the approved access row.
    const guardianId = randomUUID()
    await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [
      guardianId,
      schoolA,
      `Attendance guardian ${input.label}`,
    ])
    await pool.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at)
       VALUES ($1,$2,$3,now())`,
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

/** One staff record on the register, joined at the start of the year. */
async function insertStaff(label: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active',$5)`,
    [id, schoolA, `ATT-${suffix}-${label}`, `Attendance ${label}`, YEAR_START],
  )
  return id
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,$5,'current')`,
    [attYear, schoolA, `ATT-${suffix}`, YEAR_START, YEAR_END],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,11)`,
    [attGrade, schoolA, `Attendance ${suffix}`, `A${suffix.slice(0, 3)}`],
  )
  teacherStaffId = await insertStaff('teacher')
  principalStaffId = await insertStaff('head')
  // A third person on the register, so a marking body is never one row long.
  await insertStaff('other')
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [attSection, schoolA, attYear, attGrade, `AS-${suffix.slice(0, 4)}`, teacherStaffId],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [otherSection, schoolA, attYear, attGrade, `AX-${suffix.slice(0, 4)}`],
  )
  const pupils: [string, string, string][] = [
    [p1, 'First Pupil', attSection],
    [p2, 'Second Pupil', attSection],
    [p3, 'Third Pupil', attSection],
    [outsider, 'Other Class', otherSection],
  ]
  for (const [index, [id, name, sectionId]] of pupils.entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, schoolA, `ATT/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), schoolA, id, attYear, sectionId, index + 1, YEAR_START],
    )
  }

  // The dashboard card is about the school's current year, so this suite's
  // year becomes it for the length of the run.
  const pinned = await pool.query<{ current_academic_year_id: string | null }>(
    'SELECT current_academic_year_id FROM schools WHERE id = $1',
    [schoolA],
  )
  previousCurrentYear = pinned.rows[0]?.current_academic_year_id ?? null
  await pool.query(
    `UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND status = 'current' AND id <> $2`,
    [schoolA, attYear],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [schoolA, attYear])

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  teacher = await member({ roleKeys: ['teacher'], label: 'teacher', withMfa: false, staffId: teacherStaffId })
  principal = await member({
    roleKeys: ['principal'],
    label: 'head',
    withMfa: true,
    staffId: principalStaffId,
  })
  accountant = await member({ roleKeys: ['accountant'], label: 'accountant', withMfa: true })
  parent = await member({ roleKeys: ['parent'], label: 'parent', withMfa: false, childId: p1 })

  const listed = await ok<SectionsResponse>(
    await owner.fetch(`/api/schools/${schoolA}/attendance/sections`),
  )
  today = listed.date
  assert.equal(listed.day.kind, 'school_day', 'the register suite needs today to be a school day')

  // The three school days before today in the same month, and a Sunday. The
  // day furthest back becomes a holiday, so every kind of day is covered.
  const month = today.slice(0, 7)
  for (let day = shift(today, -1); day.startsWith(month); day = shift(day, -1)) {
    if (dayOfWeek(day) === 0) {
      if (sunday === '') sunday = day
      continue
    }
    if (past.length < 3) past.push(day)
    else if (holiday === '') holiday = day
  }
  assert.equal(past.length, 3, 'the suite needs three school days before today in this month')
  assert.notEqual(holiday, '', 'the suite needs a fourth working day to make a holiday of')
  assert.notEqual(sunday, '', 'the suite needs a Sunday in this month')
  await pool.query(
    `INSERT INTO holidays(school_id,academic_year_id,name,start_date,end_date,type)
     VALUES ($1,$2,$3,$4::date,$4::date,'school')`,
    [schoolA, attYear, `Founders Day ${suffix}`, holiday],
  )
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  // Put the school's current year back the way the suite found it.
  await pool.query(`UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND id = $2`, [
    schoolA,
    attYear,
  ])
  await pool.query(`UPDATE academic_years SET status = 'current' WHERE school_id = $1 AND id = $2`, [
    schoolA,
    previousCurrentYear ?? yearA,
  ])
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [
    schoolA,
    previousCurrentYear ?? yearA,
  ])
  await server.close()
  await closeAdminPool()
})

// ---------------------------------------------------------------------------
// The register.

test('the day list carries the class before it is marked, and its counts after', async () => {
  const before = await ok<SectionsResponse>(
    await teacher.fetch(`/api/schools/${schoolA}/attendance/sections?date=${today}`),
  )
  assert.equal(before.academicYear?.id, attYear)
  // A teacher sees the class they are the class teacher of, and no other.
  assert.deepEqual(
    before.items.map((item) => item.section.id),
    [attSection],
  )
  const mine = before.items[0]
  assert.equal(mine?.strength, 3)
  assert.equal(mine?.marked, false)
  assert.equal(mine?.counts, undefined, 'an unmarked day carries no counts')
  assert.ok(mine?.allowedActions.includes('attendance.record'))

  const day = await readDay(teacher, attSection, today)
  assert.equal(day.window.record, true)
  assert.equal(day.window.recordBlockedBy, undefined)
  const marks = everyone(day, 'present')
  marks[1] = { studentId: marks[1]!.studentId, mark: 'absent' }
  const saved = await ok<DayResponse>(await markDay(teacher, today, marks))
  assert.equal(saved.marked, true)
  assert.equal(saved.rows.filter((row) => row.mark === 'present').length, 2)

  const listed = await ok<SectionsResponse>(
    await teacher.fetch(`/api/schools/${schoolA}/attendance/sections?date=${today}`),
  )
  const after = listed.items.find((item) => item.section.id === attSection)
  assert.equal(after?.marked, true)
  assert.deepEqual(after?.counts, { present: 2, absent: 1, late: 0, leave: 0, halfDay: 0 })
  assert.ok(after?.lastRecordedAt, 'a marked day says when it was last saved')
})

test('marking writes revision 1 for the whole roll and exactly one audit row', async () => {
  for (const pupil of [p1, p2, p3]) {
    const rows = await entriesOf(pupil, today)
    assert.equal(rows.length, 1, 'one row per pupil')
    assert.equal(rows[0]?.revision, 1)
    assert.equal(rows[0]?.kind, 'marking')
    assert.equal(rows[0]?.supersedes_entry_id, null)
  }
  const audits = await auditRows('attendance.record', attSection)
  assert.equal(audits.length, 1, 'one save is one audit row')
  assert.equal(audits[0]?.result, 'allowed')
  assert.equal(audits[0]?.note, null, 'the register carries no note')
  assert.deepEqual(audits[0]?.safe_changes, {
    sectionId: attSection,
    academicYearId: attYear,
    date: today,
    pupils: 3,
    changed: 3,
    present: 2,
    absent: 1,
    late: 0,
    leave: 0,
    halfDay: 0,
  })
})

test('a second save the same day supersedes only what changed', async () => {
  const day = await readDay(teacher, attSection, today)
  const marks = day.rows.map((row) => ({
    studentId: row.student.id,
    // Only the first pupil's mark is different from what stands.
    mark: (row.student.id === p1 ? 'late' : row.mark) as AttendanceMark,
  }))
  const saved = await ok<DayResponse>(await markDay(teacher, today, marks))
  assert.equal(saved.rows.find((row) => row.student.id === p1)?.mark, 'late')
  assert.equal(saved.rows.find((row) => row.student.id === p1)?.entry?.revision, 2)

  const first = await entriesOf(p1, today)
  assert.deepEqual(
    first.map((row) => [row.revision, row.mark]),
    [
      [1, 'present'],
      [2, 'late'],
    ],
    'the original row is still there',
  )
  assert.equal(first[1]?.supersedes_entry_id, first[0]?.id)
  assert.equal((await entriesOf(p2, today)).length, 1, 'an unchanged pupil is not written again')
  assert.equal((await auditRows('attendance.record', attSection)).length, 2)
})

test('a body that is not exactly the roll is refused and writes nothing', async () => {
  const day = await readDay(teacher, attSection, today)
  const before = await entryCount()

  // An invented pupil, and a real pupil of the class next door.
  for (const stranger of [randomUUID(), outsider]) {
    const marks = [...everyone(day, 'present'), { studentId: stranger, mark: 'present' as AttendanceMark }]
    await failure(await markDay(teacher, today, marks), 400, 'attendance_pupil_not_on_roster')
  }
  // Somebody left out is refused too: the register is the whole roll.
  await failure(
    await markDay(teacher, today, everyone(day, 'present').slice(0, 2)),
    400,
    'attendance_roster_incomplete',
  )
  assert.equal(await entryCount(), before, 'a refused save leaves the register alone')
})

test('a Sunday, a holiday, a day outside the year and a future day are refused', async () => {
  // A future school day: tomorrow, or the day after when tomorrow is a Sunday,
  // which would be refused as a Sunday first (this test used to fail every Saturday).
  const ahead = new Date(`${shift(today, 1)}T00:00:00Z`).getUTCDay() === 0 ? shift(today, 2) : shift(today, 1)
  const day = await readDay(teacher, attSection, today)
  const roll = everyone(day, 'present')
  const before = await entryCount()

  const cases: [string, string][] = [
    [sunday, 'attendance_not_a_school_day'],
    [holiday, 'attendance_not_a_school_day'],
    ['2026-05-04', 'attendance_date_outside_year'],
    [ahead, 'attendance_date_in_future'],
  ]
  for (const [date, reason] of cases) {
    await failure(await markDay(teacher, date, roll), 400, reason)
    // The office cannot correct any of them either, for the same reason.
    if (reason !== 'attendance_date_in_future') {
      await failure(await correctDay(owner, date, [{ studentId: p1, mark: 'present' }]), 400, reason)
    }
  }
  assert.equal(await entryCount(), before, 'nothing was written')

  // The day each refusal is about says the same thing in the window.
  const onSunday = await readDay(teacher, attSection, sunday)
  assert.equal(onSunday.day.kind, 'sunday')
  assert.equal(onSunday.window.record, false)
  assert.equal(onSunday.window.recordBlockedBy, 'attendance_not_a_school_day')
  const onHoliday = await readDay(teacher, attSection, holiday)
  assert.equal(onHoliday.day.kind, 'holiday')
  assert.ok(onHoliday.day.holidayName?.startsWith('Founders Day'))
  const tomorrow = await readDay(teacher, attSection, ahead)
  assert.equal(tomorrow.day.future, true)
  assert.equal(tomorrow.window.recordBlockedBy, 'attendance_date_in_future')
})

test('yesterday is closed to the register and open to the office correction', async () => {
  const day = await readDay(teacher, attSection, past[0] as string)
  assert.equal(day.window.record, false)
  assert.equal(day.window.recordBlockedBy, 'attendance_marking_window_closed')
  assert.equal(day.window.correct, false, 'a teacher never corrects')
  assert.equal(day.window.correctBlockedBy, undefined, 'and is told nothing about why')

  await failure(
    await markDay(teacher, past[0] as string, everyone(day, 'present')),
    400,
    'attendance_marking_window_closed',
  )

  // The office marks the day that was never marked, as a correction.
  const first = await ok<DayResponse>(
    await correctDay(
      owner,
      past[0] as string,
      [
        { studentId: p1, mark: 'absent' },
        { studentId: p2, mark: 'late' },
        { studentId: p3, mark: 'leave' },
      ],
      'The class teacher was away.',
    ),
    201,
  )
  assert.equal(first.rows.find((row) => row.student.id === p1)?.mark, 'absent')
  assert.equal(first.window.correct, true)

  // And correcting it again supersedes without ever touching the first row.
  await ok<DayResponse>(
    await correctDay(owner, past[0] as string, [{ studentId: p1, mark: 'half_day' }], 'A note came in.'),
    201,
  )
  const rows = await entriesOf(p1, past[0] as string)
  assert.deepEqual(
    rows.map((row) => [row.revision, row.mark, row.kind]),
    [
      [1, 'absent', 'correction'],
      [2, 'half_day', 'correction'],
    ],
  )
  assert.equal(rows[1]?.supersedes_entry_id, rows[0]?.id)

  const audits = await auditRows('attendance.manage', attSection)
  assert.equal(audits.length, 2, 'one correction is one audit row')
  assert.equal(audits[0]?.note, 'The class teacher was away.')
  assert.deepEqual(audits[0]?.safe_changes, {
    sectionId: attSection,
    academicYearId: attYear,
    date: past[0],
    corrected: 3,
  })
  assert.equal('reason' in (audits[0]?.safe_changes ?? {}), false, 'the reason lives in the note alone')
})

test('a correction naming a pupil off the roll is refused', async () => {
  const before = await entryCount()
  await failure(
    await correctDay(owner, past[0] as string, [{ studentId: outsider, mark: 'present' }]),
    400,
    'attendance_pupil_not_on_roster',
  )
  assert.equal(await entryCount(), before)
})

// ---------------------------------------------------------------------------
// The months.

/** The counts a month's own days add up to, worked out from the response. */
function countDays(days: readonly MonthDay[]): Summary {
  const counted = days.filter((day) => day.enrolled && day.kind === 'school_day' && !day.future)
  const of = (mark: AttendanceMark) => counted.filter((day) => day.mark === mark).length
  const counts = {
    schoolDays: counted.length,
    present: of('present'),
    absent: of('absent'),
    late: of('late'),
    leave: of('leave'),
    halfDay: of('half_day'),
    unmarked: counted.filter((day) => day.mark === undefined).length,
  }
  return { ...counts, percentage: attendancePercentage(counts) }
}

test('a pupil month counts the school days and follows the percentage rule', async () => {
  // Two more marked days, so the month holds every kind of mark.
  await ok<DayResponse>(
    await correctDay(owner, past[1] as string, [
      { studentId: p1, mark: 'present' },
      { studentId: p2, mark: 'present' },
      { studentId: p3, mark: 'absent' },
    ]),
    201,
  )
  const month = today.slice(0, 7)
  const body = await studentMonth(owner, p1, month)
  assert.equal(body.month, month)
  assert.equal(body.academicYear.id, attYear)
  assert.equal(body.section?.id, attSection)

  const byDate = new Map(body.days.map((day) => [day.date, day]))
  assert.equal(byDate.get(sunday)?.kind, 'sunday')
  assert.equal(byDate.get(holiday)?.kind, 'holiday')
  assert.equal(byDate.get(today)?.mark, 'late')
  assert.equal(byDate.get(past[0] as string)?.mark, 'half_day')
  assert.equal(byDate.get(past[0] as string)?.corrected, true)
  assert.equal(byDate.get(past[2] as string)?.mark, undefined, 'a day nobody marked has no mark')

  // No day after today is counted, whatever the month holds.
  for (const day of body.days) {
    if (day.date > today) assert.equal(day.future, true)
  }
  const expected = countDays(body.days)
  assert.deepEqual(body.summary, expected)
  assert.ok(expected.unmarked > 0, 'an unmarked past school day counts against the pupil')
  assert.equal(
    body.summary.percentage,
    attendancePercentage({
      schoolDays: expected.schoolDays,
      present: expected.present,
      late: expected.late,
      halfDay: expected.halfDay,
      leave: expected.leave,
    }),
  )

  // Leave is out of the denominator: p3 was on leave for a day p1 was not.
  const third = await studentMonth(owner, p3, month)
  assert.equal(third.summary.leave, 1)
  assert.deepEqual(third.summary, countDays(third.days))
})

test('reading a pupil month writes a read audit row', async () => {
  const before = (await auditRows('attendance.read', p2)).length
  await studentMonth(owner, p2, today.slice(0, 7))
  const audits = await auditRows('attendance.read', p2)
  assert.equal(audits.length, before + 1)
  assert.equal(audits.at(-1)?.safe_changes?.month, today.slice(0, 7))
})

test('a month outside every academic year is a refused request', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/attendance/students/${p1}/months/2019-05`)
  const body = await failure(response, 400, 'attendance_month_outside_year')
  assert.equal(body.error.code, 'INVALID_REQUEST')

  // A month that is not a month at all is a path to nothing.
  const bad = await owner.fetch(`/api/schools/${schoolA}/attendance/students/${p1}/months/2026-13`)
  assert.equal(bad.status, 404)
})

test('the section month agrees with the pupil months, row by row', async () => {
  const month = today.slice(0, 7)
  const register = await ok<SectionMonth>(
    await owner.fetch(`/api/schools/${schoolA}/attendance/sections/${attSection}/months/${month}`),
  )
  assert.deepEqual(
    register.rows.map((row) => row.student.id),
    [p1, p2, p3],
    'the register is in roll order',
  )
  for (const row of register.rows) {
    const pupil = await studentMonth(owner, row.student.id, month)
    assert.deepEqual(row.summary, pupil.summary, `${row.student.name} disagrees with their own month`)
    const byDate = new Map(pupil.days.map((day) => [day.date, day]))
    for (const mark of row.marks) {
      assert.equal(mark.mark, byDate.get(mark.date)?.mark, `${row.student.name} on ${mark.date}`)
      assert.equal(mark.enrolled, byDate.get(mark.date)?.enrolled ?? false)
    }
  }
  const marked = new Set(register.days.filter((day) => day.marked).map((day) => day.date))
  assert.equal(marked.has(today), true)
  assert.equal(marked.has(past[2] as string), false, 'a day nobody marked is not marked')
})

// ---------------------------------------------------------------------------
// The staff register.

async function staffDay(client: Client, date: string): Promise<StaffDay> {
  return ok<StaffDay>(await client.fetch(`/api/schools/${schoolA}/staff-attendance/days/${date}`))
}

test('the office marks the staff register and everybody reads their own row', async () => {
  const day = await staffDay(principal, today)
  assert.equal(day.window.record, true)
  const self = day.rows.find((row) => row.self)
  assert.equal(self?.staff.id, principalStaffId, 'the caller’s own row says so')

  const body = day.rows
    .filter((row) => !row.self)
    .map((row) => ({ staffId: row.staff.id, mark: 'present' as AttendanceMark }))
  // The staff register belongs to the school, not to this suite, so the audit
  // rows are counted around the write rather than from the beginning.
  const auditsBefore = (await auditRows('staff_attendance.record', null)).length
  const marked = await ok<StaffDay>(
    await principal.fetch(`/api/schools/${schoolA}/staff-attendance/days/${today}`, put({ marks: body })),
  )
  assert.equal(marked.marked, true)
  assert.equal(marked.rows.find((row) => row.staff.id === teacherStaffId)?.mark, 'present')
  assert.equal(marked.rows.find((row) => row.self)?.mark, undefined, 'nobody marks their own row')

  const audits = await auditRows('staff_attendance.record', null)
  assert.equal(audits.length, auditsBefore + 1, 'one save is one audit row')
  const written = audits.at(-1)
  assert.equal(written?.safe_changes?.date, today)
  assert.equal(written?.safe_changes?.people, body.length)
  // Only a mark that is different is written again, so what changed is what
  // did not already stand at 'present'.
  const changed = day.rows.filter((row) => !row.self && row.mark !== 'present').length
  assert.equal(written?.safe_changes?.changed, changed)
  assert.ok(marked.rows.filter((row) => !row.self).every((row) => row.mark === 'present'))
  assert.equal(written?.note, null, 'the register carries no note')
})

test('marking your own row, or half the register, is refused', async () => {
  const day = await staffDay(principal, today)
  const before = await staffEntryCount()
  const everybody = day.rows
    .filter((row) => !row.self)
    .map((row) => ({ staffId: row.staff.id, mark: 'present' as AttendanceMark }))

  await failure(
    await principal.fetch(
      `/api/schools/${schoolA}/staff-attendance/days/${today}`,
      put({ marks: [...everybody, { staffId: principalStaffId, mark: 'present' }] }),
    ),
    400,
    'staff_attendance_own_record',
  )
  await failure(
    await principal.fetch(
      `/api/schools/${schoolA}/staff-attendance/days/${today}`,
      put({ marks: everybody.slice(0, everybody.length - 1) }),
    ),
    400,
    'staff_attendance_register_incomplete',
  )
  await failure(
    await principal.fetch(
      `/api/schools/${schoolA}/staff-attendance/days/${today}`,
      put({ marks: [...everybody, { staffId: randomUUID(), mark: 'present' }] }),
    ),
    400,
    'staff_attendance_not_on_register',
  )
  assert.equal(await staffEntryCount(), before, 'a refused save leaves the register alone')
})

test('a staff correction supersedes the mark and carries its reason as a note', async () => {
  const corrected = await ok<StaffDay>(
    await principal.fetch(
      `/api/schools/${schoolA}/staff-attendance/days/${today}/corrections`,
      post({ marks: [{ staffId: teacherStaffId, mark: 'late' }], reason: 'The bus was late.' }),
    ),
    201,
  )
  const row = corrected.rows.find((entry) => entry.staff.id === teacherStaffId)
  assert.equal(row?.mark, 'late')
  assert.equal(row?.entry?.revision, 2)
  assert.equal(row?.entry?.kind, 'correction')

  const audits = await auditRows('staff_attendance.manage', null)
  const written = audits.at(-1)
  assert.equal(written?.note, 'The bus was late.')
  assert.deepEqual(written?.safe_changes, { date: today, corrected: 1 })

  const kept = await adminPool().query<{ revision: number; mark: string }>(
    `SELECT revision, mark FROM staff_attendance_entries
      WHERE school_id = $1 AND staff_id = $2 AND date = $3::date ORDER BY revision`,
    [schoolA, teacherStaffId, today],
  )
  assert.deepEqual(
    kept.rows.map((entry) => [entry.revision, entry.mark]),
    [
      [1, 'present'],
      [2, 'late'],
    ],
  )
})

test('a staff member’s own month adds up, and the accountant may not write', async () => {
  const month = today.slice(0, 7)
  const mine = await ok<StaffMemberMonth>(
    await teacher.fetch(`/api/schools/${schoolA}/staff-attendance/staff/${teacherStaffId}/months/${month}`),
  )
  assert.equal(mine.staff.id, teacherStaffId)
  assert.equal(mine.days.find((day) => day.date === today)?.mark, 'late')
  assert.equal(mine.summary.late, 1)
  assert.deepEqual(mine.allowedActions, ['staff_attendance.read'])

  // An accountant reads the whole register and is refused every write on it.
  const register = await ok<{ rows: { staff: { id: string } }[]; allowedActions: string[] }>(
    await accountant.fetch(`/api/schools/${schoolA}/staff-attendance/months/${month}`),
  )
  assert.ok(register.rows.some((row) => row.staff.id === teacherStaffId))
  assert.deepEqual(register.allowedActions, ['staff_attendance.read'])

  const before = await staffEntryCount()
  const marking = await accountant.fetch(
    `/api/schools/${schoolA}/staff-attendance/days/${today}`,
    put({ marks: [{ staffId: teacherStaffId, mark: 'absent' }] }),
  )
  assert.equal(marking.status, 403, await marking.clone().text())
  assert.equal((await json<ErrorBody>(marking)).error.code, 'ACCESS_DENIED')
  const correcting = await accountant.fetch(
    `/api/schools/${schoolA}/staff-attendance/days/${today}/corrections`,
    post({ marks: [{ staffId: teacherStaffId, mark: 'absent' }], reason: 'no' }),
  )
  assert.equal(correcting.status, 403)
  assert.equal(await staffEntryCount(), before)
})

// ---------------------------------------------------------------------------
// The dashboards.

test('the office dashboard carries today’s register and the three day list', async () => {
  const body = await ok<{
    audience: string
    attendance?: { date: string; sectionsMarked: number; sectionsTotal: number; absent: number }
    attention: { key: string; count: number }[]
  }>(await owner.fetch(`/api/schools/${schoolA}/dashboard?date=${today}`))
  assert.equal(body.audience, 'office')
  assert.equal(body.attendance?.date, today)
  assert.ok((body.attendance?.sectionsTotal ?? 0) >= 2, 'both classes of this suite are on the list')
  assert.ok((body.attendance?.sectionsMarked ?? 0) >= 1)
  assert.ok((body.attendance?.absent ?? 0) >= 0)

  const seen = body.attention.find((item) => item.key === 'students_absent_three_days')
  assert.ok(seen, 'the attention list carries the three day item')

  // Three school days of absence in a row is what the item counts, so the
  // third day is what makes p2 appear on it.
  await correctDay(owner, past[0] as string, [{ studentId: p2, mark: 'absent' }])
  await correctDay(owner, past[1] as string, [{ studentId: p2, mark: 'absent' }])
  await correctDay(owner, past[2] as string, [{ studentId: p2, mark: 'absent' }])
  const after = await ok<{ attention: { key: string; count: number }[] }>(
    await owner.fetch(`/api/schools/${schoolA}/dashboard?date=${past[0]}`),
  )
  const count = after.attention.find((item) => item.key === 'students_absent_three_days')?.count ?? 0
  assert.ok(count >= 1, 'a pupil absent three school days running is on the list')
})

test('the teacher dashboard says whether their own class is marked', async () => {
  const body = await ok<{
    audience: string
    myClass?: { section: NamedReference; attendanceToday?: { date: string; marked: boolean; absent?: number } }
  }>(await teacher.fetch(`/api/schools/${schoolA}/dashboard?date=${today}`))
  assert.equal(body.audience, 'teacher')
  assert.equal(body.myClass?.section.id, attSection)
  assert.equal(body.myClass?.attendanceToday?.date, today)
  assert.equal(body.myClass?.attendanceToday?.marked, true)
  assert.equal(typeof body.myClass?.attendanceToday?.absent, 'number')
})

test('a parent dashboard carries their child’s attendance this month', async () => {
  const body = await ok<{
    audience: string
    children: {
      student: { id: string }
      attendance?: { month: string; percentage: number | null; present: number; schoolDays: number }
    }[]
  }>(await parent.fetch(`/api/schools/${schoolA}/dashboard?date=${today}`))
  assert.equal(body.audience, 'parent')
  const child = body.children.find((entry) => entry.student.id === p1)
  assert.ok(child, 'the parent sees their own child')
  assert.equal(child.attendance?.month, today.slice(0, 7))
  assert.ok((child.attendance?.schoolDays ?? 0) > 0)

  // The card and the month screen are the same figures.
  const month = await studentMonth(parent, p1, today.slice(0, 7))
  assert.equal(child.attendance?.percentage, month.summary.percentage)
  assert.equal(child.attendance?.present, month.summary.present)
})
