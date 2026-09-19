import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
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
const OWNER_EMAIL = `profile-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `profile-teacher-${randomUUID()}@example.test`
const PARENT_EMAIL = `profile-parent-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const sectionA = fixtureIds.sectionA as string
const staffA = fixtureIds.staffA as string
const studentA2 = fixtureIds.studentA2 as string
const staffB = fixtureIds.staffB as string

// Rows this file inserts itself, so every assertion is about known data.
const suffix = randomUUID().slice(0, 8)
const otherSection = randomUUID()
const subjectId = randomUUID()
const colleague = randomUUID()
let taughtStudent = ''
let otherStudent = ''
let movedStudent = ''

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let teacher: Client
let parent: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code
}

interface JobBody {
  id: string
  status: string
  fileName?: string
  format?: string
}

/** A student in one of this school's classes, created outside the API. */
async function seatStudent(sectionId: string): Promise<string> {
  const pool = adminPool()
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO students
       (school_id, admission_number, first_name, last_name, status, date_of_birth, gender)
     VALUES ($1, $2, 'Seated', 'Child', 'active', '2014-06-01', 'male') RETURNING id`,
    [schoolA, `PROF-${suffix}-${randomUUID().slice(0, 6)}`],
  )
  const id = inserted.rows[0]?.id as string
  await pool.query(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     VALUES ($1, $2, $3, $4, current_date)`,
    [schoolA, id, yearA, sectionId],
  )
  return id
}

function studentExport(student: string, school = schoolA): string {
  return `/api/schools/${school}/students/${student}/export-profile`
}

function staffExport(person: string, school = schoolA): string {
  return `/api/schools/${school}/staff/${person}/export-profile`
}

async function post(client: Client, path: string): Promise<Response> {
  return client.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  // This file counts the export jobs of the fixture school exactly, so it
  // starts from an empty table rather than whatever ran before it.
  await pool.query('DELETE FROM export_jobs WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM enrollments WHERE school_id = $1', [schoolA])

  for (const [userId, email] of [
    [fixtureIds.ownerAUser as string, OWNER_EMAIL],
    [fixtureIds.adultUser as string, TEACHER_EMAIL],
    [fixtureIds.parentA2User as string, PARENT_EMAIL],
  ] as const) {
    await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [userId, email])
  }

  await pool.query(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES ($1, $2, $3, $4, $5)`,
    [otherSection, schoolA, yearA, gradeA, `P-${suffix}`],
  )
  await pool.query(
    `INSERT INTO subjects (id, school_id, name, code, type)
     VALUES ($1, $2, $3, $4, 'scholastic')`,
    [subjectId, schoolA, `Maths ${suffix}`, `PMT-${suffix}`],
  )
  await pool.query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, last_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Colleague', 'Kumar', 'teaching', 'Teacher', 'active')`,
    [colleague, schoolA, `PCOL-${suffix}`],
  )
  // The teacher teaches one class and no other, which is what a section scope
  // means: the grant alone allows nothing.
  await pool.query(
    `INSERT INTO teaching_assignments
       (school_id, staff_id, academic_year_id, section_id, subject_id, effective_from)
     VALUES ($1, $2, $3, $4, $5, '2026-04-01')`,
    [schoolA, staffA, yearA, sectionA, subjectId],
  )
  await pool.query(
    `INSERT INTO role_permissions (school_id, role_id, permission, scope)
     SELECT $1, r.id, 'students.export', 'assigned_sections'
       FROM roles r WHERE r.school_id = $1 AND r.key = 'teacher'
     ON CONFLICT DO NOTHING`,
    [schoolA],
  )

  taughtStudent = await seatStudent(sectionA)
  otherStudent = await seatStudent(otherSection)
  // The parent's own child, so the parent case is a real reader of that record
  // rather than somebody with no connection to it at all.
  await pool.query(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     VALUES ($1, $2, $3, $4, current_date)`,
    [schoolA, studentA2, yearA, otherSection],
  )

  await setFixturePassword(server, fixtureIds.adultUser as string, PASSWORD)
  await setFixturePassword(server, fixtureIds.parentA2User as string, PASSWORD)
  owner = await signInWithMfa(server, {
    userId: fixtureIds.ownerAUser as string,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  // Exporting is privileged whichever scope allows it, so the teacher needs a
  // second factor too.
  teacher = await signInWithMfa(server, {
    userId: fixtureIds.adultUser as string,
    email: TEACHER_EMAIL,
    password: PASSWORD,
  })
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM export_jobs WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM enrollments WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM students WHERE id = ANY($1::uuid[])', [
    [taughtStudent, otherStudent, movedStudent].filter((id) => id !== ''),
  ])
  await pool.query('DELETE FROM staff WHERE id = $1', [colleague])
  await pool.query(
    `DELETE FROM role_permissions WHERE school_id = $1 AND permission = 'students.export'
       AND scope = 'assigned_sections'`,
    [schoolA],
  )
  for (const userId of [fixtureIds.ownerAUser as string, fixtureIds.adultUser as string]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  await server.close()
  await closeAdminPool()
})

test('a student profile export needs a session and the right school', async () => {
  const anonymous = await fetch(`${server.origin}${studentExport(taughtStudent)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(anonymous.status, 401)

  const wrongSchool = await post(owner, studentExport(taughtStudent, schoolB))
  assert.equal(wrongSchool.status, 403)
  assert.equal(await codeOf(wrongSchool), 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('the owner exports one student as a document and downloads it', async () => {
  const response = await post(owner, studentExport(taughtStudent))
  assert.equal(response.status, 202)
  const job = (await response.json()) as JobBody
  assert.equal(job.status, 'ready')
  assert.equal(job.format, 'pdf')
  assert.ok(job.fileName?.endsWith('.pdf'))

  const stored = await adminPool().query<{ kind: string; permission: string; row_count: number }>(
    'SELECT kind, permission, row_count FROM export_jobs WHERE id = $1',
    [job.id],
  )
  assert.equal(stored.rows[0]?.kind, 'student_profile')
  assert.equal(stored.rows[0]?.permission, 'students.export')
  assert.equal(stored.rows[0]?.row_count, 1)

  const bytes = await readExportFileBytes(server, job.id)
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-')

  const file = await owner.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(file.status, 200)
  assert.equal(file.headers.get('content-type'), 'application/pdf')
  assert.equal(
    (await file.arrayBuffer()).byteLength,
    bytes.byteLength,
    'the download hands over the same file',
  )
})

test('a teacher exports a child of their own class and not one outside it', async () => {
  const mine = await post(teacher, studentExport(taughtStudent))
  assert.equal(mine.status, 202)
  assert.equal(((await mine.json()) as JobBody).status, 'ready')

  const before = await adminPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1',
    [schoolA],
  )
  const outside = await post(teacher, studentExport(otherStudent))
  // A record they may not export answers exactly like one that is not there.
  assert.equal(outside.status, 404)
  assert.equal(await codeOf(outside), 'RESOURCE_NOT_FOUND')
  const after_ = await adminPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1',
    [schoolA],
  )
  assert.equal(after_.rows[0]?.total, before.rows[0]?.total)
})

test('a parent may not export their own child as a document', async () => {
  const response = await post(parent, studentExport(studentA2))
  assert.equal(response.status, 403)
  assert.equal(await codeOf(response), 'ACCESS_DENIED')
})

test('a document holds only the blocks its reader may see', async () => {
  // The same student, exported twice. The owner reads the personal and health
  // blocks and the guardian contacts; the teacher reads none of them, so the
  // teacher's document is the smaller of the two. The text itself is not
  // asserted because the pages embed a subset font, which stores glyphs rather
  // than readable words.
  const pool = adminPool()
  await pool.query(
    `UPDATE students SET address = to_jsonb($2::text), blood_group = 'O+',
            medical_notes = 'Carries an inhaler'
      WHERE id = $1`,
    [taughtStudent, '12 Export Road, Pune'],
  )

  const ownerJob = (await (await post(owner, studentExport(taughtStudent))).json()) as JobBody
  const teacherJob = (await (await post(teacher, studentExport(taughtStudent))).json()) as JobBody
  const ownerBytes = await readExportFileBytes(server, ownerJob.id)
  const teacherBytes = await readExportFileBytes(server, teacherJob.id)
  assert.ok(
    teacherBytes.byteLength < ownerBytes.byteLength,
    'the reader with fewer permissions gets the shorter document',
  )
})

test('the staff profile export is refused to a teacher and allowed to the office', async () => {
  const refused = await post(teacher, staffExport(colleague))
  // The teacher holds no staff.export anywhere, so this never reaches a record.
  assert.equal(refused.status, 403)
  assert.equal(await codeOf(refused), 'ACCESS_DENIED')

  const response = await post(owner, staffExport(colleague))
  assert.equal(response.status, 202)
  const job = (await response.json()) as JobBody
  assert.equal(job.status, 'ready')
  assert.equal(job.format, 'pdf')
  const stored = await adminPool().query<{ kind: string; permission: string }>(
    'SELECT kind, permission FROM export_jobs WHERE id = $1',
    [job.id],
  )
  assert.equal(stored.rows[0]?.kind, 'staff_profile')
  assert.equal(stored.rows[0]?.permission, 'staff.export')
  const bytes = await readExportFileBytes(server, job.id)
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), '%PDF-')
})

test('a staff record of the other school is simply not there', async () => {
  const response = await post(owner, staffExport(staffB))
  assert.equal(response.status, 404)
  assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
})

test('a malformed record id answers like a missing record', async () => {
  const response = await post(owner, studentExport('not-a-uuid'))
  assert.equal(response.status, 404)
  assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
})

test('an export body carrying a field writes nothing', async () => {
  const before = await adminPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1',
    [schoolA],
  )
  const response = await owner.fetch(studentExport(taughtStudent), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fields: ['aadhaar'] }),
  })
  assert.equal(response.status, 400)
  assert.equal(await codeOf(response), 'INVALID_REQUEST')
  const after_ = await adminPool().query<{ total: number }>(
    'SELECT count(*)::int AS total FROM export_jobs WHERE school_id = $1',
    [schoolA],
  )
  assert.equal(after_.rows[0]?.total, before.rows[0]?.total)
})

test('a file stops being downloadable when its record leaves the reader', async () => {
  // The teacher exports a child of their own class, and the child then moves
  // to a class they do not teach. The job was decided once when it was asked
  // for; the download decides the record again, so the file goes with the
  // child rather than staying with whoever holds it.
  movedStudent = await seatStudent(sectionA)
  const requested = await post(teacher, studentExport(movedStudent))
  assert.equal(requested.status, 202)
  const job = (await requested.json()) as JobBody
  assert.equal(job.status, 'ready')

  const mine = await teacher.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(mine.status, 200)
  await mine.arrayBuffer()

  await adminPool().query(
    'UPDATE enrollments SET section_id = $2 WHERE school_id = $3 AND student_id = $1',
    [movedStudent, otherSection, schoolA],
  )

  const after_ = await teacher.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(after_.status, 404)
  assert.equal(await codeOf(after_), 'RESOURCE_NOT_FOUND')
  const stored = await adminPool().query<{ status: string }>(
    'SELECT status FROM export_jobs WHERE id = $1',
    [job.id],
  )
  assert.equal(stored.rows[0]?.status, 'expired')
})
