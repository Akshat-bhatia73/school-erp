import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import { DashboardResponse } from '@erp/contracts'
import { audienceFor } from '../src/modules/dashboard/audience.ts'
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
const teacherUserId = fixtureIds.adultUser as string
const parentUserId = fixtureIds.parentA2User as string
const parentMembershipId = fixtureIds.parentA2 as string
const suspendedUserId = fixtureIds.suspendedUser as string
const studentA = fixtureIds.studentA as string
const studentA2 = fixtureIds.studentA2 as string
const studentB = fixtureIds.studentB as string
const staffA = fixtureIds.staffA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const sectionA = fixtureIds.sectionA as string

// Rows this suite owns, so assertions are exact instead of fixture-wide.
const subjectId = randomUUID()
const otherSectionId = randomUUID()
const freshStudentId = randomUUID()
const suffix = randomUUID().slice(0, 8)

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let teacher: Client
let parent: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}

async function dashboard(client: Client, schoolId: string): Promise<Response> {
  return client.fetch(`/api/schools/${schoolId}/dashboard`)
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  // An earlier run of this suite left its own class rows behind, and the
  // timetable slot is unique, so start from a clean school A class.
  // The setup and promotion suites open years of their own and may leave one
  // of them current; the teacher view is for the current year, so pin it.
  await pool.query(`UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND status = 'current' AND id <> $2`, [
    schoolA,
    yearA,
  ])
  await pool.query(`UPDATE academic_years SET status = 'current' WHERE school_id = $1 AND id = $2`, [schoolA, yearA])
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [schoolA, yearA])
  // Other suites leave periods for this teacher in their own sections, and
  // the teacher's own timetable must be exactly the one row seeded here.
  await pool.query(
    'DELETE FROM timetable_entries WHERE school_id = $1 AND (section_id = $2 OR staff_id = $3)',
    [schoolA, sectionA, staffA],
  )
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1 AND staff_id = $2', [schoolA, staffA])
  await pool.query('DELETE FROM enrollments WHERE school_id = $1 AND student_id = ANY($2::uuid[])', [
    schoolA,
    [studentA, studentA2],
  ])
  // The scenario the fixtures deliberately leave out: one subject, one taught
  // section, one period, and enrolments for both school A children.
  await pool.query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic') ON CONFLICT DO NOTHING`,
    [subjectId, schoolA, `Maths ${suffix}`, `MAT-${suffix}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
    [otherSectionId, schoolA, yearA, gradeA, `Z${suffix.slice(0, 3)}`],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(id,school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,'2026-04-01') ON CONFLICT DO NOTHING`,
    [randomUUID(), schoolA, staffA, yearA, sectionA, subjectId],
  )
  await pool.query(
    `INSERT INTO timetable_entries(id,school_id,academic_year_id,section_id,day_of_week,period_index,subject_id,staff_id,room_number)
     VALUES ($1,$2,$3,$4,1,2,$5,$6,'R1') ON CONFLICT DO NOTHING`,
    [randomUUID(), schoolA, yearA, sectionA, subjectId, staffA],
  )
  for (const student of [studentA, studentA2]) {
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,7,'2026-04-01') ON CONFLICT DO NOTHING`,
      [randomUUID(), schoolA, student, yearA, sectionA],
    )
  }
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,'Fresh','active') ON CONFLICT DO NOTHING`,
    [freshStudentId, schoolA, `DASH-${suffix}`],
  )

  // The parent was granted a school-wide basic read of students (the kind of
  // rule an office member can write). Their read plan now allows every student,
  // so the children list must still come from the family link alone.
  // Keep the parent a plain parent: no extra role an earlier run may have left.
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
    [randomUUID(), schoolA, parentMembershipId, fixtureIds.ownerA as string],
  )
  // One member of staff is on leave: they still belong to the headcount.
  await pool.query(
    `UPDATE staff SET status = 'on_leave' WHERE school_id = $1 AND id = $2`,
    [schoolA, staffA],
  )

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
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [ownerUserId])
  // The whole suite shares one database, so the widened parent scope and the
  // staff member put on leave have to go back the way they were found.
  await pool.query('DELETE FROM resource_access_rules WHERE school_id = $1 AND membership_id = $2', [
    schoolA,
    parentMembershipId,
  ])
  await pool.query(`UPDATE staff SET status = 'active' WHERE school_id = $1 AND id = $2`, [schoolA, staffA])
  await pool.query('DELETE FROM timetable_entries WHERE school_id = $1 AND section_id = $2', [schoolA, sectionA])
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1 AND staff_id = $2', [schoolA, staffA])
  await pool.query('DELETE FROM enrollments WHERE school_id = $1 AND student_id = ANY($2::uuid[])', [
    schoolA,
    [studentA, studentA2, freshStudentId],
  ])
  await pool.query('DELETE FROM students WHERE school_id = $1 AND id = $2', [schoolA, freshStudentId])
  await server.close()
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

test('an owner sees the office dashboard with counts from the authorized query', async () => {
  const response = await dashboard(owner, schoolA)
  assert.equal(response.status, 200)
  const body = DashboardResponse.parse(await response.json())
  assert.equal(body.audience, 'office')
  if (body.audience !== 'office') return
  const counted = await adminPool().query<{ students: string; staff: string }>(
    `SELECT (SELECT count(*) FROM students WHERE school_id = $1 AND status = 'active') AS students,
            (SELECT count(*) FROM staff WHERE school_id = $1 AND status IN ('active', 'on_leave')) AS staff`,
    [schoolA],
  )
  // Exact, and it counts the student this suite inserted.
  assert.equal(body.activeStudents, Number(counted.rows[0]?.students))
  assert.equal(body.staffCount, Number(counted.rows[0]?.staff))
  assert.ok(body.activeStudents >= 3)
  // Staff on leave are on the rolls, so the headcount includes them.
  assert.ok(body.staffCount >= 1)
})

test('the audience comes from the roles a member holds, and an unknown role gets none', () => {
  assert.equal(audienceFor(['owner', 'parent']), 'office')
  assert.equal(audienceFor(['principal']), 'office')
  assert.equal(audienceFor(['admin']), 'office')
  assert.equal(audienceFor(['teacher', 'parent']), 'teacher')
  assert.equal(audienceFor(['parent', 'accountant']), 'parent')
  assert.equal(audienceFor(['accountant']), 'accountant')
  assert.equal(audienceFor(['student']), null)
  assert.equal(audienceFor([]), null)
})

test('a teacher who is also a parent sees the teacher dashboard, limited to their own class', async () => {
  const response = await dashboard(teacher, schoolA)
  assert.equal(response.status, 200)
  const body = DashboardResponse.parse(await response.json())
  assert.equal(body.audience, 'teacher')
  if (body.audience !== 'teacher') return
  assert.deepEqual(
    body.assignedSections.map((section) => section.id),
    [sectionA],
  )
  assert.equal(body.assignedSections[0]?.name, 'Six A')
  // The unassigned section of the same grade and year never appears.
  assert.ok(!body.assignedSections.some((section) => section.id === otherSectionId))
  assert.equal(body.ownTimetable.length, 1)
  const cell = body.ownTimetable[0]
  assert.equal(cell?.section.id, sectionA)
  assert.equal(cell?.subject.id, subjectId)
  assert.equal(cell?.dayOfWeek, 1)
  assert.equal(cell?.periodIndex, 2)
  assert.equal(cell?.roomNumber, 'R1')
})

test('a parent sees exactly their own child, never another family or another school', async () => {
  const response = await dashboard(parent, schoolA)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const body = DashboardResponse.parse(await response.json())
  assert.equal(body.audience, 'parent')
  if (body.audience !== 'parent') return
  assert.deepEqual(
    body.children.map((child) => child.id),
    [studentA2],
  )
  // The wider accountant scope would let the plan alone return every student.
  assert.ok(!body.children.some((child) => child.id === studentA || child.id === studentB))
  assert.ok(!body.children.some((child) => child.id === freshStudentId))
  assert.equal(body.children[0]?.enrollment?.section.id, sectionA)
  assert.equal(body.children[0]?.enrollment?.grade.id, gradeA)
  assert.equal(body.children[0]?.enrollment?.academicYear.id, yearA)
})

test('the response carries only the fields the contract allows', async () => {
  const response = await dashboard(parent, schoolA)
  const raw = (await response.json()) as Record<string, unknown>
  // A strict parse of the raw body: an extra key would fail here.
  const parsed = DashboardResponse.parse(raw)
  assert.deepEqual(Object.keys(raw).sort(), Object.keys(parsed).sort())
  assert.deepEqual(Object.keys(raw).sort(), ['audience', 'children'])
})

test('the dashboard is a read; it does not accept a body or a query that widens it', async () => {
  const response = await parent.fetch(`/api/schools/${schoolA}/dashboard?audience=office&schoolId=${schoolB}`)
  assert.equal(response.status, 200)
  const body = DashboardResponse.parse(await response.json())
  // The audience is server-side state, so the query string changes nothing.
  assert.equal(body.audience, 'parent')
})
