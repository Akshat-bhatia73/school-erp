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
const OWNER_EMAIL = `setup-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `setup-teacher-${randomUUID()}@example.test`
const PARENT_EMAIL = `setup-parent-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const teacherUserId = fixtureIds.adultUser as string
const parentUserId = fixtureIds.parentA2User as string
const staffA = fixtureIds.staffA as string
const studentA = fixtureIds.studentA as string
const studentA2 = fixtureIds.studentA2 as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const sectionA = fixtureIds.sectionA as string

// Rows this run owns. Fresh ids keep every assertion exact even though the
// fixture school is shared with the other suites in this database.
const otherGrade = randomUUID()
const otherSection = randomUUID()
const subjectA = randomUUID()
const yearB = randomUUID()
const gradeB = randomUUID()
const sectionB = randomUUID()
const subjectB = randomUUID()
// A year that has already been closed by promotion, with its own section.
const closedYear = randomUUID()
const closedSection = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let teacher: Client
let parent: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}
interface GradeItem {
  id: string
  schoolId: string
  name: string
  shortName: string
  order: number
  stream?: string
  version: number
}
interface SectionItem {
  id: string
  name: string
  gradeId: string
  academicYearId: string
  version: number
  capacity?: number
}
interface YearItem {
  id: string
  name: string
  startDate: string
  endDate: string
  status: string
  version: number
}
interface HolidayItem {
  id: string
  academicYearId: string
  name: string
  startDate: string
  endDate: string
  type: string
  version: number
}

function body(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }
}
function put(value: unknown): RequestInit {
  return { ...body(value), method: 'PUT' }
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [teacherUserId, TEACHER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [parentUserId, PARENT_EMAIL])

  // School A: a second class and section nobody teaches, one subject, and a
  // teaching assignment that puts the teacher in the fixture section only.
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,'7',7)`,
    [otherGrade, schoolA, `Seven ${otherGrade.slice(0, 8)}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [otherSection, schoolA, yearA, otherGrade, `X${otherSection.slice(0, 4)}`],
  )
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
    subjectA,
    schoolA,
    `Maths ${subjectA.slice(0, 8)}`,
    `M-${subjectA.slice(0, 8)}`,
  ])
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,'2020-01-01')`,
    [schoolA, staffA, yearA, sectionA, subjectA],
  )
  // Exactly one current enrollment in the fixture section, however often this
  // suite has run against this database before.
  await pool.query('DELETE FROM enrollments WHERE school_id = $1 AND section_id = $2', [schoolA, sectionA])
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on)
     VALUES ($1,$2,$3,$4,'2026-04-01')`,
    [schoolA, studentA, yearA, sectionA],
  )

  // A year that has been closed, holding one pupil who finished it there and
  // one who left part way through.
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,'2025-04-01','2026-03-31','closed')`,
    [closedYear, schoolA, `2025-26 ${closedYear.slice(0, 8)}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [closedSection, schoolA, closedYear, gradeA, `C${closedSection.slice(0, 4)}`],
  )
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on,left_on,outcome)
     VALUES ($1,$2,$3,$4,'2025-04-01','2026-03-31','promoted'),
            ($1,$5,$3,$4,'2025-04-01','2025-09-30','left')`,
    [schoolA, studentA, closedYear, closedSection, studentA2],
  )

  // School B: a complete little setup, so a cross-school id is a real record.
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,'2026-04-01','2027-03-31','current')`,
    [yearB, schoolB, `2026-27 ${yearB.slice(0, 8)}`],
  )
  await pool.query(`INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,'6',6)`, [
    gradeB,
    schoolB,
    `Six ${gradeB.slice(0, 8)}`,
  ])
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'B')`,
    [sectionB, schoolB, yearB, gradeB],
  )
  await pool.query(`INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,$3,$4,'scholastic')`, [
    subjectB,
    schoolB,
    `Maths ${subjectB.slice(0, 8)}`,
    `M-${subjectB.slice(0, 8)}`,
  ])

  await setFixturePassword(server, teacherUserId, PASSWORD)
  await setFixturePassword(server, parentUserId, PASSWORD)
  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [ownerUserId])
  await server.close()
  await closeAdminPool()
})

test('a setup list needs a session and a membership in the school in the path', async () => {
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/sections`)
  assert.equal(anonymous.status, 401)
  assert.equal(((await anonymous.json()) as ErrorBody).error.code, 'AUTHENTICATION_REQUIRED')

  const anonymousDetail = await fetch(`${server.origin}/api/schools/${schoolA}/sections/${sectionA}`)
  assert.equal(anonymousDetail.status, 401)

  const other = await owner.fetch(`/api/schools/${schoolB}/sections`)
  assert.equal(other.status, 403)
  assert.equal(((await other.json()) as ErrorBody).error.code, 'SCHOOL_ACCESS_UNAVAILABLE')

  const otherDetail = await owner.fetch(`/api/schools/${schoolB}/sections/${sectionB}`)
  assert.equal(otherDetail.status, 403)
})

test('another school record asked for through this school is simply not there', async () => {
  const section = await owner.fetch(`/api/schools/${schoolA}/sections/${sectionB}`)
  assert.equal(section.status, 404)
  const text = await section.text()
  assert.equal(JSON.parse(text).error.code, 'RESOURCE_NOT_FOUND')
  assert.equal(text.includes(gradeB), false)

  const list = (await (await owner.fetch(`/api/schools/${schoolA}/sections`)).json()) as SectionItem[]
  assert.equal(
    list.some((item) => item.id === sectionB),
    false,
  )
})

test('a teacher sees only the sections they are assigned to', async () => {
  const list = (await (await teacher.fetch(`/api/schools/${schoolA}/sections`)).json()) as SectionItem[]
  assert.equal(
    list.some((item) => item.id === sectionA),
    true,
  )
  assert.equal(
    list.some((item) => item.id === otherSection),
    false,
  )

  const allowed = await teacher.fetch(`/api/schools/${schoolA}/sections/${sectionA}`)
  assert.equal(allowed.status, 200)
  const refused = await teacher.fetch(`/api/schools/${schoolA}/sections/${otherSection}`)
  assert.equal(refused.status, 404)
  assert.equal(((await refused.json()) as ErrorBody).error.code, 'RESOURCE_NOT_FOUND')
})

test('the school profile reads and updates through its own contract only', async () => {
  const read = await owner.fetch(`/api/schools/${schoolA}/school`)
  assert.equal(read.status, 200)
  const profile = (await read.json()) as Record<string, unknown>
  const allowed = [
    'id',
    'name',
    'shortName',
    'board',
    'address',
    'phone',
    'email',
    'affiliationNumber',
    'udiseCode',
    'version',
  ]
  assert.equal(
    Object.keys(profile).every((key) => allowed.includes(key)),
    true,
  )
  assert.equal(typeof profile.version, 'number')

  const saved = await owner.fetch(
    `/api/schools/${schoolA}/school`,
    put({
      name: 'Fixture A',
      shortName: 'A',
      board: 'cbse',
      address: '12 Nehru Road, Pune',
      phone: '+919876543210',
      email: 'office@fixture-a.test',
      expectedVersion: profile.version as number,
    }),
  )
  assert.equal(saved.status, 200)
  const updated = (await saved.json()) as Record<string, unknown>
  assert.equal(updated.address, '12 Nehru Road, Pune')
  assert.equal(updated.board, 'cbse')

  assert.notEqual(updated.version, profile.version)

  // The second editor was looking at the profile before the save above, so
  // their save is refused instead of quietly overwriting it.
  const stale = await owner.fetch(
    `/api/schools/${schoolA}/school`,
    put({
      name: 'Renamed by the loser',
      shortName: 'A',
      board: 'cbse',
      address: '12 Nehru Road, Pune',
      phone: '+919876543210',
      email: 'office@fixture-a.test',
      expectedVersion: profile.version as number,
    }),
  )
  assert.equal(stale.status, 409)
  assert.equal(((await stale.json()) as ErrorBody).error.code, 'VERSION_CONFLICT')
  const stored = await adminPool().query<{ name: string }>('SELECT name FROM schools WHERE id = $1', [schoolA])
  assert.equal(stored.rows[0]?.name, 'Fixture A')
})

test('a profile update that names a field it may not set is refused', async () => {
  const before = await adminPool().query<{ name: string }>('SELECT name FROM schools WHERE id = $1', [schoolA])
  const response = await owner.fetch(
    `/api/schools/${schoolA}/school`,
    put({
      schoolId: schoolB,
      name: 'Sneaky',
      shortName: 'S',
      board: 'cbse',
      address: 'x',
      phone: '+919876543210',
      email: 'office@fixture-a.test',
      expectedVersion: 1,
    }),
  )
  assert.equal(response.status, 400)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
  const after = await adminPool().query<{ name: string }>('SELECT name FROM schools WHERE id = $1', [schoolA])
  assert.equal(after.rows[0]?.name, before.rows[0]?.name)
})

test('classes are created, updated and only removed when nothing refers to them', async () => {
  const name = `Nine ${randomUUID().slice(0, 8)}`
  const created = await owner.fetch(
    `/api/schools/${schoolA}/grades`,
    body({ name, shortName: '9', order: 9 }),
  )
  assert.equal(created.status, 201)
  const grade = (await created.json()) as GradeItem
  assert.equal(grade.version, 1)
  assert.equal('stream' in grade, false)

  const updated = await owner.fetch(
    `/api/schools/${schoolA}/grades/${grade.id}`,
    put({ name, shortName: 'IX', order: 9, stream: 'science', expectedVersion: 1 }),
  )
  assert.equal(updated.status, 200)
  assert.equal(((await updated.json()) as GradeItem).version, 2)

  const stale = await owner.fetch(
    `/api/schools/${schoolA}/grades/${grade.id}`,
    put({ name, shortName: 'IX', order: 9, expectedVersion: 1 }),
  )
  assert.equal(stale.status, 409)

  // The fixture class holds a section, so it cannot simply disappear.
  const refused = await owner.fetch(`/api/schools/${schoolA}/grades/${gradeA}`, { method: 'DELETE' })
  assert.equal(refused.status, 400)
  assert.equal(((await refused.json()) as ErrorBody).error.code, 'INVALID_REQUEST')

  const removed = await owner.fetch(`/api/schools/${schoolA}/grades/${grade.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 204)
  const gone = await adminPool().query('SELECT 1 FROM grades WHERE id = $1', [grade.id])
  assert.equal(gone.rowCount, 0)
})

test('a class body that names a forbidden field changes nothing', async () => {
  const before = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM grades WHERE school_id = $1',
    [schoolA],
  )
  const response = await owner.fetch(
    `/api/schools/${schoolA}/grades`,
    body({ schoolId: schoolB, name: 'Ten', shortName: '10', order: 10 }),
  )
  assert.equal(response.status, 400)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
  const after = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM grades WHERE school_id = $1',
    [schoolA],
  )
  assert.equal(after.rows[0]?.total, before.rows[0]?.total)
})

test('a section names a class, a year and a teacher of this school only', async () => {
  const created = await owner.fetch(
    `/api/schools/${schoolA}/sections`,
    body({
      gradeId: otherGrade,
      academicYearId: yearA,
      name: `S${randomUUID().slice(0, 4)}`,
      classTeacherId: staffA,
      capacity: 30,
    }),
  )
  assert.equal(created.status, 201)
  const section = (await created.json()) as SectionItem
  assert.equal(section.capacity, 30)

  const foreignTeacher = await owner.fetch(
    `/api/schools/${schoolA}/sections`,
    body({ gradeId: gradeB, academicYearId: yearA, name: 'Z' }),
  )
  assert.equal(foreignTeacher.status, 400)
  assert.equal(((await foreignTeacher.json()) as ErrorBody).error.code, 'INVALID_REQUEST')

  const withSalary = await owner.fetch(
    `/api/schools/${schoolA}/sections`,
    body({ gradeId: otherGrade, academicYearId: yearA, name: 'Y', monthlySalary: 1 }),
  )
  assert.equal(withSalary.status, 400)

  const removed = await owner.fetch(`/api/schools/${schoolA}/sections/${section.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 204)

  // The fixture section holds a pupil, so removing it is refused instead.
  const refused = await owner.fetch(`/api/schools/${schoolA}/sections/${sectionA}`, { method: 'DELETE' })
  assert.equal(refused.status, 400)
  const still = await adminPool().query('SELECT 1 FROM sections WHERE id = $1', [sectionA])
  assert.equal(still.rowCount, 1)
})

test('section strengths count only pupils in sections the caller may see', async () => {
  const response = await teacher.fetch(`/api/schools/${schoolA}/sections/strengths?academicYearId=${yearA}`)
  assert.equal(response.status, 200)
  const counts = (await response.json()) as { sectionId: string; count: number }[]
  const mine = counts.find((row) => row.sectionId === sectionA)
  assert.equal(mine?.count, 1)
  assert.equal(
    counts.some((row) => row.sectionId === otherSection),
    false,
  )
})

test('a closed year still counts the pupils who finished it, but not one who left', async () => {
  const response = await owner.fetch(
    `/api/schools/${schoolA}/sections/strengths?academicYearId=${closedYear}`,
  )
  assert.equal(response.status, 200)
  const counts = (await response.json()) as { sectionId: string; count: number }[]
  assert.equal(counts.find((row) => row.sectionId === closedSection)?.count, 1)
})

test('every member can ask which academic year the school is in now', async () => {
  const pointer = await adminPool().query<{ id: string | null }>(
    'SELECT current_academic_year_id AS id FROM schools WHERE id = $1',
    [schoolA],
  )
  const expected = pointer.rows[0]?.id ?? null

  for (const client of [teacher, parent]) {
    const response = await client.fetch(`/api/schools/${schoolA}/academic-years/current`)
    assert.equal(response.status, 200)
    const year = (await response.json()) as YearItem | null
    assert.notEqual(year, null)
    if (expected) assert.equal(year?.id, expected)
  }

  // The year list is a setup read and stays behind academic_years.read.
  const listed = await teacher.fetch(`/api/schools/${schoolA}/academic-years`)
  assert.equal(listed.status, 403)
  assert.equal(((await listed.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  // No session and no membership are both still refused.
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/academic-years/current`)
  assert.equal(anonymous.status, 401)
  const outsider = await teacher.fetch(`/api/schools/${schoolB}/academic-years/current`)
  assert.equal(outsider.status, 403)
  assert.equal(((await outsider.json()) as ErrorBody).error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('exactly one academic year is current', async () => {
  const suffix = randomUUID().slice(0, 8)
  const upcoming = await owner.fetch(
    `/api/schools/${schoolA}/academic-years`,
    body({ name: `2028-29 ${suffix}`, startDate: '2028-04-01', endDate: '2029-03-31', status: 'upcoming' }),
  )
  assert.equal(upcoming.status, 201)
  const later = (await upcoming.json()) as YearItem
  assert.equal(later.startDate, '2028-04-01')
  assert.equal(later.version, 1)

  const created = await owner.fetch(
    `/api/schools/${schoolA}/academic-years`,
    body({ name: `2027-28 ${suffix}`, startDate: '2027-04-01', endDate: '2028-03-31', status: 'current' }),
  )
  assert.equal(created.status, 201)
  const year = (await created.json()) as YearItem
  assert.equal(year.status, 'current')

  const current = (await (
    await owner.fetch(`/api/schools/${schoolA}/academic-years/current`)
  ).json()) as YearItem | null
  assert.equal(current?.id, year.id)

  // Moving current to another year closes the one that held it.
  const moved = await owner.fetch(
    `/api/schools/${schoolA}/academic-years/${later.id}`,
    put({
      name: `2028-29 ${suffix}`,
      startDate: '2028-04-01',
      endDate: '2029-03-31',
      status: 'current',
      expectedVersion: 1,
    }),
  )
  assert.equal(moved.status, 200)
  const closed = await adminPool().query<{ status: string }>(
    'SELECT status FROM academic_years WHERE id = $1',
    [year.id],
  )
  assert.equal(closed.rows[0]?.status, 'closed')
  const currents = await adminPool().query<{ total: string }>(
    `SELECT count(*) AS total FROM academic_years WHERE school_id = $1 AND status = 'current'`,
    [schoolA],
  )
  assert.equal(currents.rows[0]?.total, '1')

  const listed = (await (
    await owner.fetch(`/api/schools/${schoolA}/academic-years`)
  ).json()) as YearItem[]
  assert.equal(
    listed.some((item) => item.id === later.id && item.status === 'current'),
    true,
  )
})

test('subjects are mapped to a class as a whole set, and one bad id rejects it', async () => {
  const before = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM grade_subjects WHERE school_id = $1 AND grade_id = $2',
    [schoolA, gradeA],
  )
  const rejected = await owner.fetch(
    `/api/schools/${schoolA}/grades/${gradeA}/subjects`,
    put({ academicYearId: yearA, subjectIds: [subjectA, subjectB] }),
  )
  assert.equal(rejected.status, 400)
  assert.equal(((await rejected.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
  const after = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM grade_subjects WHERE school_id = $1 AND grade_id = $2',
    [schoolA, gradeA],
  )
  assert.equal(after.rows[0]?.total, before.rows[0]?.total)

  const saved = await owner.fetch(
    `/api/schools/${schoolA}/grades/${gradeA}/subjects`,
    put({ academicYearId: yearA, subjectIds: [subjectA] }),
  )
  assert.equal(saved.status, 200)
  const mapping = (await saved.json()) as { gradeId: string; subject: { id: string; name: string } }[]
  assert.equal(mapping.length, 1)
  assert.equal(mapping[0]?.subject.id, subjectA)

  const listed = (await (
    await owner.fetch(`/api/schools/${schoolA}/grade-subjects?academicYearId=${yearA}&gradeId=${gradeA}`)
  ).json()) as { subject: { id: string } }[]
  assert.equal(listed.length, 1)
  assert.equal(listed[0]?.subject.id, subjectA)

  // A subject a class still studies cannot be deleted.
  const refused = await owner.fetch(`/api/schools/${schoolA}/subjects/${subjectA}`, { method: 'DELETE' })
  assert.equal(refused.status, 400)
})

test('holidays are created, updated and removed against a year of this school', async () => {
  const created = await owner.fetch(
    `/api/schools/${schoolA}/holidays`,
    body({
      academicYearId: yearA,
      name: 'Diwali',
      startDate: '2026-11-08',
      endDate: '2026-11-12',
      type: 'festival',
    }),
  )
  assert.equal(created.status, 201)
  const holiday = (await created.json()) as HolidayItem
  assert.equal(holiday.startDate, '2026-11-08')

  const foreign = await owner.fetch(
    `/api/schools/${schoolA}/holidays`,
    body({
      academicYearId: yearB,
      name: 'Elsewhere',
      startDate: '2026-11-08',
      endDate: '2026-11-09',
      type: 'school',
    }),
  )
  assert.equal(foreign.status, 400)

  const updated = await owner.fetch(
    `/api/schools/${schoolA}/holidays/${holiday.id}`,
    put({
      academicYearId: yearA,
      name: 'Diwali break',
      startDate: '2026-11-08',
      endDate: '2026-11-13',
      type: 'festival',
      expectedVersion: holiday.version,
    }),
  )
  assert.equal(updated.status, 200)
  const savedHoliday = (await updated.json()) as HolidayItem
  assert.equal(savedHoliday.endDate, '2026-11-13')
  assert.notEqual(savedHoliday.version, holiday.version)

  // A second editor who still holds the older holiday loses rather than
  // silently overwriting the save above.
  const stale = await owner.fetch(
    `/api/schools/${schoolA}/holidays/${holiday.id}`,
    put({
      academicYearId: yearA,
      name: 'Overwritten',
      startDate: '2026-11-08',
      endDate: '2026-11-09',
      type: 'festival',
      expectedVersion: holiday.version,
    }),
  )
  assert.equal(stale.status, 409)
  assert.equal(((await stale.json()) as ErrorBody).error.code, 'VERSION_CONFLICT')
  const kept = await adminPool().query<{ name: string }>('SELECT name FROM holidays WHERE id = $1', [
    holiday.id,
  ])
  assert.equal(kept.rows[0]?.name, 'Diwali break')

  const listed = (await (
    await teacher.fetch(`/api/schools/${schoolA}/holidays?academicYearId=${yearA}`)
  ).json()) as HolidayItem[]
  assert.equal(
    listed.some((item) => item.id === holiday.id),
    true,
  )

  const removed = await owner.fetch(`/api/schools/${schoolA}/holidays/${holiday.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 204)
  const gone = await adminPool().query('SELECT 1 FROM holidays WHERE id = $1', [holiday.id])
  assert.equal(gone.rowCount, 0)
})

test('a teacher may read the calendar but never change the setup', async () => {
  const read = await teacher.fetch(`/api/schools/${schoolA}/holidays`)
  assert.equal(read.status, 200)

  const write = await teacher.fetch(
    `/api/schools/${schoolA}/grades`,
    body({ name: 'Eleven', shortName: '11', order: 11 }),
  )
  assert.equal(write.status, 403)
  assert.equal(((await write.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  const profile = await teacher.fetch(`/api/schools/${schoolA}/school`)
  assert.equal(profile.status, 403)
})

test('every setup write leaves one audit row naming its permission', async () => {
  const rows = await adminPool().query<{ action: string; summary: string }>(
    `SELECT action, summary FROM audit_events WHERE school_id = $1 AND action = 'holidays.manage'
      ORDER BY created_at DESC LIMIT 3`,
    [schoolA],
  )
  assert.equal(rows.rowCount, 3)
  assert.equal(
    rows.rows.every((row) => !row.summary.includes('Diwali')),
    true,
  )
})

test('a holiday body that names a forbidden field changes nothing', async () => {
  const before = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM holidays WHERE school_id = $1',
    [schoolA],
  )
  const response = await owner.fetch(
    `/api/schools/${schoolA}/holidays`,
    body({
      schoolId: schoolB,
      academicYearId: yearA,
      name: 'Sneaky',
      startDate: '2026-12-25',
      endDate: '2026-12-25',
      type: 'national',
    }),
  )
  assert.equal(response.status, 400)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
  const after = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM holidays WHERE school_id = $1',
    [schoolA],
  )
  assert.equal(after.rows[0]?.total, before.rows[0]?.total)
})

test('an academic year body that names a forbidden field changes nothing', async () => {
  const before = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM academic_years WHERE school_id = $1',
    [schoolA],
  )
  const response = await owner.fetch(
    `/api/schools/${schoolA}/academic-years`,
    body({
      schoolId: schoolB,
      name: `2030-31 ${randomUUID().slice(0, 8)}`,
      startDate: '2030-04-01',
      endDate: '2031-03-31',
      status: 'upcoming',
    }),
  )
  assert.equal(response.status, 400)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
  const after = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM academic_years WHERE school_id = $1',
    [schoolA],
  )
  assert.equal(after.rows[0]?.total, before.rows[0]?.total)
})

test('a subject body that names a forbidden field changes nothing', async () => {
  const before = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM subjects WHERE school_id = $1',
    [schoolA],
  )
  const created = await owner.fetch(
    `/api/schools/${schoolA}/subjects`,
    body({ schoolId: schoolB, name: 'Sneaky', code: `S-${randomUUID().slice(0, 6)}`, type: 'scholastic' }),
  )
  assert.equal(created.status, 400)
  assert.equal(((await created.json()) as ErrorBody).error.code, 'INVALID_REQUEST')

  const mapped = await owner.fetch(
    `/api/schools/${schoolA}/grades/${gradeA}/subjects`,
    put({ schoolId: schoolB, academicYearId: yearA, subjectIds: [subjectA] }),
  )
  assert.equal(mapped.status, 400)
  assert.equal(((await mapped.json()) as ErrorBody).error.code, 'INVALID_REQUEST')

  const after = await adminPool().query<{ total: string }>(
    'SELECT count(*) AS total FROM subjects WHERE school_id = $1',
    [schoolA],
  )
  assert.equal(after.rows[0]?.total, before.rows[0]?.total)
})

test('the subjects of a class can be emptied again', async () => {
  const mapped = await owner.fetch(
    `/api/schools/${schoolA}/grades/${otherGrade}/subjects`,
    put({ academicYearId: yearA, subjectIds: [subjectA] }),
  )
  assert.equal(mapped.status, 200)

  const cleared = await owner.fetch(
    `/api/schools/${schoolA}/grades/${otherGrade}/subjects`,
    put({ academicYearId: yearA, subjectIds: [] }),
  )
  assert.equal(cleared.status, 200)
  assert.deepEqual(await cleared.json(), [])
  const stored = await adminPool().query(
    'SELECT 1 FROM grade_subjects WHERE school_id = $1 AND grade_id = $2',
    [schoolA, otherGrade],
  )
  assert.equal(stored.rowCount, 0)
})

test('a teacher sees the curriculum of their own classes only', async () => {
  await owner.fetch(
    `/api/schools/${schoolA}/grades/${gradeA}/subjects`,
    put({ academicYearId: yearA, subjectIds: [subjectA] }),
  )
  await owner.fetch(
    `/api/schools/${schoolA}/grades/${otherGrade}/subjects`,
    put({ academicYearId: yearA, subjectIds: [subjectA] }),
  )

  // The class list is the same answer, so the mapping list may not name a
  // class the teacher cannot open.
  const grades = (await (await teacher.fetch(`/api/schools/${schoolA}/grades`)).json()) as GradeItem[]
  assert.equal(
    grades.some((item) => item.id === gradeA),
    true,
  )
  assert.equal(
    grades.some((item) => item.id === otherGrade),
    false,
  )

  const all = (await (
    await teacher.fetch(`/api/schools/${schoolA}/grade-subjects?academicYearId=${yearA}`)
  ).json()) as { gradeId: string }[]
  assert.equal(
    all.some((row) => row.gradeId === otherGrade),
    false,
  )

  const named = await teacher.fetch(
    `/api/schools/${schoolA}/grade-subjects?academicYearId=${yearA}&gradeId=${otherGrade}`,
  )
  assert.equal(named.status, 200)
  assert.deepEqual(await named.json(), [])

  await owner.fetch(
    `/api/schools/${schoolA}/grades/${otherGrade}/subjects`,
    put({ academicYearId: yearA, subjectIds: [] }),
  )
})

test('a malformed filter is bad input, not a collection that is missing', async () => {
  for (const path of [
    `/api/schools/${schoolA}/sections?academicYearId=not-a-uuid`,
    `/api/schools/${schoolA}/sections/strengths?academicYearId=zzz`,
    `/api/schools/${schoolA}/holidays?academicYearId=zzz`,
    `/api/schools/${schoolA}/grade-subjects?academicYearId=zzz`,
  ]) {
    const response = await owner.fetch(path)
    assert.equal(response.status, 400)
    assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
  }
})
