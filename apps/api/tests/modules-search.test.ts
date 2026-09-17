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
// Unique per run: other test files rewrite the same fixture identities.
const OWNER_EMAIL = `search-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `search-parent-${randomUUID()}@example.test`
const TEACHER_EMAIL = `search-teacher-${randomUUID()}@example.test`
const ACCOUNTANT_EMAIL = `search-accountant-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string

/** Rows this file inserts, so every assertion is exact rather than fixture wide. */
const run = randomUUID().slice(0, 8)
const admissionNumber = `SRCH-${run}`
const employeeCode = `SRCHSTAFF-${run}`
const studentName = `Searchable${run}`
const staffName = `Staffable${run}`
const percentName = `Pct%${run}`
const newStudentA = randomUUID()
const percentStudentA = randomUUID()
const newStudentB = randomUUID()
const newStaffA = randomUUID()
const newStaffB = randomUUID()
const enrollmentA = randomUUID()
// A second class for the same student that the teacher below does not teach.
const secretSection = randomUUID()
const secretEnrollment = randomUUID()
const secretStudent = randomUUID()
const secretStudentEnrollment = randomUUID()
const teacherUser = randomUUID()
const teacherMembership = randomUUID()
const teacherStaff = randomUUID()
const subjectId = randomUUID()
const accountantUser = randomUUID()
const accountantMembership = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let parent: Client
let teacher: Client
let accountant: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}
interface SearchBody {
  students: { id: string; admissionNumber: string; firstName: string; enrollment?: { section: { id: string } } }[]
  staff: { id: string; displayName: string; designation: string }[]
}

async function search(client: Client, school: string, term: string): Promise<Response> {
  return client.fetch(`/api/schools/${school}/search?q=${encodeURIComponent(term)}`)
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [parentUserId, PARENT_EMAIL])

  // Fresh records in both schools, so a cross-school leak would be visible.
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status)
     VALUES ($1,$2,$3,$4,'Kumar','active'),($5,$2,$6,$7,'Kumar','active'),($8,$9,$10,$4,'Kumar','active')`,
    [
      newStudentA, schoolA, admissionNumber, studentName,
      percentStudentA, `SRCHPCT-${run}`, percentName,
      newStudentB, schoolB, `SRCHB-${run}`,
    ],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,last_name,staff_type,designation,department,status)
     VALUES ($1,$2,$3,$4,'Rao','teaching','Lab Assistant','Science','active'),
            ($5,$6,$7,$4,'Rao','teaching','Lab Assistant','Science','active')`,
    [newStaffA, schoolA, employeeCode, staffName, newStaffB, schoolB, `SRCHBSTAFF-${run}`],
  )
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,joined_on)
     VALUES ($1,$2,$3,$4,$5,'2026-04-01')`,
    [enrollmentA, schoolA, newStudentA, fixtureIds.yearA, fixtureIds.sectionA],
  )

  // A teacher assigned to one section only: the scope whose predicate is not
  // simply true, and the one under which an enrollment leak would show.
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [secretSection, schoolA, fixtureIds.yearA, fixtureIds.gradeA, `Secret-${run}`],
  )
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status)
     VALUES ($1,$2,$3,$4,'Kumar','active')`,
    [secretStudent, schoolA, `SRCHSEC-${run}`, `Secretable${run}`],
  )
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,joined_on) VALUES
       ($1,$2,$3,$4,$5,'2026-06-01'),($6,$2,$7,$4,$5,'2026-06-01')`,
    [secretEnrollment, schoolA, newStudentA, fixtureIds.yearA, secretSection, secretStudentEnrollment, secretStudent],
  )
  await pool.query(`INSERT INTO auth_user(id,name,email) VALUES ($1,'Search Teacher',$2)`, [
    teacherUser,
    TEACHER_EMAIL,
  ])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [teacherMembership, schoolA, teacherUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'teacher'`,
    [schoolA, teacherMembership],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,$3,'Section','teaching','Teacher','active')`,
    [teacherStaff, schoolA, `SRCHTEACH-${run}`],
  )
  await pool.query(`INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)`, [
    schoolA,
    teacherMembership,
    teacherStaff,
  ])
  await pool.query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`,
    [subjectId, schoolA, `Maths-${run}`, `M${run}`],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,'2026-04-01')`,
    [schoolA, teacherStaff, fixtureIds.yearA, fixtureIds.sectionA, subjectId],
  )

  // The accountant holds students.read_basic across the whole school but no
  // students.read_enrollments at all, which is the projection case below.
  await pool.query(`INSERT INTO auth_user(id,name,email) VALUES ($1,'Search Accountant',$2)`, [
    accountantUser,
    ACCOUNTANT_EMAIL,
  ])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [accountantMembership, schoolA, accountantUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'accountant'`,
    [schoolA, accountantMembership],
  )

  await setFixturePassword(server, parentUserId, PASSWORD)
  await setFixturePassword(server, teacherUser, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
  accountant = await signInWithMfa(server, {
    userId: accountantUser,
    email: ACCOUNTANT_EMAIL,
    password: PASSWORD,
  })
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1 AND staff_id = $2', [
    schoolA,
    teacherStaff,
  ])
  await pool.query('DELETE FROM enrollments WHERE id = ANY($1::uuid[])', [
    [enrollmentA, secretEnrollment, secretStudentEnrollment],
  ])
  await pool.query('DELETE FROM sections WHERE id = $1', [secretSection])
  await pool.query('DELETE FROM subjects WHERE id = $1', [subjectId])
  await pool.query('DELETE FROM membership_staff_links WHERE membership_id = $1', [teacherMembership])
  await pool.query('DELETE FROM membership_roles WHERE membership_id = $1', [accountantMembership])
  await pool.query('DELETE FROM school_memberships WHERE id = $1', [accountantMembership])
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [accountantUser])
  await pool.query('DELETE FROM membership_roles WHERE membership_id = $1', [teacherMembership])
  await pool.query('DELETE FROM school_memberships WHERE id = $1', [teacherMembership])
  await pool.query('DELETE FROM students WHERE id = $1', [secretStudent])
  await pool.query('DELETE FROM students WHERE id = ANY($1::uuid[])', [
    [newStudentA, percentStudentA, newStudentB],
  ])
  await pool.query('DELETE FROM staff WHERE id = ANY($1::uuid[])', [[newStaffA, newStaffB, teacherStaff]])
  await pool.query('DELETE FROM auth_user WHERE id = ANY($1::uuid[])', [[teacherUser, accountantUser]])
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [ownerUserId])
  await server.close()
  await closeAdminPool()
})

test('search needs a session', async () => {
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/search?q=a`)
  assert.equal(anonymous.status, 401)
})

test('a school A member searching school B is refused', async () => {
  const response = await search(owner, schoolB, studentName)
  assert.equal(response.status, 403)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('the term is required and nothing else is accepted', async () => {
  const blank = await search(owner, schoolA, '   ')
  assert.equal(blank.status, 400)
  assert.equal(((await blank.json()) as ErrorBody).error.code, 'INVALID_REQUEST')

  const tooLong = await search(owner, schoolA, 'x'.repeat(101))
  assert.equal(tooLong.status, 400)

  // An unlisted query key is refused rather than quietly ignored.
  const extra = await owner.fetch(`/api/schools/${schoolA}/search?q=abc&schoolId=${schoolB}`)
  assert.equal(extra.status, 400)
  assert.equal(((await extra.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
})

test('the owner finds a student by admission number and a staff member by employee code', async () => {
  const byAdmission = await search(owner, schoolA, admissionNumber)
  assert.equal(byAdmission.status, 200)
  const students = ((await byAdmission.json()) as SearchBody).students
  assert.equal(students.length, 1)
  assert.equal(students[0]?.id, newStudentA)
  // Two open enrollments: the newest one wins, deterministically.
  assert.equal(students[0]?.enrollment?.section.id, secretSection)
  // Only contract fields: nothing private travels with a search hit.
  assert.deepEqual(
    Object.keys(students[0] ?? {}).sort(),
    ['admissionNumber', 'enrollment', 'firstName', 'id', 'lastName', 'schoolId', 'status', 'version'],
  )

  const byCode = await search(owner, schoolA, employeeCode)
  const staff = ((await byCode.json()) as SearchBody).staff
  assert.equal(staff.length, 1)
  assert.equal(staff[0]?.id, newStaffA)
  assert.deepEqual(
    Object.keys(staff[0] ?? {}).sort(),
    ['department', 'designation', 'displayName', 'id', 'schoolId', 'version'],
  )

  const byDesignation = await search(owner, schoolA, 'Lab Assistant')
  assert.ok(((await byDesignation.json()) as SearchBody).staff.some((row) => row.id === newStaffA))
})

test('school B records never appear in a school A search', async () => {
  const response = await search(owner, schoolA, 'Kumar')
  const body = (await response.json()) as SearchBody
  assert.ok(body.students.some((row) => row.id === newStudentA))
  assert.ok(!body.students.some((row) => row.id === newStudentB))

  const staffHits = await search(owner, schoolA, staffName)
  const staffBody = (await staffHits.json()) as SearchBody
  assert.deepEqual(staffBody.staff.map((row) => row.id), [newStaffA])
})

test('a parent sees only their own child and no staff at all', async () => {
  const response = await search(parent, schoolA, 'Student A')
  assert.equal(response.status, 200)
  const body = (await response.json()) as SearchBody
  assert.deepEqual(body.students.map((row) => row.id), [fixtureIds.studentA2])
  assert.ok(!body.students.some((row) => row.id === fixtureIds.studentA))

  // The parent template grants no staff.read_directory anywhere, so that half
  // of the search is empty instead of failing the whole request.
  const staffSearch = await search(parent, schoolA, staffName)
  assert.equal(staffSearch.status, 200)
  assert.deepEqual(((await staffSearch.json()) as SearchBody).staff, [])
})

test('a parent cannot reach another child through the admission number', async () => {
  const response = await search(parent, schoolA, 'A/2026-27/001')
  assert.equal(response.status, 200)
  assert.deepEqual(((await response.json()) as SearchBody).students, [])
})

test('a percent sign is searched for, not treated as a wildcard', async () => {
  const response = await search(owner, schoolA, '%')
  assert.equal(response.status, 200)
  const body = (await response.json()) as SearchBody
  assert.ok(body.students.some((row) => row.id === percentStudentA))
  assert.ok(!body.students.some((row) => row.id === newStudentA))

  const underscore = await search(owner, schoolA, '_')
  assert.deepEqual(((await underscore.json()) as SearchBody).students, [])
})

test('a teacher only sees the class they teach, never the student\'s other class', async () => {
  const response = await search(teacher, schoolA, admissionNumber)
  assert.equal(response.status, 200)
  const students = ((await response.json()) as SearchBody).students
  assert.deepEqual(students.map((row) => row.id), [newStudentA])
  // The student is also enrolled in a section this teacher does not teach; that
  // enrollment is outside the teacher's scope, so the assigned one is reported.
  assert.equal(students[0]?.enrollment?.section.id, fixtureIds.sectionA)
})

test('a teacher never sees a student enrolled only in a section they do not teach', async () => {
  const response = await search(teacher, schoolA, `Secretable${run}`)
  assert.equal(response.status, 200)
  assert.deepEqual(((await response.json()) as SearchBody).students, [])
})

test('an accountant sees the student but never the class they may not read', async () => {
  const response = await search(accountant, schoolA, admissionNumber)
  assert.equal(response.status, 200)
  const students = ((await response.json()) as SearchBody).students
  assert.deepEqual(students.map((row) => row.id), [newStudentA])
  // No students.read_enrollments grant anywhere, so no class, roll number or
  // outcome travels with the hit.
  assert.equal(students[0]?.enrollment, undefined)
})
