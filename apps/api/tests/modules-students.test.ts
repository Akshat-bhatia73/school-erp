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
const OWNER_EMAIL = `students-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `students-parent-${randomUUID()}@example.test`
const TEACHER_EMAIL = `students-teacher-${randomUUID()}@example.test`
const ADMIN_EMAIL = `students-admin-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const studentA = fixtureIds.studentA as string
const studentA2 = fixtureIds.studentA2 as string
const studentB = fixtureIds.studentB as string
const guardianA = fixtureIds.guardianA as string
const guardianA2 = fixtureIds.guardianA2 as string
const documentA = fixtureIds.documentA as string
const sectionA = fixtureIds.sectionA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string

// Rows this file owns. Fixtures carry no enrolment or assignment at all.
const sectionA2 = '10000000-0000-4000-8000-0000000009a1'
const subjectA = '10000000-0000-4000-8000-0000000009a2'
const teacherUser = '10000000-0000-4000-8000-0000000009a3'
const teacherMembership = '10000000-0000-4000-8000-0000000009a4'
const teacherStaff = '10000000-0000-4000-8000-0000000009a5'
const nextYear = '10000000-0000-4000-8000-0000000009a6'
const nextSection = '10000000-0000-4000-8000-0000000009a7'
const enrollmentA = '10000000-0000-4000-8000-0000000009b1'
const enrollmentA2 = '10000000-0000-4000-8000-0000000009b2'
const adminUser = '10000000-0000-4000-8000-0000000009a8'
const adminMembership = '10000000-0000-4000-8000-0000000009a9'

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let parent: Client
let teacher: Client
let admin: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function codeOf(response: Response): Promise<string> {
  return (await body<ErrorBody>(response)).error.code
}

async function seedModuleRows(): Promise<void> {
  const pool = adminPool()
  // The whole suite shares one database and this file asserts exact rosters,
  // so the enrolments of the fixture school start from the two rows below and
  // not from whatever an earlier module file left in place.
  await pool.query('DELETE FROM enrollments WHERE school_id = $1', [schoolA])
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'ST-B')
     ON CONFLICT (school_id,academic_year_id,grade_id,name) DO NOTHING`,
    [sectionA2, schoolA, yearA, gradeA],
  )
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,'2027-28','2027-04-01','2028-03-31','upcoming') ON CONFLICT (school_id,name) DO NOTHING`,
    [nextYear, schoolA],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A')
     ON CONFLICT (school_id,academic_year_id,grade_id,name) DO NOTHING`,
    [nextSection, schoolA, nextYear, gradeA],
  )
  await pool.query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Maths','MATH','scholastic')
     ON CONFLICT (school_id,code) DO NOTHING`,
    [subjectA, schoolA],
  )
  // Two current enrolments in different classes of the same year. Fixed
  // identifiers keep a second run of this file from stacking duplicates.
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES ($7,$1,$2,$3,$4,1,'2026-04-01'),($8,$1,$5,$3,$6,2,'2026-04-01')
     ON CONFLICT (id) DO UPDATE SET section_id = EXCLUDED.section_id, left_on = NULL, outcome = 'ongoing'`,
    [schoolA, studentA, yearA, sectionA, studentA2, sectionA2, enrollmentA, enrollmentA2],
  )
  // A teacher of 6A only, so the assigned sections scope has something to say.
  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'Section Teacher',$2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [teacherUser, TEACHER_EMAIL],
  )
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')
     ON CONFLICT (school_id,user_id) DO NOTHING`,
    [teacherMembership, schoolA, teacherUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'teacher' ON CONFLICT DO NOTHING`,
    [schoolA, teacherMembership],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,'SEC-A','Section','teaching','Teacher','active')
     ON CONFLICT (school_id,employee_code) DO NOTHING`,
    [teacherStaff, schoolA],
  )
  await pool.query(
    `INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)
     ON CONFLICT DO NOTHING`,
    [schoolA, teacherMembership, teacherStaff],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,'2026-04-01') ON CONFLICT DO NOTHING`,
    [schoolA, teacherStaff, yearA, sectionA, subjectA],
  )
  // Guardian A is stored as ten Indian digits, which the contract widens.
  await pool.query(`UPDATE guardians SET phone = '9876543210' WHERE id = $1`, [guardianA])
  await pool.query(`UPDATE guardians SET phone = '+919876500000' WHERE id = $1`, [guardianA2])
  // Both children share guardian A2, so they are siblings of each other.
  await pool.query(
    `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation)
     VALUES ($1,$2,$3,'mother') ON CONFLICT DO NOTHING`,
    [schoolA, studentA, guardianA2],
  )
  // An administrator: students.update_sensitive without students.read_medical.
  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'School Admin',$2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [adminUser, ADMIN_EMAIL],
  )
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')
     ON CONFLICT (school_id,user_id) DO NOTHING`,
    [adminMembership, schoolA, adminUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'admin' ON CONFLICT DO NOTHING`,
    [schoolA, adminMembership],
  )
  // This administrator may admit students but may not touch guardian records,
  // so admission cannot be used as a side door into an existing guardian.
  await pool.query(
    `DELETE FROM role_permissions WHERE school_id = $1 AND permission = 'students.manage_guardians'
       AND role_id IN (SELECT id FROM roles WHERE school_id = $1 AND key = 'admin')`,
    [schoolA],
  )
  // A parent who may follow sibling links but still reads only her own child.
  // Exceptions cannot carry this key, so the parent role itself grants it.
  await pool.query(
    `INSERT INTO role_permissions(school_id,role_id,permission,scope)
     SELECT $1,id,'students.read_siblings','own_children' FROM roles WHERE school_id = $1 AND key = 'parent'
     ON CONFLICT DO NOTHING`,
    [schoolA],
  )
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [parentUserId, PARENT_EMAIL])
  await seedModuleRows()
  await setFixturePassword(server, parentUserId, PASSWORD)
  await setFixturePassword(server, teacherUser, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
  admin = await signInWithMfa(server, { userId: adminUser, email: ADMIN_EMAIL, password: PASSWORD })
})

after(async () => {
  const pool = adminPool()
  for (const userId of [ownerUserId, adminUser]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  await server.close()
  await closeAdminPool()
})

interface Basic {
  id: string
  schoolId: string
  version: number
  firstName: string
  admissionNumber: string
  status: string
  enrollment?: { id: string; section: { id: string; name: string }; rollNumber?: number }
}
interface Roster {
  items: Basic[]
  total: number
  page: number
  pageSize: number
}
interface Detail {
  student: Basic
  sensitive?: Record<string, unknown>
  medical?: Record<string, unknown>
  guardianContacts?: { id: string; phone: string; relation: string; displayName: string }[]
  allowedActions: string[]
}

test('the roster and a student detail need a session', async () => {
  const list = await fetch(`${server.origin}/api/schools/${schoolA}/students`)
  assert.equal(list.status, 401)
  assert.equal(await codeOf(list), 'AUTHENTICATION_REQUIRED')
  const detail = await fetch(`${server.origin}/api/schools/${schoolA}/students/${studentA}`)
  assert.equal(detail.status, 401)
  assert.equal(await codeOf(detail), 'AUTHENTICATION_REQUIRED')
})

test('a member of one school may not use another school in the path', async () => {
  const list = await owner.fetch(`/api/schools/${schoolB}/students`)
  assert.equal(list.status, 403)
  assert.equal(await codeOf(list), 'SCHOOL_ACCESS_UNAVAILABLE')
  const detail = await owner.fetch(`/api/schools/${schoolB}/students/${studentB}`)
  assert.equal(detail.status, 403)
  assert.equal(await codeOf(detail), 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('another school\'s student is simply not there', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/students/${studentB}`)
  assert.equal(response.status, 404)
  const text = await response.text()
  assert.equal(JSON.parse(text).error.code, 'RESOURCE_NOT_FOUND')
  assert.equal(text.includes('FIX-B1'), false)
})

test('a teacher reads the class she teaches and nothing beside it', async () => {
  const list = await teacher.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal(list.status, 200)
  const roster = await body<Roster>(list)
  const ids = roster.items.map((item) => item.id)
  assert.ok(ids.includes(studentA))
  assert.equal(ids.includes(studentA2), false)
  assert.equal(roster.total, roster.items.length)

  const detail = await teacher.fetch(`/api/schools/${schoolA}/students/${studentA}`)
  assert.equal(detail.status, 200)
  const seen = await body<Detail>(detail)
  assert.equal(seen.student.id, studentA)
  assert.equal(seen.student.enrollment?.section.id, sectionA)
  // Restricted blocks belong to other keys and are absent for a teacher.
  assert.equal('sensitive' in seen, false)
  assert.equal('medical' in seen, false)
  assert.ok(seen.guardianContacts && seen.guardianContacts.length > 0)
  assert.equal(seen.guardianContacts[0]?.phone.startsWith('+91'), true)

  const other = await teacher.fetch(`/api/schools/${schoolA}/students/${studentA2}`)
  assert.equal(other.status, 404)
  assert.equal(await codeOf(other), 'RESOURCE_NOT_FOUND')
})

test('a parent reads her own child only', async () => {
  const list = await parent.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal(list.status, 200)
  const roster = await body<Roster>(list)
  assert.deepEqual(roster.items.map((item) => item.id), [studentA2])

  const mine = await parent.fetch(`/api/schools/${schoolA}/students/${studentA2}`)
  assert.equal(mine.status, 200)
  const other = await parent.fetch(`/api/schools/${schoolA}/students/${studentA}`)
  assert.equal(other.status, 404)
  assert.equal(await codeOf(other), 'RESOURCE_NOT_FOUND')
})

test('the count and the search answer over the same authorized rows', async () => {
  const counted = await teacher.fetch(`/api/schools/${schoolA}/students/count`)
  assert.equal(counted.status, 200)
  const list = await teacher.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal((await body<{ count: number }>(counted)).count, (await body<Roster>(list)).total)

  const search = await teacher.fetch(`/api/schools/${schoolA}/students/search?q=Student`)
  assert.equal(search.status, 200)
  const hits = await body<Basic[]>(search)
  assert.ok(hits.length <= 20)
  assert.equal(hits.some((hit) => hit.id === studentA2), false)

  const filtered = await owner.fetch(`/api/schools/${schoolA}/students?sectionId=${sectionA2}&pageSize=100`)
  assert.deepEqual((await body<Roster>(filtered)).items.map((item) => item.id), [studentA2])
})

test('a sibling link never widens what a caller may read', async () => {
  const response = await parent.fetch(`/api/schools/${schoolA}/students/${studentA2}/siblings`)
  assert.equal(response.status, 200)
  // Student A shares a guardian but is not this parent's child, so the list is empty.
  assert.deepEqual(await body<Basic[]>(response), [])

  const owned = await owner.fetch(`/api/schools/${schoolA}/students/${studentA2}/siblings`)
  assert.deepEqual((await body<Basic[]>(owned)).map((item) => item.id), [studentA])
})

test('document metadata never carries a storage key or a link', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/students/${studentA}/documents`)
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.equal(text.includes('fixtures/a.pdf'), false)
  assert.equal(text.includes('storage'), false)
  const documents = JSON.parse(text) as { id: string; allowedActions: string[] }[]
  // Other suites add documents for this student, so find the fixture one.
  const fixture = documents.find((document) => document.id === documentA)
  assert.ok(fixture, 'the fixture document is listed')
  assert.ok(fixture.allowedActions.includes('students.read_documents'))
})

test('guardian and enrolment lists answer only for a visible student', async () => {
  const guardians = await owner.fetch(`/api/schools/${schoolA}/students/${studentA}/guardians`)
  assert.equal(guardians.status, 200)
  const rows = await body<{ id: string; phone: string }[]>(guardians)
  assert.ok(rows.some((row) => row.id === guardianA && row.phone === '+919876543210'))

  const hidden = await owner.fetch(`/api/schools/${schoolA}/students/${studentB}/guardians`)
  assert.equal(hidden.status, 404)

  const enrolments = await teacher.fetch(`/api/schools/${schoolA}/students/${studentA}/enrollments`)
  assert.equal(enrolments.status, 200)
  const summaries = await body<{ section: { id: string } }[]>(enrolments)
  assert.deepEqual(summaries.map((row) => row.section.id), [sectionA])

  const denied = await teacher.fetch(`/api/schools/${schoolA}/students/${studentA2}/enrollments`)
  assert.equal(denied.status, 404)
})

async function admit(extra: Record<string, unknown> = {}): Promise<Response> {
  return owner.fetch(`/api/schools/${schoolA}/students`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'New',
      lastName: 'Child',
      admissionNumber: `ADM-${randomUUID().slice(0, 8)}`,
      dateOfBirth: '2015-06-01',
      gender: 'female',
      admissionDate: '2026-04-01',
      sectionId: sectionA,
      rollNumber: 12,
      guardians: [
        {
          guardian: { firstName: 'New', lastName: 'Parent', phone: '+919812345678' },
          relation: 'father',
          isPrimary: true,
        },
      ],
      ...extra,
    }),
  })
}

test('admission rejects a body that reaches past its permission', async () => {
  const pool = adminPool()
  const before = await pool.query('SELECT count(*)::int AS total FROM students WHERE school_id = $1', [schoolA])
  for (const forbidden of [{ schoolId: schoolB }, { monthlySalary: 90000 }, { status: 'alumni' }, { roleKeys: ['owner'] }]) {
    const response = await admit(forbidden)
    assert.equal(response.status, 400, JSON.stringify(forbidden))
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }
  const after = await pool.query('SELECT count(*)::int AS total FROM students WHERE school_id = $1', [schoolA])
  assert.equal(after.rows[0].total, before.rows[0].total)
})

test('admission writes the student, the enrolment, the guardian and one audit row', async () => {
  const response = await admit()
  assert.equal(response.status, 201)
  const created = await body<Basic>(response)
  assert.equal(created.schoolId, schoolA)
  assert.equal(created.enrollment?.section.id, sectionA)
  assert.equal(created.enrollment?.rollNumber, 12)
  assert.deepEqual(Object.keys(created).sort(), [
    'admissionNumber', 'enrollment', 'firstName', 'id', 'lastName', 'schoolId', 'status', 'version',
  ])

  const pool = adminPool()
  const audits = await pool.query(
    `SELECT summary FROM audit_events WHERE school_id = $1 AND target_id = $2 AND action = 'students.create'`,
    [schoolA, created.id],
  )
  assert.equal(audits.rowCount, 1)
  const links = await pool.query(
    'SELECT guardian_id FROM student_guardians WHERE school_id = $1 AND student_id = $2',
    [schoolA, created.id],
  )
  assert.equal(links.rowCount, 1)

  // A section of the other school is a rejected request, not a broken write.
  const wrongSection = await admit({ sectionId: '20000000-0000-4000-8000-000000000062' })
  assert.equal(wrongSection.status, 400)
})

test('the restricted block is written and read only with its own keys', async () => {
  const created = await body<Basic>(await admit())
  const update = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: created.version,
      category: 'general',
      address: '12 Test Road',
      medicalNotes: 'Peanut allergy',
    }),
  })
  assert.equal(update.status, 200)

  const detail = await body<Detail>(await owner.fetch(`/api/schools/${schoolA}/students/${created.id}`))
  assert.equal(detail.sensitive?.address, '12 Test Road')
  assert.equal(detail.medical?.medicalNotes, 'Peanut allergy')

  const stale = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, category: 'general' }),
  })
  assert.equal(stale.status, 409)
  assert.equal(await codeOf(stale), 'VERSION_CONFLICT')

  const forbidden = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 2, schoolId: schoolB, category: 'other' }),
  })
  assert.equal(forbidden.status, 400)
  assert.equal(await codeOf(forbidden), 'INVALID_REQUEST')
})

test('the basic update changes names only', async () => {
  const created = await body<Basic>(await admit())
  const response = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, firstName: 'Renamed' }),
  })
  assert.equal(response.status, 200)
  assert.equal((await body<Basic>(response)).firstName, 'Renamed')

  const rejected = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 2, firstName: 'Renamed', admissionNumber: 'HACK-1' }),
  })
  assert.equal(rejected.status, 400)
  const stored = await adminPool().query('SELECT admission_number FROM students WHERE id = $1', [created.id])
  assert.equal(stored.rows[0].admission_number, created.admissionNumber)
})

test('a move stays inside the academic year and a leave ends the enrolment', async () => {
  const created = await body<Basic>(await admit())
  const across = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, sectionId: nextSection, reason: 'Across years' }),
  })
  assert.equal(across.status, 400)
  assert.equal(await codeOf(across), 'INVALID_REQUEST')

  const moved = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, sectionId: sectionA2, rollNumber: 7, reason: 'Class balance' }),
  })
  assert.equal(moved.status, 204)
  const afterMove = await body<Detail>(await owner.fetch(`/api/schools/${schoolA}/students/${created.id}`))
  assert.equal(afterMove.student.enrollment?.section.id, sectionA2)
  assert.equal(afterMove.student.enrollment?.rollNumber, 7)

  const left = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/leave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: afterMove.student.version, leftOn: '2026-09-01', reason: 'Family moved city' }),
  })
  assert.equal(left.status, 204)
  const stored = await adminPool().query(
    `SELECT s.status, e.outcome, e.left_on::text AS left_on FROM students s
       JOIN enrollments e ON e.student_id = s.id WHERE s.id = $1`,
    [created.id],
  )
  assert.equal(stored.rows[0].status, 'left')
  assert.equal(stored.rows[0].outcome, 'left')
  assert.equal(stored.rows[0].left_on, '2026-09-01')
})

test('guardians are linked and edited through their own permission', async () => {
  const created = await body<Basic>(await admit())
  const added = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/guardians`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId: guardianA, relation: 'guardian', isPrimary: false }),
  })
  assert.equal(added.status, 201)
  const guardian = await body<{ id: string; version?: number; phone: string }>(added)
  assert.equal(guardian.id, guardianA)
  assert.equal(guardian.phone, '+919876543210')
  assert.equal('version' in guardian, false)

  const version = (await adminPool().query('SELECT version FROM guardians WHERE id = $1', [guardianA]))
    .rows[0].version as number
  const updated = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/guardians/${guardianA}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: version, occupation: 'Engineer', relation: 'father' }),
  })
  assert.equal(updated.status, 200)
  assert.equal((await body<{ occupation: string }>(updated)).occupation, 'Engineer')

  const forbidden = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/guardians/${guardianA}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: version + 1, annualIncome: 100000 }),
  })
  assert.equal(forbidden.status, 400)
  assert.equal(await codeOf(forbidden), 'INVALID_REQUEST')
  const income = await adminPool().query('SELECT annual_income FROM guardians WHERE id = $1', [guardianA])
  assert.equal(income.rows[0].annual_income, null)

  // A guardian of the other school can never be linked here.
  const crossSchool = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/guardians`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ guardianId: fixtureIds.guardianB, relation: 'guardian', isPrimary: false }),
  })
  assert.equal(crossSchool.status, 404)
})

test('a teacher may not admit, edit or move a student', async () => {
  for (const [path, method, payload] of [
    [`/api/schools/${schoolA}/students`, 'POST', { firstName: 'X' }],
    [`/api/schools/${schoolA}/students/${studentA}`, 'PUT', { expectedVersion: 1, firstName: 'X' }],
    [`/api/schools/${schoolA}/students/${studentA}/move`, 'POST', { expectedVersion: 1, sectionId: sectionA2, reason: 'no' }],
  ] as const) {
    const response = await teacher.fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(response.status, 403, path)
    assert.equal(await codeOf(response), 'ACCESS_DENIED')
  }
})

test('a second open enrolment never leaks a class the caller may not read', async () => {
  const pool = adminPool()
  const extra = '10000000-0000-4000-8000-0000000009c1'
  // Student A is now also open in 6B, which this teacher does not teach. The
  // newest open enrolment must not become the class shown on her roster.
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES ($1,$2,$3,$4,$5,99,'2026-06-01')
     ON CONFLICT (id) DO UPDATE SET section_id = EXCLUDED.section_id, left_on = NULL`,
    [extra, schoolA, studentA, yearA, sectionA2],
  )
  try {
    const detail = await body<Detail>(await teacher.fetch(`/api/schools/${schoolA}/students/${studentA}`))
    assert.equal(detail.student.enrollment?.section.id, sectionA)
    assert.equal(detail.student.enrollment?.rollNumber, 1)
    const roster = await body<Roster>(await teacher.fetch(`/api/schools/${schoolA}/students?pageSize=100`))
    assert.equal(roster.items.find((item) => item.id === studentA)?.enrollment?.section.id, sectionA)
    // The enrolment list is the same answer, which is the point of the check.
    const summaries = await body<{ section: { id: string } }[]>(
      await teacher.fetch(`/api/schools/${schoolA}/students/${studentA}/enrollments`),
    )
    assert.deepEqual(summaries.map((row) => row.section.id), [sectionA])
  } finally {
    await pool.query('DELETE FROM enrollments WHERE id = $1', [extra])
  }
})

test('a leave before the enrolment began is a bad request, not a broken service', async () => {
  const created = await body<Basic>(await admit())
  const response = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/leave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, leftOn: '2026-01-01', reason: 'Too early' }),
  })
  assert.equal(response.status, 400)
  assert.equal(await codeOf(response), 'INVALID_REQUEST')
  const stored = await adminPool().query(
    'SELECT status, version, left_reason FROM students WHERE id = $1',
    [created.id],
  )
  assert.equal(stored.rows[0].status, 'active')
  assert.equal(stored.rows[0].version, created.version)
  assert.equal(stored.rows[0].left_reason, null)
})

test('a move without a roll number keeps the one the student has', async () => {
  const created = await body<Basic>(await admit())
  assert.equal(created.enrollment?.rollNumber, 12)
  const moved = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, sectionId: sectionA2, reason: 'Class balance' }),
  })
  assert.equal(moved.status, 204)
  const detail = await body<Detail>(await owner.fetch(`/api/schools/${schoolA}/students/${created.id}`))
  assert.equal(detail.student.enrollment?.section.id, sectionA2)
  assert.equal(detail.student.enrollment?.rollNumber, 12)

  // The stated justification survives on the audit row and, for a leave, on
  // the record itself.
  const moveAudit = await adminPool().query(
    `SELECT safe_changes FROM audit_events WHERE school_id = $1 AND target_type = 'enrollment'
       AND action = 'students.manage_enrollment' AND safe_changes->>'toSectionId' = $2
     ORDER BY created_at DESC LIMIT 1`,
    [schoolA, sectionA2],
  )
  assert.equal(moveAudit.rows[0].safe_changes.reason, 'Class balance')

  const left = await owner.fetch(`/api/schools/${schoolA}/students/${created.id}/leave`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: detail.student.version, leftOn: '2026-09-01', reason: 'Family moved city' }),
  })
  assert.equal(left.status, 204)
  const stored = await adminPool().query('SELECT left_reason FROM students WHERE id = $1', [created.id])
  assert.equal(stored.rows[0].left_reason, 'Family moved city')
})

test('a health field may not be written by an editor who may not read it', async () => {
  // The administrator role carries students.update_sensitive but not
  // students.read_medical, which is exactly the branch under test.
  const created = await body<Basic>(await admit())
  const denied = await admin.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, medicalNotes: 'Peanut allergy' }),
  })
  assert.equal(denied.status, 403)
  assert.equal(await codeOf(denied), 'ACCESS_DENIED')
  const stored = await adminPool().query(
    'SELECT medical_notes, version FROM students WHERE id = $1',
    [created.id],
  )
  assert.equal(stored.rows[0].medical_notes, null)
  assert.equal(stored.rows[0].version, created.version)

  // The rest of the restricted block is a different key and still writes.
  const allowed = await admin.fetch(`/api/schools/${schoolA}/students/${created.id}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: created.version, category: 'general' }),
  })
  assert.equal(allowed.status, 200)
  // A detail read for the same caller carries no medical block either.
  const detail = await body<Detail>(await admin.fetch(`/api/schools/${schoolA}/students/${created.id}`))
  assert.equal('medical' in detail, false)
})

test('a student has at most one primary guardian', async () => {
  const created = await body<Basic>(await admit({
    guardians: [
      { guardian: { firstName: 'First', phone: '+919812345671' }, relation: 'father', isPrimary: true },
      { guardian: { firstName: 'Second', phone: '+919812345672' }, relation: 'mother', isPrimary: true },
    ],
  }))
  const counted = await adminPool().query(
    'SELECT count(*)::int AS total FROM student_guardians WHERE student_id = $1 AND is_primary',
    [created.id],
  )
  assert.equal(counted.rows[0].total, 1)
})

test('admission may not attach an existing guardian without the guardian key', async () => {
  const pool = adminPool()
  const admissionNumber = `ADM-${randomUUID().slice(0, 8)}`
  const response = await admin.fetch(`/api/schools/${schoolA}/students`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Side',
      admissionNumber,
      dateOfBirth: '2015-06-01',
      gender: 'male',
      admissionDate: '2026-04-01',
      sectionId: sectionA,
      guardians: [{ guardianId: guardianA, relation: 'father' }],
    }),
  })
  assert.equal(response.status, 403)
  assert.equal(await codeOf(response), 'ACCESS_DENIED')
  const stored = await pool.query('SELECT id FROM students WHERE school_id = $1 AND admission_number = $2', [
    schoolA,
    admissionNumber,
  ])
  assert.equal(stored.rowCount, 0)
})
