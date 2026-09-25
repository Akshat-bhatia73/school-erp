/**
 * The dashboard route, one audience at a time.
 *
 * Every figure on a dashboard comes from a query the caller's own read plan
 * already allows, so this suite seeds the exact rows it asks about: one class,
 * one bell schedule, one teacher with one period, one cover duty, one child.
 * The attention counts are measured as a difference across one seeded problem,
 * because the test database is shared with the other module suites and an
 * absolute count would only be true on a freshly made copy.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import { CONSENT_PURPOSES, DashboardResponse, type DashboardAttentionKey } from '@erp/contracts'
import { audienceFor, audiencesFor, resolveAudience } from '../src/modules/dashboard/audience.ts'
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
// Unique per run: other module suites rewrite the same fixture identities.
const OWNER_EMAIL = `dash-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `dash-teacher-${randomUUID()}@example.test`
const PARENT_EMAIL = `dash-parent-${randomUUID()}@example.test`
const SUSPENDED_EMAIL = `dash-suspended-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string
const teacherUserId = fixtureIds.adultUser as string
const parentUserId = fixtureIds.parentA2User as string
const parentMembershipId = fixtureIds.parentA2 as string
const suspendedUserId = fixtureIds.suspendedUser as string
const studentA = fixtureIds.studentA as string
const studentA2 = fixtureIds.studentA2 as string
const studentB = fixtureIds.studentB as string
const guardianA2 = fixtureIds.guardianA2 as string
const staffA = fixtureIds.staffA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const sectionA = fixtureIds.sectionA as string

/**
 * The dates this suite asks about. December is far from the day the other
 * suites admit and leave students on, so the month figures stay this suite's
 * own. 10 December 2026 is a Thursday, 14 December a Monday, 6 December a
 * Sunday, and 7 and 8 December are the seeded holiday.
 */
const PROBE = '2026-12-10'
const MONDAY = '2026-12-14'
const SUNDAY = '2026-12-06'
const HOLIDAY_START = '2026-12-07'
const HOLIDAY_END = '2026-12-08'
const HOLIDAY_NAME = 'Founder week'

// Rows this suite owns, so assertions are exact instead of fixture-wide.
const subjectId = randomUUID()
const otherSectionId = randomUUID()
const freshStudentId = randomUUID()
const leftStudentId = randomUUID()
const holidayId = randomUUID()
const bellScheduleId = randomUUID()
const otherStaffId = randomUUID()
const secondStaffId = randomUUID()
const suffix = randomUUID().slice(0, 8)
// The exam blocks: one periodic test of the current year, open on the probe day.
const dashExam = randomUUID()
const dashPaperOwn = randomUUID()
const dashPaperOther = randomUUID()
const dashCard = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let principal: Client
let admin: Client
let accountant: Client
let teacher: Client
let secondTeacher: Client
let unlinkedTeacher: Client
let parent: Client
/** A teacher who is also a parent of the fixture pupil, and an accountant who is too. */
let teacherParent: Client
let accountantParent: Client
const dualGuardianIds: string[] = []

interface ErrorBody {
  error: { code: string; requestId: string }
}

async function dashboard(
  client: Client,
  schoolId: string,
  date?: string,
  audience?: string,
): Promise<Response> {
  const search = new URLSearchParams()
  if (date !== undefined) search.set('date', date)
  if (audience !== undefined) search.set('audience', audience)
  const query = search.size === 0 ? '' : `?${search.toString()}`
  return client.fetch(`/api/schools/${schoolId}/dashboard${query}`)
}

async function read(client: Client, date?: string, audience?: string): Promise<DashboardResponse> {
  const response = await dashboard(client, schoolA, date, audience)
  assert.equal(response.status, 200, await response.clone().text())
  return DashboardResponse.parse(await response.json())
}

/** The purposes one guardian's newest consent row for one pupil says "given" to. */
async function ownGiven(guardianId: string, studentId: string): Promise<Set<string>> {
  const newest = await adminPool().query<{ purpose: string }>(
    `SELECT purpose FROM (
       SELECT DISTINCT ON (purpose) purpose, status FROM guardian_consents
        WHERE school_id = $1 AND student_id = $2 AND guardian_id = $3
        ORDER BY purpose, recorded_at DESC, id DESC) newest
      WHERE status = 'given'`,
    [schoolA, studentId, guardianId],
  )
  return new Set(newest.rows.map((row) => row.purpose))
}

/** Link a membership to a pupil the way the portal does: guardian, family link, approved access. */
async function linkChild(membershipId: string, studentId: string): Promise<void> {
  const pool = adminPool()
  const guardianId = randomUUID()
  dualGuardianIds.push(guardianId)
  await pool.query(
    `INSERT INTO guardians (id, school_id, first_name, phone) VALUES ($1, $2, 'Dual Guardian', $3)`,
    [guardianId, schoolA, `9${Math.floor(100000000 + Math.random() * 899999999)}`],
  )
  await pool.query(
    `INSERT INTO membership_guardian_links (school_id, membership_id, guardian_id, verified_at)
     VALUES ($1, $2, $3, now())`,
    [schoolA, membershipId, guardianId],
  )
  await pool.query(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relation)
     VALUES ($1, $2, $3, 'guardian')`,
    [schoolA, studentId, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_student_access
       (school_id, guardian_id, student_id, status, areas, approved_by_membership_id, approved_at)
     VALUES ($1, $2, $3, 'approved', ARRAY['basic']::text[], $4, now())`,
    [schoolA, guardianId, studentId, ownerMembershipId],
  )
}

async function office(client: Client, date?: string): Promise<
  Extract<DashboardResponse, { audience: 'office' }>
> {
  const body = await read(client, date)
  assert.equal(body.audience, 'office')
  if (body.audience !== 'office') throw new Error('not the office dashboard')
  return body
}

function attention(
  body: Extract<DashboardResponse, { audience: 'office' }>,
  key: DashboardAttentionKey,
): number {
  const item = body.attention.find((entry) => entry.key === key)
  assert.ok(item, `the office dashboard carries no ${key} count`)
  return item.count
}

/** The count before and after one seeded problem, for an exact difference. */
async function countAround(
  key: DashboardAttentionKey,
  seed: () => Promise<void>,
): Promise<{ before: number; after: number }> {
  const before = attention(await office(owner, PROBE), key)
  await seed()
  const after = attention(await office(owner, PROBE), key)
  return { before, after }
}

/** A brand new identity, membership and roles, signed in. */
async function member(
  roleKeys: readonly string[],
  label: string,
  withMfa: boolean,
): Promise<{ membershipId: string; userId: string; client: Client }> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `dash-${label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user (id, name, email) VALUES ($1, $2, $3)', [
    userId,
    `Dashboard ${label}`,
    email,
  ])
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [schoolA, membershipId, [...roleKeys]],
  )
  await setFixturePassword(server, userId, PASSWORD)
  const client = withMfa
    ? await signInWithMfa(server, { userId, email, password: PASSWORD })
    : await signInWithPassword(server, email, PASSWORD)
  return { membershipId, userId, client }
}

const extraUserIds: string[] = []

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  // Other suites open years of their own and may leave one of them current;
  // every block on the dashboard is about the current year, so pin it.
  await pool.query(
    `UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND status = 'current' AND id <> $2`,
    [schoolA, yearA],
  )
  await pool.query(`UPDATE academic_years SET status = 'current' WHERE school_id = $1 AND id = $2`, [
    schoolA,
    yearA,
  ])
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [schoolA, yearA])

  // The timetable, the class list and the bell must be exactly what is seeded
  // here, so anything an earlier suite left on this class goes first.
  await pool.query(
    'DELETE FROM timetable_entries WHERE school_id = $1 AND (section_id = $2 OR staff_id = $3)',
    [schoolA, sectionA, staffA],
  )
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1 AND staff_id = $2', [schoolA, staffA])
  await pool.query('DELETE FROM enrollments WHERE school_id = $1 AND section_id = $2', [schoolA, sectionA])
  await pool.query('DELETE FROM bell_schedules WHERE school_id = $1 AND academic_year_id = $2', [schoolA, yearA])
  await pool.query('DELETE FROM substitutions WHERE school_id = $1 AND section_id = $2', [schoolA, sectionA])

  await pool.query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic') ON CONFLICT DO NOTHING`,
    [subjectId, schoolA, `Maths ${suffix}`, `MAT-${suffix}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [otherSectionId, schoolA, yearA, gradeA, `Z${suffix.slice(0, 3)}`],
  )
  // The class teacher of Six A is the fixture teacher, so their own class card
  // has something to say and the second teacher's card stays empty.
  await pool.query('UPDATE sections SET class_teacher_staff_id = $3 WHERE school_id = $1 AND id = $2', [
    schoolA,
    sectionA,
    staffA,
  ])
  await pool.query(
    `INSERT INTO bell_schedules(id,school_id,academic_year_id,name,grade_ids,working_days,periods)
     VALUES ($1,$2,$3,$4,'{}'::uuid[],ARRAY[1,2,3,4,5,6]::smallint[],$5::jsonb)`,
    [
      bellScheduleId,
      schoolA,
      yearA,
      `Bell ${suffix}`,
      JSON.stringify([
        { index: 0, name: 'Assembly', startTime: '08:00', endTime: '08:15', type: 'assembly' },
        { index: 1, name: 'Period 1', startTime: '08:15', endTime: '09:00', type: 'period' },
        { index: 2, name: 'Period 2', startTime: '09:00', endTime: '09:45', type: 'period' },
        { index: 3, name: 'Break', startTime: '09:45', endTime: '10:00', type: 'break' },
        { index: 4, name: 'Period 3', startTime: '10:00', endTime: '10:45', type: 'period' },
      ]),
    ],
  )
  await pool.query(
    `INSERT INTO bell_schedule_grades(school_id,bell_schedule_id,grade_id) VALUES ($1,$2,$3)`,
    [schoolA, bellScheduleId, gradeA],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,last_name,staff_type,designation,status)
     VALUES ($1,$2,$3,'Cover','Colleague','teaching','Teacher','active'),
            ($4,$2,$5,'Second','Teacher','teaching','Teacher','active')`,
    [otherStaffId, schoolA, `A-COV-${suffix}`, secondStaffId, `A-SEC-${suffix}`],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(id,school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,'2026-04-01'), ($7,$2,$8,$4,$9,$6,'2026-04-01') ON CONFLICT DO NOTHING`,
    [randomUUID(), schoolA, staffA, yearA, sectionA, subjectId, randomUUID(), secondStaffId, otherSectionId],
  )
  // Monday period 2 is the fixture teacher's own lesson. Monday period 1 and
  // Thursday period 1 belong to a colleague, which is what a cover duty and an
  // uncovered period are hung on.
  await pool.query(
    `INSERT INTO timetable_entries(id,school_id,academic_year_id,section_id,day_of_week,period_index,subject_id,staff_id,room_number)
     VALUES ($1,$2,$3,$4,1,2,$5,$6,'R1'), ($7,$2,$3,$4,1,1,$5,$8,NULL), ($9,$2,$3,$4,4,1,$5,$8,NULL)`,
    [randomUUID(), schoolA, yearA, sectionA, subjectId, staffA, randomUUID(), otherStaffId, randomUUID()],
  )
  // The cover duty the fixture teacher was given, on a Monday they also teach.
  await pool.query(
    `INSERT INTO substitutions(id,school_id,date,section_id,period_index,subject_id,absent_staff_id,substitute_staff_id)
     VALUES ($1,$2,$3::date,$4,1,$5,$6,$7)`,
    [randomUUID(), schoolA, MONDAY, sectionA, subjectId, otherStaffId, staffA],
  )
  for (const student of [studentA, studentA2]) {
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,7,'2026-04-01') ON CONFLICT DO NOTHING`,
      [randomUUID(), schoolA, student, yearA, sectionA],
    )
  }
  // One admission and one leaving in the probe month, and nothing else of this
  // school falls in December, so the month figures are this suite's own.
  await pool.query(
    `UPDATE students SET admission_date = NULL, left_on = NULL
      WHERE school_id = $1 AND (to_char(admission_date, 'YYYY-MM') = '2026-12' OR to_char(left_on, 'YYYY-MM') = '2026-12')`,
    [schoolA],
  )
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,status,gender,admission_date)
     VALUES ($1,$2,$3,'Fresh','active','male','2026-12-05')`,
    [freshStudentId, schoolA, `DASH-${suffix}`],
  )
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,status,gender,left_on)
     VALUES ($1,$2,$3,'Departed','left','female','2026-12-06')`,
    [leftStudentId, schoolA, `DASH-OUT-${suffix}`],
  )
  await pool.query(`UPDATE students SET gender = 'male' WHERE school_id = $1 AND id = $2`, [schoolA, studentA])
  await pool.query(
    `UPDATE students SET gender = 'female', date_of_birth = '2014-12-10' WHERE school_id = $1 AND id = $2`,
    [schoolA, studentA2],
  )
  await pool.query(`UPDATE staff SET date_of_birth = '1984-12-13' WHERE school_id = $1 AND id = $2`, [
    schoolA,
    staffA,
  ])
  // The holiday this suite asks about, and nothing else in the window.
  await pool.query('DELETE FROM holidays WHERE school_id = $1 AND end_date >= $2::date', [schoolA, SUNDAY])
  await pool.query(
    `INSERT INTO holidays(id,school_id,academic_year_id,name,start_date,end_date,type)
     VALUES ($1,$2,$3,$4,$5::date,$6::date,'festival')`,
    [holidayId, schoolA, yearA, HOLIDAY_NAME, HOLIDAY_START, HOLIDAY_END],
  )
  // One consent already given, so the parent card can drop that purpose.
  // Consent history is append-only, so nothing is cleared first.
  await pool.query(
    `INSERT INTO guardian_consents(id,school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,'photographs','given','in_person',$5)`,
    [randomUUID(), schoolA, studentA2, guardianA2, ownerMembershipId],
  )

  // The parent was granted a school-wide basic read of students (the kind of
  // rule an office member can write). Their read plan now allows every student,
  // so the children list must still come from the family link alone.
  await pool.query(
    `DELETE FROM membership_roles WHERE school_id = $1 AND membership_id = $2
       AND role_id IN (SELECT id FROM roles WHERE school_id = $1 AND key <> 'parent')`,
    [schoolA, parentMembershipId],
  )
  await pool.query('DELETE FROM resource_access_rules WHERE school_id = $1 AND membership_id = $2', [
    schoolA,
    parentMembershipId,
  ])
  await pool.query(
    `INSERT INTO resource_access_rules(id,school_id,membership_id,permission,effect,target_type,effective_from,reason,author_membership_id)
     VALUES ($1,$2,$3,'students.read_basic','allow','school',now() - interval '1 day','Dashboard scope test',$4)`,
    [randomUUID(), schoolA, parentMembershipId, ownerMembershipId],
  )
  // One member of staff is on leave: they still belong to the headcount.
  await pool.query(`UPDATE staff SET status = 'on_leave' WHERE school_id = $1 AND id = $2`, [schoolA, staffA])

  server = await startTestServer()
  for (const [userId, email] of [
    [ownerUserId, OWNER_EMAIL],
    [teacherUserId, TEACHER_EMAIL],
    [parentUserId, PARENT_EMAIL],
    [suspendedUserId, SUSPENDED_EMAIL],
  ]) {
    await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [userId, email])
  }
  await setFixturePassword(server, teacherUserId, PASSWORD)
  await setFixturePassword(server, parentUserId, PASSWORD)
  await setFixturePassword(server, suspendedUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)

  const principalMember = await member(['principal'], 'principal', true)
  principal = principalMember.client
  const adminMember = await member(['admin'], 'admin', true)
  admin = adminMember.client
  const accountantMember = await member(['accountant'], 'accountant', true)
  accountant = accountantMember.client
  // A teacher with no staff record teaches no section, so a teacher role on
  // its own would not open the door. This member also keeps the books, which
  // is what makes the empty teacher answer reachable at all.
  const unlinked = await member(['teacher', 'accountant'], 'unlinked', true)
  unlinkedTeacher = unlinked.client
  const second = await member(['teacher'], 'second', false)
  secondTeacher = second.client
  await pool.query(
    `INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)`,
    [schoolA, second.membershipId, secondStaffId],
  )
  // Two people with more than one home: a teacher who is also a parent, and
  // an accountant who is too. Each is linked to the fixture pupil as a parent.
  const dual = await member(['teacher', 'parent'], 'dual', false)
  teacherParent = dual.client
  await linkChild(dual.membershipId, studentA)
  const books = await member(['accountant', 'parent'], 'books', true)
  accountantParent = books.client
  await linkChild(books.membershipId, studentA)
  extraUserIds.push(
    principalMember.userId,
    adminMember.userId,
    accountantMember.userId,
    unlinked.userId,
    second.userId,
    dual.userId,
    books.userId,
  )
})

after(async () => {
  const pool = adminPool()
  // The exam rows this suite made. A published card is frozen for everybody,
  // so its trigger is lifted for the tidy-up alone.
  await pool.query('ALTER TABLE report_card_versions DISABLE TRIGGER report_card_versions_no_change')
  await pool.query('DELETE FROM report_card_versions WHERE school_id = $1 AND id = $2', [schoolA, dashCard])
  await pool.query('ALTER TABLE report_card_versions ENABLE TRIGGER report_card_versions_no_change')
  await pool.query('DELETE FROM exam_papers WHERE school_id = $1 AND exam_id = $2', [schoolA, dashExam])
  await pool.query('DELETE FROM exams WHERE school_id = $1 AND id = $2', [schoolA, dashExam])
  for (const table of ['guardian_student_access', 'student_guardians', 'membership_guardian_links']) {
    await pool.query(`DELETE FROM ${table} WHERE school_id = $1 AND guardian_id = ANY($2::uuid[])`, [
      schoolA,
      dualGuardianIds,
    ])
  }
  await pool.query('DELETE FROM guardians WHERE school_id = $1 AND id = ANY($2::uuid[])', [schoolA, dualGuardianIds])
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  // The whole suite shares one database, so the widened parent scope and the
  // staff member put on leave have to go back the way they were found.
  await pool.query('DELETE FROM resource_access_rules WHERE school_id = $1 AND membership_id = $2', [
    schoolA,
    parentMembershipId,
  ])
  await pool.query(`UPDATE staff SET status = 'active', date_of_birth = NULL WHERE school_id = $1 AND id = $2`, [schoolA, staffA])
  await pool.query('UPDATE sections SET class_teacher_staff_id = NULL WHERE school_id = $1 AND id = $2', [
    schoolA,
    sectionA,
  ])
  await pool.query('DELETE FROM substitutions WHERE school_id = $1 AND section_id = $2', [schoolA, sectionA])
  await pool.query('DELETE FROM timetable_entries WHERE school_id = $1 AND section_id = $2', [schoolA, sectionA])
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1 AND staff_id = ANY($2::uuid[])', [
    schoolA,
    [staffA, secondStaffId],
  ])
  await pool.query('DELETE FROM bell_schedules WHERE school_id = $1 AND id = $2', [schoolA, bellScheduleId])
  // The two colleagues this suite invented must not appear in the staff suite's searches.
  await pool.query('DELETE FROM membership_staff_links WHERE school_id = $1 AND staff_id = ANY($2::uuid[])', [
    schoolA,
    [otherStaffId, secondStaffId],
  ])
  await pool.query('DELETE FROM staff WHERE school_id = $1 AND id = ANY($2::uuid[])', [schoolA, [otherStaffId, secondStaffId]])
  await pool.query('DELETE FROM holidays WHERE school_id = $1 AND id = $2', [schoolA, holidayId])
  await pool.query('DELETE FROM enrollments WHERE school_id = $1 AND section_id = $2', [schoolA, sectionA])
  await pool.query('DELETE FROM students WHERE school_id = $1 AND id = ANY($2::uuid[])', [
    schoolA,
    [freshStudentId, leftStudentId],
  ])
  await server?.close()
  await closeAdminPool()
})

test('the dashboard needs a signed in member', async () => {
  const response = await fetch(`${server.origin}/api/schools/${schoolA}/dashboard`)
  assert.equal(response.status, 401)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'AUTHENTICATION_REQUIRED')
})

test('a school A member cannot read the school B dashboard', async () => {
  const response = await dashboard(owner, schoolB)
  assert.equal(response.status, 403)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
  const parentAttempt = await dashboard(parent, schoolB)
  assert.equal(parentAttempt.status, 403)
})

test('a suspended membership cannot reach the dashboard at all', async () => {
  const suspended = await signInWithPassword(server, SUSPENDED_EMAIL, PASSWORD)
  const response = await suspended.fetch(`/api/schools/${schoolA}/dashboard`)
  assert.equal(response.status, 403)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('a date that is not a date is refused before anything is read', async () => {
  for (const bad of ['2026-13-40', 'yesterday', '10-12-2026']) {
    const response = await dashboard(owner, schoolA, bad)
    assert.equal(response.status, 400, bad)
    const body = (await response.json()) as ErrorBody
    assert.equal(body.error.code, 'INVALID_REQUEST')
  }
})

test('the audience comes from the roles a member holds, and an unknown role gets none', () => {
  assert.equal(audienceFor(['owner', 'parent']), 'office')
  assert.equal(audienceFor(['principal']), 'office')
  assert.equal(audienceFor(['admin']), 'office')
  assert.equal(audienceFor(['teacher', 'parent']), 'teacher')
  // The default order is office, accountant, teacher, parent.
  assert.equal(audienceFor(['parent', 'accountant']), 'accountant')
  assert.equal(audienceFor(['parent', 'accountant', 'teacher']), 'accountant')
  assert.equal(audienceFor(['accountant']), 'accountant')
  // Task 23: a pupil's own login lands on the student home.
  assert.equal(audienceFor(['student']), 'student')
  assert.equal(audienceFor([]), null)
})

test('a member may ask for any home their roles earn, and no other', () => {
  assert.deepEqual(audiencesFor(['parent', 'teacher']), ['teacher', 'parent'])
  assert.deepEqual(audiencesFor(['owner', 'accountant', 'parent']), ['office', 'accountant', 'parent'])
  assert.deepEqual(audiencesFor(['student']), ['student'])
  assert.equal(resolveAudience(['student'], 'parent'), null)
  assert.equal(resolveAudience(['teacher', 'parent'], undefined), 'teacher')
  assert.equal(resolveAudience(['teacher', 'parent'], 'parent'), 'parent')
  assert.equal(resolveAudience(['teacher', 'parent'], 'office'), null)
  assert.equal(resolveAudience(['parent'], 'teacher'), null)
  assert.equal(resolveAudience([], undefined), null)
})

test('a teacher who is also a parent lands on the teacher home and may ask for the parent one', async () => {
  const byDefault = await read(teacherParent, MONDAY)
  assert.equal(byDefault.audience, 'teacher')
  const asParent = await read(teacherParent, MONDAY, 'parent')
  assert.equal(asParent.audience, 'parent')
  if (asParent.audience !== 'parent') return
  // The parent home is still theirs alone: one child, through the family link.
  assert.deepEqual(asParent.children.map((child) => child.student.id), [studentA])
  const asTeacher = await read(teacherParent, MONDAY, 'teacher')
  assert.equal(asTeacher.audience, 'teacher')
})

test('a home the roles do not earn is refused before anything is read', async () => {
  // The audience is checked before the tenant transaction opens, like the date.
  for (const [client, audience] of [
    [teacher, 'office'],
    [secondTeacher, 'parent'],
    [teacherParent, 'office'],
    [teacherParent, 'accountant'],
    [parent, 'teacher'],
    [accountant, 'office'],
  ] as const) {
    const response = await dashboard(client, schoolA, MONDAY, audience)
    assert.equal(response.status, 400, audience)
    const body = (await response.json()) as ErrorBody
    assert.equal(body.error.code, 'INVALID_REQUEST')
  }
  // A word that is not an audience at all is refused by the query shape.
  const nonsense = await dashboard(teacherParent, schoolA, MONDAY, 'everyone')
  assert.equal(nonsense.status, 400)
})

test('an accountant who is also a parent lands on the accountant home', async () => {
  const byDefault = await read(accountantParent, PROBE)
  assert.equal(byDefault.audience, 'accountant')
  if (byDefault.audience !== 'accountant') return
  assert.ok(byDefault.fees, 'the accountant home carries the fees block')
  const asParent = await read(accountantParent, MONDAY, 'parent')
  assert.equal(asParent.audience, 'parent')
  if (asParent.audience !== 'parent') return
  assert.deepEqual(asParent.children.map((child) => child.student.id), [studentA])
})

test('the day says school day, holiday or Sunday, and points at the next working day', async () => {
  const schoolDay = await office(owner, PROBE)
  assert.equal(schoolDay.day.date, PROBE)
  assert.equal(schoolDay.day.kind, 'school_day')
  assert.equal(schoolDay.day.dayOfWeek, 4)
  assert.equal(schoolDay.day.holidayName, undefined)
  assert.deepEqual(schoolDay.day.nextSchoolDay, { date: '2026-12-11', dayOfWeek: 5 })

  const holiday = await office(owner, HOLIDAY_START)
  assert.equal(holiday.day.kind, 'holiday')
  assert.equal(holiday.day.holidayName, HOLIDAY_NAME)
  // The second day of the same holiday is skipped as well.
  assert.deepEqual(holiday.day.nextSchoolDay, { date: '2026-12-09', dayOfWeek: 3 })

  const sunday = await office(owner, SUNDAY)
  assert.equal(sunday.day.kind, 'sunday')
  assert.equal(sunday.day.dayOfWeek, 0)
  // Monday and Tuesday are the holiday, so the next working day is Wednesday.
  assert.deepEqual(sunday.day.nextSchoolDay, { date: '2026-12-09', dayOfWeek: 3 })

  // The holiday itself is listed for the thirty days ahead.
  const listed = sunday.holidays.find((entry) => entry.id === holidayId)
  assert.ok(listed)
  assert.deepEqual(listed, {
    id: holidayId,
    name: HOLIDAY_NAME,
    startDate: HOLIDAY_START,
    endDate: HOLIDAY_END,
    type: 'festival',
  })
})

test('the glance counts the roll, the mix and the movements of the month', async () => {
  const body = await office(owner, PROBE)
  const glance = body.glance
  assert.ok(glance)
  const counted = await adminPool().query<{ total: string; boys: string; girls: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE gender = 'male')::text AS boys,
            count(*) FILTER (WHERE gender = 'female')::text AS girls
       FROM students WHERE school_id = $1 AND status = 'active'`,
    [schoolA],
  )
  const row = counted.rows[0]
  assert.equal(glance.students.total, Number(row?.total))
  const mix = glance.mix
  assert.ok(mix, 'the owner may read the sensitive block, so the mix is sent')
  assert.equal(mix.boys, Number(row?.boys))
  assert.equal(mix.girls, Number(row?.girls))
  assert.equal(glance.students.total, mix.boys + mix.girls + mix.other)
  assert.ok(mix.boys >= 2)
  assert.ok(mix.girls >= 1)
  // December belongs to this suite: one admission and one leaving.
  assert.equal(glance.admittedThisMonth, 1)
  assert.equal(glance.leftThisMonth, 1)
  assert.equal(typeof body.studentsPerTeacher, 'number')
})

test('the admissions chart holds the twelve months of the year, April to March', async () => {
  const body = await office(owner, PROBE)
  const months = body.admissionsByMonth
  assert.ok(months)
  assert.equal(months.length, 12)
  assert.equal(months[0]?.month, '2026-04')
  assert.equal(months[11]?.month, '2027-03')
  assert.deepEqual(
    months.map((entry) => entry.month),
    [
      '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
      '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
    ],
  )
  assert.equal(months.find((entry) => entry.month === '2026-12')?.count, 1)
})

test('birthdays carry a name, a class and a date, and nothing else', async () => {
  const body = await office(owner, PROBE)
  const birthdays = body.birthdays
  assert.ok(birthdays)
  const child = birthdays.today.find((entry) => entry.id === studentA2)
  assert.ok(child, 'the child whose birthday is today is missing')
  assert.deepEqual(Object.keys(child).sort(), ['className', 'date', 'id', 'kind', 'name'].sort())
  assert.equal(child.kind, 'student')
  assert.equal(child.className, 'Six A')
  assert.equal(child.date, PROBE)
  const colleague = birthdays.thisWeek.find((entry) => entry.id === staffA)
  assert.ok(colleague, 'the staff birthday three days ahead is missing')
  assert.equal(colleague.kind, 'staff')
  assert.equal(colleague.className, undefined)
  assert.equal(colleague.date, '2026-12-13')
  // Today's list never repeats in the week's list.
  assert.ok(!birthdays.thisWeek.some((entry) => entry.date === PROBE))
})

test('class strength counts the enrolled children of each section', async () => {
  const body = await office(owner, PROBE)
  const strengths = body.classStrength
  assert.ok(strengths)
  const six = strengths.find((entry) => entry.grade.id === gradeA)
  assert.ok(six)
  assert.equal(six.grade.name, 'Six')
  assert.equal(six.sections.find((entry) => entry.id === sectionA)?.count, 2)
  assert.equal(six.sections.find((entry) => entry.id === otherSectionId)?.count, 0)
})

test('the setup list names the steps the caller may read and whether they are done', async () => {
  const body = await office(owner, PROBE)
  const setup = body.setup
  assert.ok(setup)
  assert.deepEqual(
    setup.steps.map((step) => step.key),
    ['school', 'years', 'grades', 'sections', 'subjects'],
  )
  for (const key of ['years', 'grades', 'sections', 'subjects'] as const) {
    assert.equal(setup.steps.find((step) => step.key === key)?.done, true, key)
  }
})

test('security events are for the owner alone, and activity needs audit.read', async () => {
  const forOwner = await office(owner, PROBE)
  assert.ok(Array.isArray(forOwner.securityEvents))
  assert.ok(Array.isArray(forOwner.recentActivity))
  for (const event of forOwner.securityEvents ?? []) {
    assert.ok(
      event.outcome === 'denied' ||
        /^(roles|members|ownership)\./.test(event.action),
      `${event.action} does not belong on the security card`,
    )
  }

  // A principal reads the audit, but the security card is the owner's alone.
  const forPrincipal = await office(principal, PROBE)
  assert.equal(forPrincipal.securityEvents, undefined)
  assert.ok(Array.isArray(forPrincipal.recentActivity))

  // An administrator holds no audit.read at all, so the card is absent, not zero.
  const forAdmin = await office(admin, PROBE)
  assert.equal(forAdmin.recentActivity, undefined)
  assert.equal(forAdmin.securityEvents, undefined)
})

test('the office attention list carries every key the owner may read', async () => {
  const body = await office(owner, PROBE)
  assert.deepEqual(
    body.attention.map((item) => item.key),
    [
      'periods_without_cover',
      'students_absent_three_days',
      'invitations_expiring',
      'students_without_guardian_phone',
      'students_without_consent',
      'sections_without_class_teacher',
      'empty_timetable_slots',
      'staff_without_login',
    ],
  )
  assert.ok(body.attention.every((item) => Number.isInteger(item.count) && item.count >= 0))
})

test('one uncovered period on the date is counted once', async () => {
  const id = randomUUID()
  const { before: seen, after } = await countAround('periods_without_cover', async () => {
    await adminPool().query(
      `INSERT INTO substitutions(id,school_id,date,section_id,period_index,subject_id,absent_staff_id,substitute_staff_id)
       VALUES ($1,$2,$3::date,$4,1,$5,$6,NULL)`,
      [id, schoolA, PROBE, sectionA, subjectId, otherStaffId],
    )
  })
  assert.equal(after, seen + 1)
  const body = await office(owner, PROBE)
  assert.equal(body.today?.periodsWithoutCover, after)
  assert.ok((body.today?.teachersAway ?? 0) >= 1)
  await adminPool().query('DELETE FROM substitutions WHERE id = $1', [id])
})

test('one invitation about to expire is counted once', async () => {
  const id = randomUUID()
  const { before: seen, after } = await countAround('invitations_expiring', async () => {
    await adminPool().query(
      `INSERT INTO school_invitations(id,school_id,identifier_type,identifier_normalized,destination_masked,
         token_digest,status,proposed_role_keys,inviter_membership_id,expires_at)
       VALUES ($1,$2,'email',$3,'d***@example.test',$4,'pending',ARRAY['parent'],$5, now() + interval '2 hours')`,
      [id, schoolA, `dash-invite-${suffix}@example.test`, `digest-${suffix}`, ownerMembershipId],
    )
  })
  assert.equal(after, seen + 1)
  // An invitation that expires next week is not about to expire.
  await adminPool().query(
    `UPDATE school_invitations SET expires_at = now() + interval '7 days' WHERE id = $1`,
    [id],
  )
  assert.equal(attention(await office(owner, PROBE), 'invitations_expiring'), seen)
  await adminPool().query('DELETE FROM school_invitations WHERE id = $1', [id])
})

test('one child with no guardian telephone number is counted once', async () => {
  const id = randomUUID()
  const { before: seen, after } = await countAround('students_without_guardian_phone', async () => {
    await adminPool().query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status)
       VALUES ($1,$2,$3,'No Phone','active')`,
      [id, schoolA, `DASH-NP-${suffix}`],
    )
  })
  assert.equal(after, seen + 1)
  await adminPool().query('DELETE FROM students WHERE id = $1', [id])
})

test('one child with no consent on record is counted once', async () => {
  const id = randomUUID()
  const { before: seen, after } = await countAround('students_without_consent', async () => {
    await adminPool().query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status)
       VALUES ($1,$2,$3,'No Consent','active')`,
      [id, schoolA, `DASH-NC-${suffix}`],
    )
  })
  assert.equal(after, seen + 1)
  await adminPool().query('DELETE FROM students WHERE id = $1', [id])
})

test('one section with no class teacher is counted once', async () => {
  const id = randomUUID()
  const { before: seen, after } = await countAround('sections_without_class_teacher', async () => {
    await adminPool().query(
      `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
      [id, schoolA, yearA, gradeA, `Y${suffix.slice(0, 3)}`],
    )
  })
  assert.equal(after, seen + 1)
  // Naming a class teacher takes the section off the list again.
  await adminPool().query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [id, staffA])
  assert.equal(attention(await office(owner, PROBE), 'sections_without_class_teacher'), seen)
  await adminPool().query('DELETE FROM sections WHERE id = $1', [id])
})

test('one filled timetable slot takes one empty slot off the list', async () => {
  const before = attention(await office(owner, PROBE), 'empty_timetable_slots')
  // The bell schedule holds three teaching periods on each of six days, so a
  // section with no entries owes eighteen slots.
  assert.ok(before >= 18 - 3)
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO timetable_entries(id,school_id,academic_year_id,section_id,day_of_week,period_index,subject_id,staff_id)
     VALUES ($1,$2,$3,$4,5,4,$5,$6)`,
    [id, schoolA, yearA, sectionA, subjectId, staffA],
  )
  assert.equal(attention(await office(owner, PROBE), 'empty_timetable_slots'), before - 1)
  await adminPool().query('DELETE FROM timetable_entries WHERE id = $1', [id])
})

test('one member of staff with no way to sign in is counted once', async () => {
  const id = randomUUID()
  const { before: seen, after } = await countAround('staff_without_login', async () => {
    await adminPool().query(
      `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
       VALUES ($1,$2,$3,'Loginless','teaching','Teacher','active')`,
      [id, schoolA, `A-NOL-${suffix}`],
    )
  })
  assert.equal(after, seen + 1)
  // A pending invitation naming that member of staff answers the question.
  const invitationId = randomUUID()
  await adminPool().query(
    `INSERT INTO school_invitations(id,school_id,identifier_type,identifier_normalized,destination_masked,
       token_digest,status,proposed_role_keys,inviter_membership_id,expires_at,staff_id)
     VALUES ($1,$2,'email',$3,'d***@example.test',$4,'pending',ARRAY['teacher'],$5, now() + interval '20 days',$6)`,
    [invitationId, schoolA, `dash-staff-${suffix}@example.test`, `digest-staff-${suffix}`, ownerMembershipId, id],
  )
  assert.equal(attention(await office(owner, PROBE), 'staff_without_login'), seen)
  await adminPool().query('DELETE FROM school_invitations WHERE id = $1', [invitationId])
  await adminPool().query('DELETE FROM staff WHERE id = $1', [id])
})

test('a teacher sees their own week and nobody else', async () => {
  const body = await read(teacher, MONDAY)
  assert.equal(body.audience, 'teacher')
  if (body.audience !== 'teacher') return
  assert.equal(body.staffLinked, true)
  assert.equal(body.academicYearId, yearA)
  assert.equal(body.week.length, 1)
  const cell = body.week[0]
  assert.equal(cell?.section.id, sectionA)
  assert.equal(cell?.section.name, 'Six A')
  assert.equal(cell?.subject.id, subjectId)
  assert.equal(cell?.dayOfWeek, 1)
  assert.equal(cell?.periodIndex, 2)
  assert.equal(cell?.roomNumber, 'R1')
  // The colleague's own periods in the same section are not theirs to see.
  assert.ok(!body.week.some((entry) => entry.periodIndex === 1))
  // The unassigned section of the same grade and year never appears.
  assert.ok(!body.week.some((entry) => entry.section.id === otherSectionId))
})

test('the teacher timeline carries bell times and marks the cover duty they were given', async () => {
  const body = await read(teacher, MONDAY)
  if (body.audience !== 'teacher') throw new Error('not the teacher dashboard')
  assert.equal(body.timelineDate, MONDAY)
  assert.deepEqual(
    body.periods.map((period) => period.index),
    [0, 1, 2, 3, 4],
  )
  assert.equal(body.periods[1]?.startTime, '08:15')
  assert.equal(body.periods[1]?.endTime, '09:00')
  assert.equal(body.periods[3]?.type, 'break')
  assert.equal(body.timeline.length, 5)
  const cover = body.timeline.find((slot) => slot.periodIndex === 1)
  assert.equal(cover?.lesson?.cover, true)
  assert.equal(cover?.lesson?.section.id, sectionA)
  const own = body.timeline.find((slot) => slot.periodIndex === 2)
  assert.equal(own?.lesson?.cover, false)
  assert.equal(own?.lesson?.roomNumber, 'R1')
  // A teaching period with no lesson is a free period, not a missing slot.
  assert.equal(body.timeline.find((slot) => slot.periodIndex === 4)?.lesson, undefined)
})

test('the class card belongs to the class teacher alone', async () => {
  const mine = await read(teacher, PROBE)
  if (mine.audience !== 'teacher') throw new Error('not the teacher dashboard')
  assert.equal(mine.myClass?.section.id, sectionA)
  assert.equal(mine.myClass?.section.name, 'Six A')
  assert.equal(mine.myClass?.strength, 2)
  // A birth date is in the sensitive block of a student record, which a teacher
  // does not hold, so the class card carries no birthday list at all.
  assert.equal(mine.myClass?.birthdaysThisWeek, undefined)

  const theirs = await read(secondTeacher, PROBE)
  if (theirs.audience !== 'teacher') throw new Error('not the teacher dashboard')
  assert.equal(theirs.staffLinked, true)
  assert.equal(theirs.myClass, undefined)
})

test('a teacher with no staff record gets an empty, honest answer', async () => {
  // This member also keeps the books, so the accountant home comes first; they ask for the teacher one.
  const body = await read(unlinkedTeacher, PROBE, 'teacher')
  // Nothing is invented for them: no week, no timeline, no class.
  if (body.audience !== 'teacher') throw new Error('not the teacher dashboard')
  assert.equal(body.staffLinked, false)
  assert.deepEqual(body.week, [])
  assert.deepEqual(body.timeline, [])
  assert.equal(body.timelineDate, null)
  assert.equal(body.myClass, undefined)
})

test('the teacher timeline moves to the next working day on a holiday', async () => {
  const body = await read(teacher, SUNDAY)
  if (body.audience !== 'teacher') throw new Error('not the teacher dashboard')
  assert.equal(body.day.kind, 'sunday')
  // Monday and Tuesday are the holiday, so the timeline is Wednesday's.
  assert.equal(body.timelineDate, '2026-12-09')
})

test('a parent sees exactly their own child, never another family or another school', async () => {
  const body = await read(parent, MONDAY)
  assert.equal(body.audience, 'parent')
  if (body.audience !== 'parent') return
  assert.deepEqual(
    body.children.map((child) => child.student.id),
    [studentA2],
  )
  // The widened scope would let the plan alone return every student.
  assert.ok(body.children.every((child) => child.student.id !== studentA && child.student.id !== studentB))
  assert.ok(body.children.every((child) => child.student.id !== freshStudentId))
  const child = body.children[0]
  assert.equal(child?.enrollment?.section.id, sectionA)
  assert.equal(child?.enrollment?.grade.id, gradeA)
  assert.equal(child?.enrollment?.academicYear.id, yearA)
})

test("a parent sees their child's own day and what is still waiting on them", async () => {
  const body = await read(parent, MONDAY)
  if (body.audience !== 'parent') throw new Error('not the parent dashboard')
  const child = body.children[0]
  assert.ok(child)
  const lessons = child.todayLessons
  assert.ok(lessons)
  assert.equal(lessons.length, 5)
  assert.equal(lessons.find((slot) => slot.periodIndex === 2)?.lesson?.subject.id, subjectId)
  assert.equal(lessons.find((slot) => slot.periodIndex === 1)?.lesson?.section.id, sectionA)
  // The consent already given is dropped; the others are still waiting.
  const purposes = child.waitingOn.map((item) => item.purpose)
  assert.ok(!purposes.includes('photographs'), 'a consent already given is still being asked for')
  const answered = await ownGiven(guardianA2, studentA2)
  assert.deepEqual(
    [...purposes].sort(),
    CONSENT_PURPOSES.filter((purpose) => !answered.has(purpose)).slice().sort(),
  )
  assert.ok(purposes.length >= 1)
  assert.ok(child.waitingOn.every((item) => item.kind === 'consent'))
})

test("the parent home carries the viewer's own guardian record, and a teacher-parent's is their own", async () => {
  const body = await read(parent, MONDAY)
  if (body.audience !== 'parent') throw new Error('not the parent dashboard')
  assert.equal(body.guardianId, guardianA2)
  const dual = await read(teacherParent, MONDAY, 'parent')
  if (dual.audience !== 'parent') throw new Error('not the parent dashboard')
  assert.ok(dual.guardianId)
  assert.notEqual(dual.guardianId, guardianA2)
  assert.ok(dualGuardianIds.includes(dual.guardianId))
})

test("another guardian's consent does not answer for the viewer", async () => {
  const pool = adminPool()
  // A second guardian of the same pupil says yes to a purpose the viewer has
  // not answered. The guardian row is left behind: consent history is
  // append-only and points at it.
  const otherGuardian = randomUUID()
  await pool.query(
    `INSERT INTO guardians (id, school_id, first_name, phone) VALUES ($1, $2, 'Other Guardian', $3)`,
    [otherGuardian, schoolA, `9${Math.floor(100000000 + Math.random() * 899999999)}`],
  )
  const own = await ownGiven(guardianA2, studentA2)
  const purpose = CONSENT_PURPOSES.find((candidate) => !own.has(candidate))
  assert.ok(purpose, 'the viewer has answered every purpose already')
  await pool.query(
    `INSERT INTO guardian_consents(id,school_id,student_id,guardian_id,purpose,status,method,recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,'given','in_person',$6)`,
    [randomUUID(), schoolA, studentA2, otherGuardian, purpose, ownerMembershipId],
  )
  const body = await read(parent, MONDAY)
  if (body.audience !== 'parent') throw new Error('not the parent dashboard')
  const purposes = body.children[0]?.waitingOn.map((item) => item.purpose) ?? []
  assert.ok(purposes.includes(purpose), `${purpose} was answered by another guardian`)
})

test('a parent who allows school messages is no longer asked, and asked again after withdrawing', async () => {
  const record = (status: 'given' | 'withdrawn') =>
    parent.fetch(`/api/schools/${schoolA}/students/${studentA2}/consents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ guardianId: guardianA2, purpose: 'communication', status, method: 'portal' }),
    })
  const waitingOnMessages = async (): Promise<boolean> => {
    const body = await read(parent, MONDAY)
    if (body.audience !== 'parent') throw new Error('not the parent dashboard')
    return body.children[0]?.waitingOn.some((item) => item.purpose === 'communication') ?? false
  }

  const given = await record('given')
  assert.equal(given.status, 200, await given.clone().text())
  assert.equal(await waitingOnMessages(), false)
  const stored = await adminPool().query<{ method: string }>(
    `SELECT method FROM guardian_consents
      WHERE school_id = $1 AND student_id = $2 AND guardian_id = $3 AND purpose = 'communication'
      ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [schoolA, studentA2, guardianA2],
  )
  assert.equal(stored.rows[0]?.method, 'portal')

  // Withdrawing is the newest row, so the question comes back. It also leaves
  // the pupil's messages as the other suites found them.
  const withdrawn = await record('withdrawn')
  assert.equal(withdrawn.status, 200, await withdrawn.clone().text())
  assert.equal(await waitingOnMessages(), true)
})

test('an accountant gets the roll and the money card, and no class strengths', async () => {
  const body = await read(accountant, PROBE)
  assert.equal(body.audience, 'accountant')
  if (body.audience !== 'accountant') return
  // The accountant holds fees.read over the whole school's finances, so the
  // money card is there. Its figures are whole paise and never negative.
  assert.ok(body.fees, 'the accountant dashboard carries the fees block')
  for (const value of Object.values(body.fees)) {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `${value} is not a whole count of paise`)
  }
  // The accountant holds no sections.read_strengths, so the block is absent.
  assert.equal(body.classStrength, undefined)
  assert.deepEqual(
    Object.keys(body).sort(),
    ['audience', 'day', 'fees', ...(body.glance ? ['glance'] : [])].sort(),
  )
})

test('the response carries only the fields the contract allows', async () => {
  const response = await dashboard(parent, schoolA)
  const raw = (await response.json()) as Record<string, unknown>
  // A strict parse of the raw body: an extra key would fail here.
  const parsed = DashboardResponse.parse(raw)
  assert.deepEqual(Object.keys(raw).sort(), Object.keys(parsed).sort())
  assert.deepEqual(Object.keys(raw).sort(), ['audience', 'children', 'day', 'guardianId'])
})

test('the dashboard is a read; it does not accept a query that widens it', async () => {
  // The route accepts the date and one of the caller's own audiences; anything else is refused.
  const widened = await parent.fetch(`/api/schools/${schoolA}/dashboard?audience=office&schoolId=${schoolB}`)
  assert.equal(widened.status, 400)
  const office = await dashboard(parent, schoolA, PROBE, 'office')
  assert.equal(office.status, 400)
  assert.equal(((await office.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
  const body = await read(parent, PROBE)
  // The audience comes from the roles, so a parent's own home is the only one they can name.
  assert.equal(body.audience, 'parent')
  assert.equal((await read(parent, PROBE, 'parent')).audience, 'parent')
})

test('the exam blocks: marks to enter, the office card and the newest report card', async () => {
  const pool = adminPool()
  // Before any exam is set up, the office card is absent, not empty, and a
  // parent sees no exam figure anywhere.
  const bare = await read(owner, PROBE)
  if (bare.audience !== 'office') throw new Error('not the office dashboard')
  assert.equal(bare.exams, undefined)

  await pool.query(
    `INSERT INTO exams(id,school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline)
     VALUES ($1,$2,$3,'periodic_test_1','2026-12-01','2026-12-05','2026-12-20')`,
    [dashExam, schoolA, yearA],
  )
  await pool.query(
    `INSERT INTO exam_papers(id,school_id,exam_id,academic_year_id,section_id,subject_id)
     VALUES ($1,$3,$4,$5,$6,$8), ($2,$3,$4,$5,$7,$8)`,
    [dashPaperOwn, dashPaperOther, schoolA, dashExam, yearA, sectionA, otherSectionId, subjectId],
  )

  // The fixture teacher teaches the subject in Six A only, so only that paper
  // is theirs to fill in, with nothing entered yet.
  const mine = await read(teacher, PROBE)
  if (mine.audience !== 'teacher') throw new Error('not the teacher dashboard')
  assert.ok(mine.marksToEnter, 'a teacher who records marks has the block')
  assert.deepEqual(mine.marksToEnter.map((row) => row.paperId), [dashPaperOwn])
  const own = mine.marksToEnter[0]!
  assert.equal(own.entered, 0)
  assert.ok(own.expected >= 2, 'the roster of Six A on the first day of the exam')
  assert.equal(own.exam.recheckDeadline, '2026-12-20')
  // After the re-check deadline the window is shut and the paper leaves the list.
  const late = await read(teacher, '2026-12-28')
  if (late.audience !== 'teacher') throw new Error('not the teacher dashboard')
  assert.deepEqual(late.marksToEnter, [])

  const office = await read(owner, PROBE)
  if (office.audience !== 'office') throw new Error('not the office dashboard')
  assert.deepEqual(office.exams?.items, [
    {
      examId: dashExam,
      kind: 'periodic_test_1',
      recheckDeadline: '2026-12-20',
      locked: false,
      papersOutstanding: office.exams?.items[0]?.papersOutstanding,
      sectionsTotal: 2,
      sectionsReadyToPublish: 0,
      sectionsPublished: 0,
    },
  ])
  assert.ok((office.exams?.items[0]?.papersOutstanding ?? 0) >= 1)

  // A parent sees no card until one is published, then the newest one.
  const before = await read(parent, PROBE)
  if (before.audience !== 'parent') throw new Error('not the parent dashboard')
  assert.equal(before.children.find((child) => child.student.id === studentA2)?.latestReportCard, undefined)
  await pool.query(
    `INSERT INTO report_card_versions(id,school_id,student_id,academic_year_id,section_id,card,version_number,
                                      content,content_hash,published_by_membership_id)
     VALUES ($1,$2,$3,$4,$5,'term_1',1,'{}'::jsonb,$6,$7)`,
    [dashCard, schoolA, studentA2, yearA, sectionA, 'd'.repeat(64), ownerMembershipId],
  )
  const after = await read(parent, PROBE)
  if (after.audience !== 'parent') throw new Error('not the parent dashboard')
  const card = after.children.find((child) => child.student.id === studentA2)?.latestReportCard
  assert.equal(card?.versionId, dashCard)
  assert.equal(card?.card, 'term_1')
  assert.equal(card?.academicYear.id, yearA)
})
