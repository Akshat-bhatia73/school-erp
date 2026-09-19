/**
 * Matrix rows: cross-school-export, wrong-person-export, export-file-download.
 *
 * An export turns records into bytes somebody keeps, so every refusal has to
 * happen before the file exists and the file itself has to stay tied to the
 * one person who asked for it. Each test reads the permitted answer first and
 * only then asks for the record, the week or the job next to it.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createEnrolledStudent,
  createMember,
  createTeacher,
  ensureSection,
  ensureSubject,
  forgetTwoFactor,
  grantPortalAccess,
  postBody,
  signInMember,
  signInOffice,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const studentB = fixtureIds.studentB as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const staffA = fixtureIds.staffA as string

const suffix = randomUUID().slice(0, 8)

let server: TestServer
let owner: Member
let ownerClient: Client
let colleague: Member
let colleagueClient: Client
let teacher: Awaited<ReturnType<typeof createTeacher>>
let teacherClient: Client
let parent: Member
let parentClient: Client

let ownSection = ''
let otherSection = ''
let ownPupil = ''
let otherPupil = ''
let childId = ''

/** School B's own year, grade, section and staff, used only as foreign ids. */
const foreign = { yearId: '', gradeId: '', sectionId: '', staffId: '' }

interface Job {
  id: string
  status: string
  fileName?: string
  format?: string
}

/** Every export job of this school, newest first, straight from the table. */
async function jobsOf(schoolId: string): Promise<{ id: string; kind: string; status: string }[]> {
  const found = await adminPool().query<{ id: string; kind: string; status: string }>(
    `SELECT id, kind, status FROM export_jobs WHERE school_id = $1 ORDER BY created_at DESC`,
    [schoolId],
  )
  return found.rows
}

async function auditCount(targetId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events WHERE target_id = $1`,
    [targetId],
  )
  return Number(found.rows[0]?.count)
}

/** The rows of school B this suite points school A's routes at. */
async function seedForeignSchool(): Promise<void> {
  const pool = adminPool()
  const year = await pool.query<{ id: string }>(
    `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
     VALUES (gen_random_uuid(), $1, $2, '2026-04-01', '2027-03-31', 'current') RETURNING id`,
    [schoolB, `EXP-Y-${suffix}`],
  )
  foreign.yearId = year.rows[0]?.id as string
  const grade = await pool.query<{ id: string }>(
    `INSERT INTO grades (id, school_id, name, short_name, sort_order)
     VALUES (gen_random_uuid(), $1, $2, 'X', 1) RETURNING id`,
    [schoolB, `EXP-G-${suffix}`],
  )
  foreign.gradeId = grade.rows[0]?.id as string
  const section = await pool.query<{ id: string }>(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES (gen_random_uuid(), $1, $2, $3, $4) RETURNING id`,
    [schoolB, foreign.yearId, foreign.gradeId, `EXP-S-${suffix}`],
  )
  foreign.sectionId = section.rows[0]?.id as string
  const staff = await pool.query<{ id: string }>(
    `INSERT INTO staff (id, school_id, employee_code, first_name, staff_type, designation, status)
     VALUES (gen_random_uuid(), $1, $2, 'Foreign Teacher', 'teaching', 'Teacher', 'active')
     RETURNING id`,
    [schoolB, `EXP-B-${suffix}`],
  )
  foreign.staffId = staff.rows[0]?.id as string
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  await seedForeignSchool()

  const subject = await ensureSubject(schoolA, `EXP-SUB-${suffix}`)
  ownSection = await ensureSection(schoolA, yearA, gradeA, `EXP-1-${suffix}`)
  otherSection = await ensureSection(schoolA, yearA, gradeA, `EXP-2-${suffix}`)
  ownPupil = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId: ownSection,
    firstName: 'Export Own',
    admissionNumber: `EXP/${suffix}/1`,
    rollNumber: 1,
  })
  otherPupil = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId: otherSection,
    firstName: 'Export Other',
    admissionNumber: `EXP/${suffix}/2`,
    rollNumber: 2,
  })
  childId = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId: otherSection,
    firstName: 'Export Child',
    admissionNumber: `EXP/${suffix}/3`,
    rollNumber: 3,
  })

  owner = await createMember(schoolA, ['owner'], 'Export Owner')
  ownerClient = await signInOffice(server, owner)
  colleague = await createMember(schoolA, ['owner'], 'Export Colleague')
  colleagueClient = await signInOffice(server, colleague)

  teacher = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [ownSection],
    subjectId: subject,
    employeeCode: `EXP-T-${suffix}`,
  })
  teacherClient = await signInMember(server, teacher)

  parent = await createMember(schoolA, ['parent'], 'Export Parent')
  await grantPortalAccess({
    schoolId: schoolA,
    membershipId: parent.membershipId,
    studentId: childId,
    approvedBy: owner.membershipId,
  })
  parentClient = await signInMember(server, parent)
})

after(async () => {
  await forgetTwoFactor([owner.userId, colleague.userId])
  await server.close()
  await closeAdminPool()
})

test('[cross-school-export] another school id answers exactly like a missing record', async () => {
  // The permitted half first, so a deny-everything server fails this test.
  const allowed = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${ownPupil}/export-profile`,
    postBody({}),
  )
  assert.equal(allowed.status, 202)

  // School B in the path: the membership gate refuses before any record is read.
  for (const path of [
    `/api/schools/${schoolB}/students/${studentB}/export-profile`,
    `/api/schools/${schoolB}/staff/${foreign.staffId}/export-profile`,
    `/api/schools/${schoolB}/timetable/export`,
  ]) {
    const response = await ownerClient.fetch(path, postBody({}))
    assert.equal(response.status, 403, path)
    assert.equal(await codeOf(response), 'SCHOOL_ACCESS_UNAVAILABLE', path)
  }

  // School B's records under school A's path: the same answer as a record that
  // is simply not there, and no job row that names the foreign id.
  const student = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${studentB}/export-profile`,
    postBody({}),
  )
  assert.equal(student.status, 404)
  assert.equal(await codeOf(student), 'RESOURCE_NOT_FOUND')

  const staff = await ownerClient.fetch(
    `/api/schools/${schoolA}/staff/${foreign.staffId}/export-profile`,
    postBody({}),
  )
  assert.equal(staff.status, 404)
  assert.equal(await codeOf(staff), 'RESOURCE_NOT_FOUND')

  const timetable = await ownerClient.fetch(
    `/api/schools/${schoolA}/timetable/export`,
    postBody({
      academicYearId: foreign.yearId,
      format: 'xlsx',
      view: { kind: 'section', sectionId: foreign.sectionId },
    }),
  )
  // A year of another school is refused the same way every other timetable
  // route refuses a year that is not here, and no week is ever read.
  assert.equal(timetable.status, 400)
  assert.equal(await codeOf(timetable), 'INVALID_REQUEST')

  const leaked = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM export_jobs
      WHERE criteria::text LIKE '%' || $1 || '%'
         OR criteria::text LIKE '%' || $2 || '%'
         OR criteria::text LIKE '%' || $3 || '%'`,
    [studentB, foreign.staffId, foreign.sectionId],
  )
  assert.equal(leaked.rows[0]?.count, '0')
})

test('[cross-school-export] a school A year cannot be paired with a school B section', async () => {
  // The year is this school's, the section is not: the route reads nothing it
  // may read and answers like a section that does not exist, before any job
  // row is written.
  const before = await jobsOf(schoolA)
  const response = await ownerClient.fetch(
    `/api/schools/${schoolA}/timetable/export`,
    postBody({
      academicYearId: yearA,
      format: 'pdf',
      view: { kind: 'section', sectionId: foreign.sectionId },
    }),
  )
  assert.equal(response.status, 404)
  assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
  assert.equal((await jobsOf(schoolA)).length, before.length)
})

test('[wrong-person-export] a teacher exports no record at all, in their own section or outside it', async () => {
  // Exporting a record is an office permission. A teacher reads their own
  // section every day and still cannot take it away as a file, and a person
  // they may not export answers no differently from one they teach: both are
  // refused at the route, so no job row is written either way.
  for (const studentId of [ownPupil, otherPupil]) {
    const response = await teacherClient.fetch(
      `/api/schools/${schoolA}/students/${studentId}/export-profile`,
      postBody({}),
    )
    assert.equal(response.status, 403, studentId)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', studentId)
  }

  // The refusal happened before any job existed, so this teacher has asked
  // for no student file at all.
  const written = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM export_jobs
      WHERE school_id = $1 AND requested_by_membership_id = $2
        AND kind = 'student_profile'`,
    [schoolA, teacher.membershipId],
  )
  assert.equal(written.rows[0]?.count, '0')

  // A staff record is a different permission, which this teacher never holds.
  const colleagueFile = await teacherClient.fetch(
    `/api/schools/${schoolA}/staff/${staffA}/export-profile`,
    postBody({}),
  )
  assert.equal(colleagueFile.status, 403)
  assert.equal(await codeOf(colleagueFile), 'ACCESS_DENIED')
})

test('[wrong-person-export] a teacher exports their own week, not a class they do not teach', async () => {
  const own = await teacherClient.fetch(
    `/api/schools/${schoolA}/timetable/export`,
    postBody({
      academicYearId: yearA,
      format: 'xlsx',
      view: { kind: 'section', sectionId: ownSection },
    }),
  )
  assert.equal(own.status, 202)
  assert.equal((await body<Job>(own)).status, 'ready')

  const other = await teacherClient.fetch(
    `/api/schools/${schoolA}/timetable/export`,
    postBody({
      academicYearId: yearA,
      format: 'xlsx',
      view: { kind: 'section', sectionId: otherSection },
    }),
  )
  // A class they do not teach is refused at the route, exactly like a class
  // that is not there, so no job row and no file were ever made.
  assert.equal(other.status, 404)
  assert.equal(await codeOf(other), 'RESOURCE_NOT_FOUND')
})

test('[wrong-person-export] a parent cannot export a record, a colleague or a file', async () => {
  // Their own child is still not exportable: a parent holds no export permission.
  for (const path of [
    `/api/schools/${schoolA}/students/${childId}/export-profile`,
    `/api/schools/${schoolA}/students/${ownPupil}/export-profile`,
    `/api/schools/${schoolA}/staff/${staffA}/export-profile`,
  ]) {
    const response = await parentClient.fetch(path, postBody({}))
    assert.equal(response.status, 403, path)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', path)
  }

  // The office asks for a roster file, and the parent asks for its bytes.
  const requested = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/export`,
    postBody({ studentIds: [ownPupil] }),
  )
  assert.equal(requested.status, 202)
  const job = await body<Job>(requested)
  assert.equal(job.status, 'ready')

  const status = await parentClient.fetch(`/api/schools/${schoolA}/exports/${job.id}`)
  assert.equal(status.status, 404)
  assert.equal(await codeOf(status), 'RESOURCE_NOT_FOUND')
  const file = await parentClient.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(file.status, 404)

  // A parent may read their own child's week and no other, so a class their
  // child is not in is refused before any job row is written.
  const timetable = await parentClient.fetch(
    `/api/schools/${schoolA}/timetable/export`,
    postBody({
      academicYearId: yearA,
      format: 'pdf',
      view: { kind: 'section', sectionId: ownSection },
    }),
  )
  assert.equal(timetable.status, 404)
  assert.equal(await codeOf(timetable), 'RESOURCE_NOT_FOUND')
})

test('[export-file-download] a ready file belongs to the one member who asked for it', async () => {
  const requested = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${ownPupil}/export-profile`,
    postBody({}),
  )
  assert.equal(requested.status, 202)
  const job = await body<Job>(requested)
  assert.equal(job.status, 'ready')
  assert.equal(job.format, 'pdf')

  const before = await auditCount(job.id)
  const mine = await ownerClient.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(mine.status, 200)
  assert.equal(mine.headers.get('content-type'), 'application/pdf')
  const disposition = mine.headers.get('content-disposition') ?? ''
  assert.ok(disposition.includes('.pdf'))
  // The storage key is server state and must not travel in any header.
  assert.equal(disposition.includes('exports/'), false)
  for (const [, value] of mine.headers) assert.equal(value.includes('exports/'), false)
  assert.ok((await mine.arrayBuffer()).byteLength > 0)
  assert.equal(await auditCount(job.id), before + 1)

  // Another owner of the same school holds every export permission and still
  // cannot see somebody else's job, in either direction.
  const theirs = await colleagueClient.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(theirs.status, 404)
  assert.equal(await codeOf(theirs), 'RESOURCE_NOT_FOUND')
  const status = await colleagueClient.fetch(`/api/schools/${schoolA}/exports/${job.id}`)
  assert.equal(status.status, 404)

  // A job id from nowhere reads exactly the same to a member who may export.
  const missing = await ownerClient.fetch(`/api/schools/${schoolA}/exports/${randomUUID()}/file`)
  assert.equal(missing.status, 404)
  assert.equal(await codeOf(missing), 'RESOURCE_NOT_FOUND')

  // The requester's own job id, carried to a school they do not belong to:
  // the membership gate refuses before the job is ever looked up.
  const elsewhereFile = await ownerClient.fetch(`/api/schools/${schoolB}/exports/${job.id}/file`)
  assert.equal(elsewhereFile.status, 403)
  assert.equal(await codeOf(elsewhereFile), 'SCHOOL_ACCESS_UNAVAILABLE')

  // Nothing in this test left a job behind in another school.
  const elsewhere = await jobsOf(schoolB)
  assert.equal(elsewhere.length, 0)
})
