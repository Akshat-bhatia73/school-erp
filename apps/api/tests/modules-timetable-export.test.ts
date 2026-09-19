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
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
// Unique per run: other test files rewrite the same fixture identities.
const OWNER_EMAIL = `tt-export-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `tt-export-teacher-${randomUUID()}@example.test`
const PARENT_EMAIL = `tt-export-parent-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const sectionA = fixtureIds.sectionA as string
const staffA = fixtureIds.staffA as string
const studentA2 = fixtureIds.studentA2 as string

// Rows this file inserts itself, so every assertion is about known data.
const suffix = randomUUID().slice(0, 8)
const subjectMath = randomUUID()
const otherSection = randomUUID()
const otherStaff = randomUUID()
const bellSchedule = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let teacher: Client
let parent: Client

interface JobBody {
  id: string
  status: string
  fileName?: string
  format?: string
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code ?? ''
}

async function requestExport(
  client: Client,
  body: unknown,
  school = schoolA,
): Promise<Response> {
  return client.fetch(`/api/schools/${school}/timetable/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const teacherView = (staffId: string, format: 'xlsx' | 'pdf') => ({
  academicYearId: yearA,
  format,
  view: { kind: 'teacher', staffId },
})

const sectionView = (sectionId: string, format: 'xlsx' | 'pdf') => ({
  academicYearId: yearA,
  format,
  view: { kind: 'section', sectionId },
})

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  // This file owns the timetable of the fixture school and counts its export
  // jobs exactly, so it starts from a known empty state.
  for (const table of [
    'substitutions',
    'timetable_entries',
    'teaching_assignments',
    'bell_schedules',
    'enrollments',
    'grade_subjects',
    'export_jobs',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE school_id = $1`, [schoolA])
  }

  for (const [userId, email] of [
    [fixtureIds.ownerAUser as string, OWNER_EMAIL],
    [fixtureIds.adultUser as string, TEACHER_EMAIL],
    [fixtureIds.parentA2User as string, PARENT_EMAIL],
  ] as const) {
    await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [userId, email])
  }

  await pool.query(
    `INSERT INTO subjects (id, school_id, name, code, type)
     VALUES ($1, $2, $3, $4, 'scholastic')`,
    [subjectMath, schoolA, `Maths ${suffix}`, `TTX-${suffix}`],
  )
  await pool.query(
    `INSERT INTO grade_subjects (school_id, grade_id, academic_year_id, subject_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [schoolA, gradeA, yearA, subjectMath],
  )
  await pool.query(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [otherSection, schoolA, yearA, gradeA, `X-${suffix}`],
  )
  await pool.query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, last_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Other', 'Teacher', 'teaching', 'Teacher', 'active')`,
    [otherStaff, schoolA, `TTX-${suffix}`],
  )
  // The fixture teacher holds one class; the other teacher holds the class the
  // fixture teacher may not see.
  await pool.query(
    `INSERT INTO teaching_assignments
       (school_id, staff_id, academic_year_id, section_id, subject_id, effective_from)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01'), ($1, $6, $3, $7, $5, '2026-04-01')`,
    [schoolA, staffA, yearA, sectionA, subjectMath, otherStaff, otherSection],
  )
  await pool.query(
    `INSERT INTO timetable_entries
       (school_id, academic_year_id, section_id, day_of_week, period_index, subject_id, staff_id, room_number)
     VALUES ($1, $2, $3, 1, 1, $4, $5, '12'), ($1, $2, $6, 2, 1, $4, $7, NULL)`,
    [schoolA, yearA, sectionA, subjectMath, staffA, otherSection, otherStaff],
  )
  await pool.query(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     VALUES ($1, $2, $3, $4, '2026-04-01')`,
    [schoolA, studentA2, yearA, sectionA],
  )
  await pool.query(
    `INSERT INTO bell_schedules
       (id, school_id, academic_year_id, name, grade_ids, working_days, periods)
     VALUES ($1, $2, $3, 'Main', '{}'::uuid[], '{1,2}'::smallint[], $4::jsonb)`,
    [
      bellSchedule,
      schoolA,
      yearA,
      JSON.stringify([
        { index: 1, name: 'Assembly', startTime: '08:00', endTime: '08:40', type: 'period' },
        { index: 2, name: 'Period 2', startTime: '08:40', endTime: '09:20', type: 'period' },
      ]),
    ],
  )

  await setFixturePassword(server, fixtureIds.adultUser as string, PASSWORD)
  await setFixturePassword(server, fixtureIds.parentA2User as string, PASSWORD)
  owner = await signInWithMfa(server, {
    userId: fixtureIds.ownerAUser as string,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  for (const table of [
    'timetable_entries',
    'teaching_assignments',
    'bell_schedules',
    'enrollments',
    'grade_subjects',
    'export_jobs',
  ]) {
    await pool.query(`DELETE FROM ${table} WHERE school_id = $1`, [schoolA])
  }
  await pool.query('DELETE FROM staff WHERE id = $1', [otherStaff])
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [fixtureIds.ownerAUser])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [
    fixtureIds.ownerAUser,
  ])
  await server.close()
  await closeAdminPool()
})

test('a timetable export needs a session and the right school', async () => {
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/timetable/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(teacherView(staffA, 'xlsx')),
  })
  assert.equal(anonymous.status, 401)

  const wrongSchool = await requestExport(owner, teacherView(staffA, 'xlsx'), schoolB)
  assert.equal(wrongSchool.status, 403)
  assert.equal(await errorCode(wrongSchool), 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('a teacher exports their own week as a spreadsheet', async () => {
  const response = await requestExport(teacher, teacherView(staffA, 'xlsx'))
  assert.equal(response.status, 202)
  const job = (await response.json()) as JobBody
  assert.equal(job.status, 'ready')
  assert.equal(job.format, 'xlsx')

  const stored = await adminPool().query<{ kind: string; permission: string; row_count: number }>(
    'SELECT kind, permission, row_count FROM export_jobs WHERE id = $1',
    [job.id],
  )
  assert.equal(stored.rows[0]?.kind, 'timetable')
  assert.equal(stored.rows[0]?.permission, 'timetable.read')
  // Their own week holds one period and nothing from the class they do not
  // teach, even though the other class sits in the same year.
  assert.equal(stored.rows[0]?.row_count, 1)

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load((await readExportFileBytes(server, job.id)) as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  assert.ok(sheet)
  // Rows are periods and columns are days, named by the year's bell schedule.
  assert.equal(sheet.getRow(1).getCell(1).value, 'Period')
  assert.equal(sheet.getRow(1).getCell(2).value, 'Monday')
  // The period is named by the bell schedule, with its times beside the name.
  assert.ok(String(sheet.getRow(2).getCell(1).value).startsWith('Assembly'))
  assert.ok(String(sheet.getRow(2).getCell(2).value).includes('Room 12'))
})

test('a teacher exports their own week as a document', async () => {
  const response = await requestExport(teacher, teacherView(staffA, 'pdf'))
  assert.equal(response.status, 202)
  const job = (await response.json()) as JobBody
  assert.equal(job.status, 'ready')
  assert.equal(job.format, 'pdf')
  assert.ok(job.fileName?.endsWith('.pdf'))
  const bytes = await readExportFileBytes(server, job.id)
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-')

  const file = await teacher.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'application/pdf')
})

test("a teacher cannot export a colleague's week or a class they do not teach", async () => {
  const before = await adminPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1',
    [schoolA],
  )
  // A week this teacher may not read is decided at the route, so it answers
  // like a person or a class that is not there and writes no job at all.
  const colleague = await requestExport(teacher, teacherView(otherStaff, 'xlsx'))
  assert.equal(colleague.status, 404)
  assert.equal(await errorCode(colleague), 'RESOURCE_NOT_FOUND')

  const otherClass = await requestExport(teacher, sectionView(otherSection, 'xlsx'))
  assert.equal(otherClass.status, 404)
  assert.equal(await errorCode(otherClass), 'RESOURCE_NOT_FOUND')

  const after_ = await adminPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1',
    [schoolA],
  )
  assert.equal(after_.rows[0]?.total, before.rows[0]?.total)
})

test('the office exports any class it may read', async () => {
  const response = await requestExport(owner, sectionView(otherSection, 'xlsx'))
  assert.equal(response.status, 202)
  const job = (await response.json()) as JobBody
  assert.equal(job.status, 'ready')

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load((await readExportFileBytes(server, job.id)) as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  assert.ok(sheet)
  // A class week names the teacher of each period.
  assert.equal(sheet.getRow(1).getCell(2).value, 'Tuesday')
  assert.ok(String(sheet.getRow(2).getCell(2).value).includes('Other Teacher'))
})

test("a parent exports their child's class and no other", async () => {
  const child = await requestExport(parent, sectionView(sectionA, 'pdf'))
  assert.equal(child.status, 202)
  assert.equal(((await child.json()) as JobBody).status, 'ready')

  const other = await requestExport(parent, sectionView(otherSection, 'pdf'))
  assert.equal(other.status, 404)
  assert.equal(await errorCode(other), 'RESOURCE_NOT_FOUND')
})

test('a year that names nothing and a format that is not offered write no job', async () => {
  const before = await adminPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1',
    [schoolA],
  )
  const unknownYear = await requestExport(owner, {
    academicYearId: randomUUID(),
    format: 'xlsx',
    view: { kind: 'section', sectionId: sectionA },
  })
  // A body value that names nothing is bad input here, exactly as it is on
  // the grid routes this export reads through.
  assert.equal(unknownYear.status, 400)
  assert.equal(await errorCode(unknownYear), 'INVALID_REQUEST')

  const badBody = await requestExport(owner, {
    academicYearId: yearA,
    format: 'csv',
    view: { kind: 'section', sectionId: sectionA },
  })
  assert.equal(badBody.status, 400)
  assert.equal(await errorCode(badBody), 'INVALID_REQUEST')

  const after_ = await adminPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1',
    [schoolA],
  )
  assert.equal(after_.rows[0]?.total, before.rows[0]?.total)
})
