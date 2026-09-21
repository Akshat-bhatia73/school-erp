import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import ExcelJS from 'exceljs'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  readExportFileBytes,
  seedDatabaseFixtures,
  signInWithMfa,
  setFixturePassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
// Unique per run: other test files rewrite the same fixture identities.
const OWNER_EMAIL = `bulk-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `bulk-teacher-${randomUUID()}@example.test`
const PARENT_EMAIL = `bulk-parent-${randomUUID()}@example.test`
const OWNER_B_EMAIL = `bulk-owner-b-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const sectionA = fixtureIds.sectionA as string
const studentB = fixtureIds.studentB as string
const studentA2 = fixtureIds.studentA2 as string
const ownerB = fixtureIds.ownerB as string
const adult = fixtureIds.adult as string
const staffA = fixtureIds.staffA as string

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let teacher: Client
let parent: Client

/** Records this run created, so assertions never count fixture-wide totals. */
const nextYear = randomUUID()
const gradeSeven = randomUUID()
const sectionSevenNext = randomUUID()
const sectionSixNext = randomUUID()
const otherSectionA = randomUUID()
// A class larger than one preview page, so paging is the ordinary case.
const bigSection = randomUUID()
const BIG_ROLL = 105
const subjectA = randomUUID()
const previewInSchoolB = randomUUID()
const stamp = randomUUID().slice(0, 8)

interface ErrorBody {
  error: { code: string; requestId: string }
}

function base(school = schoolA): string {
  return `/api/schools/${school}/students`
}

async function readError(response: Response): Promise<string> {
  const body = (await response.json()) as ErrorBody
  return body.error.code
}

function sheetRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rowNumber: 1,
    admissionNumber: `BULK-${stamp}-${randomUUID().slice(0, 6)}`,
    firstName: 'Imported',
    dateOfBirth: '2014-06-01',
    gender: 'male',
    grade: 'Six',
    section: 'A',
    guardianPhone: '9876543210',
    ...overrides,
  }
}

/** A student sitting in the fixture section, created outside the API. */
async function seatStudent(sectionId: string = sectionA): Promise<string> {
  const pool = adminPool()
  const student = await pool.query<{ id: string }>(
    `INSERT INTO students (school_id, admission_number, first_name, status)
     VALUES ($1, $2, 'Seated', 'active') RETURNING id`,
    [schoolA, `SEAT-${stamp}-${randomUUID().slice(0, 8)}`],
  )
  const id = student.rows[0]?.id as string
  await pool.query(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     VALUES ($1, $2, $3, $4, current_date)`,
    [schoolA, id, yearA, sectionId],
  )
  return id
}

async function countStudents(prefix: string): Promise<number> {
  const result = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM students WHERE school_id = $1 AND admission_number LIKE $2`,
    [schoolA, `${prefix}%`],
  )
  return result.rows[0]?.total ?? 0
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  for (const [userId, email] of [
    [fixtureIds.ownerAUser as string, OWNER_EMAIL],
    [fixtureIds.adultUser as string, TEACHER_EMAIL],
    [fixtureIds.parentA2User as string, PARENT_EMAIL],
    [fixtureIds.ownerBUser as string, OWNER_B_EMAIL],
  ]) {
    await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [userId, email])
  }

  // Next year's classes: one grade up for promotion and the same grade again
  // for a detained student.
  await pool.query(
    `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
     VALUES ($1, $2, $3, '2027-04-01', '2028-03-31', 'upcoming')`,
    [nextYear, schoolA, `bulk-${stamp}`],
  )
  await pool.query(
    `INSERT INTO grades (id, school_id, name, short_name, sort_order)
     VALUES ($1, $2, $3, '7', 7)`,
    [gradeSeven, schoolA, `Seven ${stamp}`],
  )
  await pool.query(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, 'A'), ($5, $2, $3, $6, 'A')`,
    [sectionSevenNext, schoolA, nextYear, gradeSeven, sectionSixNext, gradeA],
  )
  await pool.query(
    `INSERT INTO student_import_previews
       (id, school_id, created_by_membership_id, academic_year_id, status,
        total_rows, valid_rows, rows, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', 0, 0, '[]'::jsonb, now() + interval '1 hour')`,
    [previewInSchoolB, schoolB, ownerB, await schoolBYear()],
  )
  // A teacher who may export, but only the classes they actually teach. The
  // grant and the assignment together are what a section scope means, so the
  // wrong-person case below is the real one rather than a contrived denial.
  await pool.query(
    `INSERT INTO subjects (id, school_id, name, code, type)
     VALUES ($1, $2, $3, $4, 'scholastic')`,
    [subjectA, schoolA, `Maths ${stamp}`, `MTH-${stamp}`],
  )
  await pool.query(
    `INSERT INTO teaching_assignments
       (school_id, staff_id, academic_year_id, section_id, subject_id, effective_from)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01')`,
    [schoolA, staffA, yearA, sectionA, subjectA],
  )
  await pool.query(
    `INSERT INTO role_permissions (school_id, role_id, permission, scope)
     SELECT $1, r.id, 'students.export', 'assigned_sections'
       FROM roles r WHERE r.school_id = $1 AND r.key = 'teacher'
     ON CONFLICT DO NOTHING`,
    [schoolA],
  )
  // A class of more than one page, to show a preview pages rather than stops.
  await pool.query(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [bigSection, schoolA, yearA, gradeA, `Big-${stamp}`],
  )
  await pool.query(
    `WITH new_students AS (
       INSERT INTO students (school_id, admission_number, first_name, status)
       SELECT $1, 'BIG-' || $2 || '-' || to_char(n, 'FM000'), 'Crowd', 'active'
         FROM generate_series(1, $3) AS n
       RETURNING id
     )
     INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     SELECT $1, id, $4, $5, current_date FROM new_students`,
    [schoolA, stamp, BIG_ROLL, yearA, bigSection],
  )

  // A second class in the same year, to show a roster never spills over.
  await pool.query(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [otherSectionA, schoolA, yearA, gradeA, `B-${stamp}`],
  )
  // A parent may run a promotion here, but reads students at own_children
  // scope and carries no fixture exception: they are the one caller whose
  // preview roster proves the read plan is really in the WHERE clause.
  await pool.query(
    `INSERT INTO role_permissions (school_id, role_id, permission, scope)
     SELECT $1, r.id, 'students.promote', 'school'
       FROM roles r WHERE r.school_id = $1 AND r.key = 'parent'
     ON CONFLICT DO NOTHING`,
    [schoolA],
  )

  // The parent's own child sits in that second class, so the roster has one
  // row they may see and several they may not.
  await pool.query(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     VALUES ($1, $2, $3, $4, current_date)`,
    [schoolA, studentA2, yearA, otherSectionA],
  )

  await setFixturePassword(server, fixtureIds.adultUser as string, PASSWORD)
  await setFixturePassword(server, fixtureIds.parentA2User as string, PASSWORD)
  owner = await signInWithMfa(server, {
    userId: fixtureIds.ownerAUser as string,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  // The teacher needs two-step verification too: exporting is privileged
  // whichever scope allows it.
  teacher = await signInWithMfa(server, {
    userId: fixtureIds.adultUser as string,
    email: TEACHER_EMAIL,
    password: PASSWORD,
  })
  // Promoting is privileged whoever does it, so this parent verifies too.
  parent = await signInWithMfa(server, {
    userId: fixtureIds.parentA2User as string,
    email: PARENT_EMAIL,
    password: PASSWORD,
  })
})

/** School B needs an academic year of its own for its staged preview row. */
async function schoolBYear(): Promise<string> {
  const pool = adminPool()
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM academic_years WHERE school_id = $1 LIMIT 1`,
    [schoolB],
  )
  const found = existing.rows[0]?.id
  if (found) return found
  const created = await pool.query<{ id: string }>(
    `INSERT INTO academic_years (school_id, name, start_date, end_date, status)
     VALUES ($1, 'bulk-b', '2026-04-01', '2027-03-31', 'current') RETURNING id`,
    [schoolB],
  )
  return created.rows[0]?.id as string
}

after(async () => {
  const pool = adminPool()
  for (const userId of [
    fixtureIds.ownerAUser as string,
    fixtureIds.adultUser as string,
    fixtureIds.parentA2User as string,
  ]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  // Everything this run created, so the file can be run again on the same
  // database: the section names and the grade name are unique per school.
  const mine = `^(BULK|SEAT|RACE|GOOD)-${stamp}`
  // Enrollments and guardian links do not cascade from students, so they go
  // first; everything is matched on this run's own stamp.
  for (const table of ['enrollments', 'student_guardians']) {
    await pool.query(
      `DELETE FROM ${table} t USING students s
        WHERE s.school_id = t.school_id AND s.id = t.student_id
          AND s.school_id = $1 AND s.admission_number ~ $2`,
      [schoolA, mine],
    )
  }
  await pool.query(
    `DELETE FROM students WHERE school_id = $1 AND admission_number ~ $2`,
    [schoolA, mine],
  )
  // Guardians left without a student are harmless: nothing in this file is
  // keyed on them and they carry no unique column.
  await pool.query(
    `DELETE FROM export_jobs WHERE school_id = $1 AND requested_by_membership_id = $2`,
    [schoolA, adult],
  )
  await pool.query('DELETE FROM student_import_previews WHERE school_id = $1 AND id = $2', [
    schoolB,
    previewInSchoolB,
  ])
  await pool.query(
    `DELETE FROM role_permissions WHERE school_id = $1 AND permission = 'students.promote'
       AND role_id IN (SELECT id FROM roles WHERE school_id = $1 AND key = 'parent')`,
    [schoolA],
  )
  await pool.query('DELETE FROM enrollments WHERE school_id = $1 AND section_id = ANY($2::uuid[])', [
    schoolA,
    [otherSectionA, sectionSevenNext, sectionSixNext, bigSection],
  ])
  await pool.query(
    `DELETE FROM students WHERE school_id = $1 AND admission_number LIKE $2`,
    [schoolA, `BIG-${stamp}-%`],
  )
  await pool.query('DELETE FROM sections WHERE school_id = $1 AND id = ANY($2::uuid[])', [
    schoolA,
    [otherSectionA, sectionSevenNext, sectionSixNext, bigSection],
  ])
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1 AND subject_id = $2', [
    schoolA,
    subjectA,
  ])
  await pool.query('DELETE FROM subjects WHERE school_id = $1 AND id = $2', [schoolA, subjectA])
  await pool.query('DELETE FROM grades WHERE school_id = $1 AND id = $2', [schoolA, gradeSeven])
  await pool.query('DELETE FROM academic_years WHERE school_id = $1 AND id = $2', [schoolA, nextYear])
  await pool.query(
    `DELETE FROM role_permissions WHERE school_id = $1 AND permission = ANY($2::text[])
       AND role_id IN (SELECT id FROM roles WHERE school_id = $1 AND key = 'teacher')`,
    [schoolA, ['students.export']],
  )
  await server.close()
  await closeAdminPool()
})

test('the bulk routes need a session', async () => {
  const preview = await fetch(`${server.origin}${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ academicYearId: yearA, rows: [sheetRow()] }),
  })
  assert.equal(preview.status, 401)
  const promote = await fetch(
    `${server.origin}${base()}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}&fromSectionId=${sectionA}&toSectionId=${sectionSevenNext}`,
  )
  assert.equal(promote.status, 401)
})

test('a school A member gets no answer through a school B path', async () => {
  const promote = await owner.fetch(
    `${base(schoolB)}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}&fromSectionId=${sectionA}&toSectionId=${sectionSevenNext}`,
  )
  assert.equal(promote.status, 403)
  assert.equal(await readError(promote), 'SCHOOL_ACCESS_UNAVAILABLE')

  const exported = await owner.fetch(`${base(schoolB)}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentIds: [studentB] }),
  })
  assert.equal(exported.status, 403)
  assert.equal(await readError(exported), 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('a school B record asked for through the school A path is simply not found', async () => {
  const exported = await owner.fetch(`${base()}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentIds: [studentB] }),
  })
  assert.equal(exported.status, 404)
  assert.equal(await readError(exported), 'RESOURCE_NOT_FOUND')
  const jobs = await adminPool().query(
    `SELECT 1 FROM export_jobs WHERE school_id = $1 AND criteria::text LIKE $2`,
    [schoolA, `%${studentB}%`],
  )
  assert.equal(jobs.rowCount, 0)

  const committed = await owner.fetch(`${base()}/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: previewInSchoolB, expectedVersion: 1 }),
  })
  assert.equal(committed.status, 404)
  assert.equal(await readError(committed), 'RESOURCE_NOT_FOUND')
})

test('a school B section asked for through the school A path is not found', async () => {
  const schoolBSection = await adminPool().query<{ id: string }>(
    `SELECT id FROM sections WHERE school_id = $1 LIMIT 1`,
    [schoolB],
  )
  const foreign = schoolBSection.rows[0]?.id ?? randomUUID()
  const response = await owner.fetch(
    `${base()}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}&fromSectionId=${foreign}&toSectionId=${sectionSevenNext}`,
  )
  assert.equal(response.status, 404)
  assert.equal(await readError(response), 'RESOURCE_NOT_FOUND')
})

test('a promotion preview shows a parent only their own child', async () => {
  const stranger = await seatStudent(otherSectionA)

  const response = await parent.fetch(
    `${base()}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}&fromSectionId=${otherSectionA}&toSectionId=${sectionSevenNext}`,
  )
  assert.equal(response.status, 200)
  const roster = (await response.json()) as { students: { id: string }[] }
  // Same class, same query: the read plan is the only thing that keeps the
  // other children of that class off this list.
  assert.deepEqual(roster.students.map((student) => student.id), [studentA2])
  assert.equal(roster.students.some((student) => student.id === stranger), false)

  // A class holding none of their children comes back empty rather than full.
  const elsewhere = await parent.fetch(
    `${base()}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}&fromSectionId=${sectionA}&toSectionId=${sectionSevenNext}`,
  )
  assert.equal(elsewhere.status, 200)
  assert.deepEqual(((await elsewhere.json()) as { students: unknown[] }).students, [])
})

test('a second open enrollment cannot smuggle an unrelated student through', async () => {
  const seated = await seatStudent()
  const stranger = await seatStudent(otherSectionA)
  // A duplicate open row for the seated student: a count(*) gate would see two
  // matches for two named students and wave the stranger through.
  await adminPool().query(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     VALUES ($1, $2, $3, $4, current_date)`,
    [schoolA, seated, yearA, sectionA],
  )

  const response = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: sectionA,
      toSectionId: sectionSevenNext,
      studentIds: [seated, stranger],
      detainedStudentIds: [],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(response.status, 400)
  assert.equal(await readError(response), 'INVALID_REQUEST')
  const moved = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM enrollments
      WHERE school_id = $1 AND academic_year_id = $2 AND student_id = ANY($3::uuid[])`,
    [schoolA, nextYear, [seated, stranger]],
  )
  assert.equal(moved.rows[0]?.total, 0)

  // The roster still names that student once, not twice.
  const preview = await owner.fetch(
    `${base()}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}&fromSectionId=${sectionA}&toSectionId=${sectionSevenNext}`,
  )
  const body = (await preview.json()) as { students: { id: string }[] }
  assert.equal(body.students.filter((student) => student.id === seated).length, 1)
})

test('admission numbers differing only in case are both admissible', async () => {
  const response = await owner.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      rows: [
        sheetRow({ rowNumber: 1, admissionNumber: `BULK-${stamp}-case` }),
        sheetRow({ rowNumber: 2, admissionNumber: `BULK-${stamp}-CASE` }),
      ],
    }),
  })
  assert.equal(response.status, 201)
  const body = (await response.json()) as { validRows: number; errors: unknown[] }
  assert.equal(body.validRows, 2)
  assert.deepEqual(body.errors, [])
})

test('a teacher without the import permission is refused', async () => {
  const response = await teacher.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ academicYearId: yearA, rows: [sheetRow()] }),
  })
  assert.equal(response.status, 403)
  assert.equal(await readError(response), 'ACCESS_DENIED')
})

test('a preview reports every bad row and stores only the good ones', async () => {
  const goodNumber = `BULK-${stamp}-ok`
  const takenNumber = 'A/2026-27/001'
  const response = await owner.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      rows: [
        sheetRow({ rowNumber: 1, admissionNumber: goodNumber }),
        sheetRow({ rowNumber: 2, admissionNumber: takenNumber }),
        sheetRow({ rowNumber: 3, grade: 'Nine', section: 'Z' }),
      ],
    }),
  })
  assert.equal(response.status, 201)
  const body = (await response.json()) as {
    id: string
    version: number
    totalRows: number
    validRows: number
    errors: { row: number; field: string; message: string }[]
  }
  assert.deepEqual(Object.keys(body).sort(), [
    'errors', 'expiresAt', 'id', 'rows', 'totalRows', 'validRows', 'version',
  ])
  assert.equal(body.totalRows, 3)
  assert.equal(body.validRows, 1)
  assert.deepEqual(body.errors.map((error) => error.row).sort(), [2, 3])

  const stored = await adminPool().query<{ rows: { admissionNumber: string }[] }>(
    `SELECT rows FROM student_import_previews WHERE school_id = $1 AND id = $2`,
    [schoolA, body.id],
  )
  assert.equal(stored.rows[0]?.rows.length, 1)
  assert.equal(stored.rows[0]?.rows[0]?.admissionNumber, goodNumber)
})

test('an import keeps a supplied number and assigns one to a blank row', async () => {
  const kept = `KEPT-${stamp}`
  // Names unique to this run: the suite shares one database.
  const keptName = `Kept-${stamp}`
  const blankName = `Blank-${stamp}`
  const preview = await owner.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      rows: [
        sheetRow({ rowNumber: 1, admissionNumber: kept, firstName: keptName }),
        // No admission number at all: the server assigns one at commit.
        sheetRow({ rowNumber: 2, firstName: blankName, admissionNumber: undefined }),
      ],
    }),
  })
  assert.equal(preview.status, 201)
  const staged = (await preview.json()) as {
    id: string
    version: number
    validRows: number
    rows: { rowNumber: number; firstName: string; admissionNumber?: string }[]
  }
  assert.equal(staged.validRows, 2)
  // The preview says which number the sheet keeps and which one is pending.
  assert.deepEqual(staged.rows, [
    { rowNumber: 1, firstName: keptName, admissionNumber: kept },
    { rowNumber: 2, firstName: blankName },
  ])

  const committed = await owner.fetch(`${base()}/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: staged.id, expectedVersion: staged.version }),
  })
  assert.equal(committed.status, 201)
  const stored = await adminPool().query<{ first_name: string; admission_number: string }>(
    `SELECT first_name, admission_number FROM students
      WHERE school_id = $1 AND first_name = ANY($2::text[])`,
    [schoolA, [keptName, blankName]],
  )
  const byName = new Map(stored.rows.map((row) => [row.first_name, row.admission_number]))
  assert.equal(byName.get(keptName), kept)
  assert.match(byName.get(blankName) ?? '', /^A\/2026-27\/\d{3,}$/)
})

test('a kept number with more digits than any counter does not break later admissions', async () => {
  // Looks like the school format but could never have come from the counter.
  // It is kept verbatim and ignored by the counter, so the blank row after it
  // still gets an ordinary number instead of a failed cast.
  // Unique per run, since the suite shares one database between runs.
  const kept = `A/2026-27/${Date.now()}${'9'.repeat(20)}`
  const keptName = `LongKept-${stamp}`
  const blankName = `LongBlank-${stamp}`
  const preview = await owner.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      rows: [
        sheetRow({ rowNumber: 1, admissionNumber: kept, firstName: keptName }),
        sheetRow({ rowNumber: 2, firstName: blankName, admissionNumber: undefined }),
      ],
    }),
  })
  assert.equal(preview.status, 201)
  const staged = (await preview.json()) as { id: string; version: number; validRows: number }
  assert.equal(staged.validRows, 2)
  const committed = await owner.fetch(`${base()}/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: staged.id, expectedVersion: staged.version }),
  })
  assert.equal(committed.status, 201)
  const stored = await adminPool().query<{ first_name: string; admission_number: string }>(
    `SELECT first_name, admission_number FROM students
      WHERE school_id = $1 AND first_name = ANY($2::text[])`,
    [schoolA, [keptName, blankName]],
  )
  const byName = new Map(stored.rows.map((row) => [row.first_name, row.admission_number]))
  assert.equal(byName.get(keptName), kept)
  assert.match(byName.get(blankName) ?? '', /^A\/2026-27\/\d{3,9}$/)
})

test('a kept number in the school format pushes the counter past it', async () => {
  // A school migrating its register keeps numbers that look exactly like the
  // generated ones. The counter has to clear them, or the next generated
  // number would repeat one and the whole commit would roll back.
  const high = 4000 + Math.floor(Math.random() * 100000)
  const kept = `A/2026-27/${high}`
  const keptName = `HighKept-${stamp}`
  const blankName = `HighBlank-${stamp}`
  const preview = await owner.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      rows: [
        sheetRow({ rowNumber: 1, admissionNumber: kept, firstName: keptName }),
        sheetRow({ rowNumber: 2, firstName: blankName, admissionNumber: undefined }),
      ],
    }),
  })
  assert.equal(preview.status, 201)
  const staged = (await preview.json()) as { id: string; version: number }
  const committed = await owner.fetch(`${base()}/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: staged.id, expectedVersion: staged.version }),
  })
  assert.equal(committed.status, 201)
  const stored = await adminPool().query<{ first_name: string; admission_number: string }>(
    `SELECT first_name, admission_number FROM students
      WHERE school_id = $1 AND first_name = ANY($2::text[])`,
    [schoolA, [keptName, blankName]],
  )
  const byName = new Map(stored.rows.map((row) => [row.first_name, row.admission_number]))
  assert.equal(byName.get(keptName), kept)
  const assigned = Number((byName.get(blankName) ?? '').split('/').at(-1))
  assert.ok(assigned > high, `${assigned} must be past ${high}`)
})

test('a preview body carrying a forbidden field writes nothing', async () => {
  const before = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM student_import_previews WHERE school_id = $1`,
    [schoolA],
  )
  const response = await owner.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schoolId: schoolB, academicYearId: yearA, rows: [sheetRow()] }),
  })
  assert.equal(response.status, 400)
  assert.equal(await readError(response), 'INVALID_REQUEST')
  const after = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM student_import_previews WHERE school_id = $1`,
    [schoolA],
  )
  assert.equal(after.rows[0]?.total, before.rows[0]?.total)
})

test('a commit is refused whole when an admission number was taken meanwhile', async () => {
  const number = `RACE-${stamp}`
  const preview = await owner.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      rows: [
        sheetRow({ rowNumber: 1, admissionNumber: number }),
        sheetRow({ rowNumber: 2, admissionNumber: `RACE-${stamp}-2` }),
      ],
    }),
  })
  const staged = (await preview.json()) as { id: string; version: number; validRows: number }
  assert.equal(staged.validRows, 2)

  // Somebody admits a student with that number between preview and commit.
  await adminPool().query(
    `INSERT INTO students (school_id, admission_number, first_name, status)
     VALUES ($1, $2, 'Walked In', 'active')`,
    [schoolA, number],
  )

  const committed = await owner.fetch(`${base()}/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: staged.id, expectedVersion: staged.version }),
  })
  assert.equal(committed.status, 400)
  assert.equal(await readError(committed), 'INVALID_REQUEST')
  assert.equal(await countStudents(`RACE-${stamp}-2`), 0)
  const state = await adminPool().query<{ status: string }>(
    `SELECT status FROM student_import_previews WHERE school_id = $1 AND id = $2`,
    [schoolA, staged.id],
  )
  assert.equal(state.rows[0]?.status, 'pending')
})

test('a committed import admits every stored row with its class and contact', async () => {
  const prefix = `GOOD-${stamp}`
  const preview = await owner.fetch(`${base()}/import/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      rows: [
        sheetRow({ rowNumber: 1, admissionNumber: `${prefix}-1`, fatherName: 'Ram' }),
        sheetRow({ rowNumber: 2, admissionNumber: `${prefix}-2`, motherName: 'Sita' }),
      ],
    }),
  })
  const staged = (await preview.json()) as { id: string; version: number }

  const committed = await owner.fetch(`${base()}/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: staged.id, expectedVersion: staged.version }),
  })
  assert.equal(committed.status, 201)
  assert.deepEqual(await committed.json(), { created: 2 })
  assert.equal(await countStudents(prefix), 2)

  const links = await adminPool().query<{ relation: string; phone: string }>(
    `SELECT sg.relation, g.phone
       FROM student_guardians sg
       JOIN guardians g ON g.school_id = sg.school_id AND g.id = sg.guardian_id
       JOIN students s ON s.school_id = sg.school_id AND s.id = sg.student_id
      WHERE s.school_id = $1 AND s.admission_number LIKE $2
      ORDER BY s.admission_number`,
    [schoolA, `${prefix}%`],
  )
  assert.deepEqual(links.rows.map((row) => row.relation), ['father', 'mother'])
  assert.equal(links.rows[0]?.phone, '+919876543210')

  const enrolled = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM enrollments e
       JOIN students s ON s.school_id = e.school_id AND s.id = e.student_id
      WHERE e.school_id = $1 AND e.section_id = $2 AND s.admission_number LIKE $3`,
    [schoolA, sectionA, `${prefix}%`],
  )
  assert.equal(enrolled.rows[0]?.total, 2)

  const again = await owner.fetch(`${base()}/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ previewId: staged.id, expectedVersion: staged.version }),
  })
  // The preview is no longer pending, so a repeat submit cannot double admit.
  assert.equal(again.status, 400)
})

test('a promotion preview lists only the students the caller may read', async () => {
  const seated = await seatStudent()
  const response = await owner.fetch(
    `${base()}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}&fromSectionId=${sectionA}&toSectionId=${sectionSevenNext}`,
  )
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    students: Record<string, unknown>[]
    targetSection: { id: string; name: string }
  }
  assert.deepEqual(Object.keys(body).sort(), ['page', 'pageSize', 'students', 'targetSection', 'total'])
  assert.equal(body.targetSection.id, sectionSevenNext)
  const mine = body.students.find((student) => student.id === seated)
  assert.ok(mine)
  assert.deepEqual(
    Object.keys(mine).sort(),
    ['admissionNumber', 'anonymised', 'firstName', 'hasPhoto', 'id', 'schoolId', 'status', 'version'],
  )

  // A student of the neighbouring class is not on this roster, because the
  // list asks the same question a detail read would.
  const elsewhere = await seatStudent(otherSectionA)
  assert.equal(body.students.some((student) => student.id === elsewhere), false)
})

test('a promotion naming one student outside the class writes nothing', async () => {
  const seated = await seatStudent()
  const response = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: sectionA,
      toSectionId: sectionSevenNext,
      studentIds: [seated, studentA2],
      detainedStudentIds: [],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(response.status, 400)
  assert.equal(await readError(response), 'INVALID_REQUEST')
  const moved = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM enrollments
      WHERE school_id = $1 AND student_id = $2 AND academic_year_id = $3`,
    [schoolA, seated, nextYear],
  )
  assert.equal(moved.rows[0]?.total, 0)
})

test('a promotion body carrying a forbidden field writes nothing', async () => {
  const seated = await seatStudent()
  const response = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schoolId: schoolB,
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: sectionA,
      toSectionId: sectionSevenNext,
      studentIds: [seated],
      detainedStudentIds: [],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(response.status, 400)
  assert.equal(await readError(response), 'INVALID_REQUEST')
  const moved = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM enrollments
      WHERE school_id = $1 AND student_id = $2 AND academic_year_id = $3`,
    [schoolA, seated, nextYear],
  )
  assert.equal(moved.rows[0]?.total, 0)
})

test('a promotion moves the promoted up and keeps the detained in their grade', async () => {
  const promoted = await seatStudent()
  const detained = await seatStudent()
  const response = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: sectionA,
      toSectionId: sectionSevenNext,
      studentIds: [promoted],
      detainedStudentIds: [detained],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { promoted: 1, detained: 1 })

  const rows = await adminPool().query<{
    student_id: string
    academic_year_id: string
    section_id: string
    outcome: string
  }>(
    `SELECT student_id, academic_year_id, section_id, outcome FROM enrollments
      WHERE school_id = $1 AND student_id = ANY($2::uuid[])
      ORDER BY student_id, academic_year_id`,
    [schoolA, [promoted, detained]],
  )
  const closed = rows.rows.filter((row) => row.academic_year_id === yearA)
  assert.deepEqual(closed.map((row) => row.outcome).sort(), ['detained', 'promoted'])
  const opened = rows.rows.filter((row) => row.academic_year_id === nextYear)
  assert.equal(opened.length, 2)
  assert.equal(opened.find((row) => row.student_id === promoted)?.section_id, sectionSevenNext)
  // The detained student repeats the same grade in next year's section.
  assert.equal(opened.find((row) => row.student_id === detained)?.section_id, sectionSixNext)
})

test('students who are left out of a promotion are not touched at all', async () => {
  const promoted = await seatStudent()
  const detained = await seatStudent()
  const leftOut = await seatStudent()

  const response = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: sectionA,
      toSectionId: sectionSevenNext,
      // The third student of the class is in neither list, which is how the
      // screen says "leave this one out".
      studentIds: [promoted],
      detainedStudentIds: [detained],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { promoted: 1, detained: 1 })

  const rows = await adminPool().query<{
    academic_year_id: string
    outcome: string
    left_on: string | null
  }>(
    `SELECT academic_year_id, outcome, left_on::text AS left_on FROM enrollments
      WHERE school_id = $1 AND student_id = $2`,
    [schoolA, leftOut],
  )
  // One enrollment, still this year's, still open and still ongoing.
  assert.equal(rows.rows.length, 1)
  assert.equal(rows.rows[0]?.academic_year_id, yearA)
  assert.equal(rows.rows[0]?.outcome, 'ongoing')
  assert.equal(rows.rows[0]?.left_on, null)
})

test('a promotion may name only students to promote, or only students to detain', async () => {
  const promoted = await seatStudent()
  const onlyPromote = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: sectionA,
      toSectionId: sectionSevenNext,
      studentIds: [promoted],
      detainedStudentIds: [],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(onlyPromote.status, 200)
  assert.deepEqual(await onlyPromote.json(), { promoted: 1, detained: 0 })

  const detained = await seatStudent()
  const onlyDetain = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: sectionA,
      toSectionId: sectionSevenNext,
      studentIds: [],
      detainedStudentIds: [detained],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(onlyDetain.status, 200)
  assert.deepEqual(await onlyDetain.json(), { promoted: 0, detained: 1 })
})

test('a promotion that names nobody is refused and writes nothing', async () => {
  const seated = await seatStudent()
  const response = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: sectionA,
      toSectionId: sectionSevenNext,
      studentIds: [],
      detainedStudentIds: [],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(response.status, 400)
  assert.equal(await readError(response), 'INVALID_REQUEST')
  const moved = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM enrollments
      WHERE school_id = $1 AND student_id = $2 AND academic_year_id = $3`,
    [schoolA, seated, nextYear],
  )
  assert.equal(moved.rows[0]?.total, 0)
})

test('an export of a set with one unreachable record is refused whole', async () => {
  const taught = await seatStudent()
  // The teacher teaches this class, so studentA2 is a student of theirs in
  // name only: the whole request is refused rather than trimmed.
  const refused = await teacher.fetch(`${base()}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentIds: [taught, studentA2] }),
  })
  assert.equal(refused.status, 404)
  assert.equal(await readError(refused), 'RESOURCE_NOT_FOUND')
  const jobs = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM export_jobs
      WHERE school_id = $1 AND requested_by_membership_id = $2 AND criteria::text LIKE $3`,
    [schoolA, adult, `%${taught}%`],
  )
  assert.equal(jobs.rows[0]?.total, 0)

  const allowed = await teacher.fetch(`${base()}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentIds: [taught] }),
  })
  assert.equal(allowed.status, 202)
  const body = (await allowed.json()) as { id: string; status: string; format: string }
  assert.deepEqual(Object.keys(body).sort(), ['fileName', 'format', 'id', 'status'])
  // One row is well under the inline limit, so the file exists by the time the
  // request answers and the job names it.
  assert.equal(body.status, 'ready')
  assert.equal(body.format, 'xlsx')
  const job = await adminPool().query<{
    row_count: number
    permission: string
    access_version: number
    status: string
  }>(
    `SELECT row_count, permission, access_version, status FROM export_jobs WHERE school_id = $1 AND id = $2`,
    [schoolA, body.id],
  )
  assert.equal(job.rows[0]?.status, 'ready')
  assert.equal(job.rows[0]?.row_count, 1)
  assert.equal(job.rows[0]?.permission, 'students.export')
  assert.ok((job.rows[0]?.access_version ?? 0) > 0)
})

test("a teacher's export holds only the students of their own section", async () => {
  // Two students in the teacher's section and one in a class they do not
  // teach. The teacher may only ask for their own two, and the file that comes
  // back must hold exactly those rows.
  const mine = await seatStudent()
  const alsoMine = await seatStudent()
  const response = await teacher.fetch(`${base()}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentIds: [mine, alsoMine] }),
  })
  assert.equal(response.status, 202)
  const job = (await response.json()) as { id: string; status: string }
  assert.equal(job.status, 'ready')

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(
    (await readExportFileBytes(server, job.id)) as unknown as ArrayBuffer,
  )
  const sheet = workbook.worksheets[0]
  assert.ok(sheet)
  assert.equal(sheet.getRow(1).getCell(1).value, 'Admission number')
  const names: string[] = []
  sheet.eachRow((row, index) => {
    if (index > 1) names.push(String(row.getCell(2).value))
  })
  assert.deepEqual(names, ['Seated', 'Seated'])
  // The sensitive columns are not in the file at all, whoever asked for it.
  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map(String)
  assert.deepEqual(headers, [
    'Admission number',
    'Name',
    'Class',
    'Section',
    'Roll number',
    'Status',
  ])
})

test('an export body carrying a forbidden field writes nothing', async () => {
  const before = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1`,
    [schoolA],
  )
  const response = await owner.fetch(`${base()}/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentIds: [studentA2], schoolId: schoolB }),
  })
  assert.equal(response.status, 400)
  assert.equal(await readError(response), 'INVALID_REQUEST')
  const after = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1`,
    [schoolA],
  )
  assert.equal(after.rows[0]?.total, before.rows[0]?.total)
})

interface PreviewPage {
  students: { id: string }[]
  total: number
  page: number
  pageSize: number
}

async function previewBig(client: Client, query = ''): Promise<PreviewPage> {
  const response = await client.fetch(
    `${base()}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}` +
      `&fromSectionId=${bigSection}&toSectionId=${sectionSevenNext}${query}`,
  )
  assert.equal(response.status, 200)
  return (await response.json()) as PreviewPage
}

test('a class larger than a page is previewed a page at a time, not cut short', async () => {
  const first = await previewBig(owner)
  assert.equal(first.total, BIG_ROLL)
  assert.equal(first.page, 1)
  assert.equal(first.pageSize, 100)
  assert.equal(first.students.length, 100)

  const second = await previewBig(owner, '&page=2')
  assert.equal(second.total, BIG_ROLL)
  assert.equal(second.page, 2)
  assert.equal(second.students.length, BIG_ROLL - 100)

  // Nobody is counted twice and nobody is missed.
  const seen = new Set([...first.students, ...second.students].map((student) => student.id))
  assert.equal(seen.size, BIG_ROLL)

  // A page bigger than the cap is bad input, not a quietly shortened page.
  const tooLarge = await owner.fetch(
    `${base()}/promote/preview?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}` +
      `&fromSectionId=${bigSection}&toSectionId=${sectionSevenNext}&pageSize=500`,
  )
  assert.equal(tooLarge.status, 400)
  assert.equal(await readError(tooLarge), 'INVALID_REQUEST')
})

test('promoting the first page leaves only the rest to promote', async () => {
  const first = await previewBig(owner)
  const moved = first.students.map((student) => student.id)
  const response = await owner.fetch(`${base()}/promote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: bigSection,
      toSectionId: sectionSevenNext,
      studentIds: moved,
      detainedStudentIds: [],
      reason: 'Year end promotion',
    }),
  })
  assert.equal(response.status, 200)

  // The run closed those enrollments, so the next preview is the remainder
  // and page one holds all of it.
  const after = await previewBig(owner)
  assert.equal(after.total, BIG_ROLL - moved.length)
  assert.equal(after.students.length, BIG_ROLL - moved.length)
  assert.equal(after.students.some((student) => moved.includes(student.id)), false)
})
