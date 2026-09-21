/**
 * Matrix rows: class-teacher-section-scope.
 *
 * A class teacher looks after a whole class, whether or not they teach a
 * subject in it, so being one counts for the assigned_sections scope. That is
 * a wider read than before, so this file asks where it stops: only their own
 * section, only while the year is open, only while they hold the post, and
 * never across schools.
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
  createTeacher,
  ensureSection,
  ensureSubject,
  signInMember,
  type Client,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string

const suffix = randomUUID().slice(0, 8)

let server: TestServer
let teacher: Awaited<ReturnType<typeof createTeacher>>
let teacherClient: Client

let ownSection = ''
let otherSection = ''
let closedSection = ''
let sectionInSchoolB = ''
let ownPupil = ''
let otherPupil = ''

interface SectionRow { id: string; classTeacher?: { id: string; name: string } }
interface Page<T> { items: T[]; total: number }

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()

  const subjectId = await ensureSubject(schoolA, `CT-SUB-${suffix}`)
  ownSection = await ensureSection(schoolA, yearA, gradeA, `CT-1-${suffix}`)
  otherSection = await ensureSection(schoolA, yearA, gradeA, `CT-2-${suffix}`)

  // A year that is over. Being the class teacher of a class in it is history.
  const closedYear = randomUUID()
  await pool.query(
    `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
     VALUES ($1, $2, $3, '2019-04-01', '2020-03-31', 'closed')`,
    [closedYear, schoolA, `ct-${suffix}`],
  )
  closedSection = await ensureSection(schoolA, closedYear, gradeA, `CT-C-${suffix}`)
  // The neighbouring school has a class of its own, with the same person's id
  // nowhere near it: an id from there must read as missing through our path.
  const yearB = randomUUID()
  const gradeB = randomUUID()
  await pool.query(
    `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
     VALUES ($1, $2, $3, '2026-04-01', '2027-03-31', 'upcoming')`,
    [yearB, schoolB, `ct-b-${suffix}`],
  )
  await pool.query(
    `INSERT INTO grades (id, school_id, name, short_name, sort_order) VALUES ($1, $2, $3, $4, 900)`,
    [gradeB, schoolB, `CT Grade ${suffix}`, `CT${suffix.slice(0, 4)}`],
  )
  sectionInSchoolB = await ensureSection(schoolB, yearB, gradeB, `CT-B-${suffix}`)

  // The point of the file: this teacher teaches no subject anywhere.
  teacher = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [],
    subjectId,
    employeeCode: `CT-T-${suffix}`,
  })
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = ANY($1::uuid[])', [
    [ownSection, closedSection],
    teacher.staffId,
  ])
  teacherClient = await signInMember(server, teacher)

  ownPupil = await createEnrolledStudent({
    schoolId: schoolA, academicYearId: yearA, sectionId: ownSection,
    firstName: 'Own Pupil', admissionNumber: `CT/${suffix}/001`, rollNumber: 1,
  })
  otherPupil = await createEnrolledStudent({
    schoolId: schoolA, academicYearId: yearA, sectionId: otherSection,
    firstName: 'Other Pupil', admissionNumber: `CT/${suffix}/002`, rollNumber: 1,
  })
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

test('[class-teacher-section-scope] a class teacher reads their own section and nobody else\'s', async () => {
  const list = await body<SectionRow[]>(await teacherClient.fetch(`/api/schools/${schoolA}/sections`))
  assert.deepEqual(list.map((row) => row.id), [ownSection])
  assert.equal(list[0]?.classTeacher?.id, teacher.staffId)

  const mine = await teacherClient.fetch(`/api/schools/${schoolA}/sections/${ownSection}`)
  assert.equal(mine.status, 200)
  const theirs = await teacherClient.fetch(`/api/schools/${schoolA}/sections/${otherSection}`)
  assert.equal(await codeOf(theirs), 'RESOURCE_NOT_FOUND')
})

test('[class-teacher-section-scope] a closed year and another school stay out of reach', async () => {
  const closed = await teacherClient.fetch(`/api/schools/${schoolA}/sections/${closedSection}`)
  assert.equal(await codeOf(closed), 'RESOURCE_NOT_FOUND')
  const foreign = await teacherClient.fetch(`/api/schools/${schoolA}/sections/${sectionInSchoolB}`)
  assert.equal(await codeOf(foreign), 'RESOURCE_NOT_FOUND')
  const otherSchool = await teacherClient.fetch(`/api/schools/${schoolB}/sections`)
  assert.equal(await codeOf(otherSchool), 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('[class-teacher-section-scope] the pupils follow the section: a list holds a row only when its detail read would', async () => {
  const roster = await body<Page<{ id: string }>>(
    await teacherClient.fetch(`/api/schools/${schoolA}/students?pageSize=100`),
  )
  assert.deepEqual(roster.items.map((row) => row.id), [ownPupil])
  assert.equal(roster.total, 1)

  const mine = await teacherClient.fetch(`/api/schools/${schoolA}/students/${ownPupil}`)
  assert.equal(mine.status, 200)
  const theirs = await teacherClient.fetch(`/api/schools/${schoolA}/students/${otherPupil}`)
  assert.equal(await codeOf(theirs), 'RESOURCE_NOT_FOUND')
})

test('[class-teacher-section-scope] the post gives no way to change the section', async () => {
  const detail = await body<{ allowedActions: string[] }>(
    await teacherClient.fetch(`/api/schools/${schoolA}/sections/${ownSection}`),
  )
  assert.equal(detail.allowedActions.includes('sections.manage'), false)
  const removed = await teacherClient.fetch(`/api/schools/${schoolA}/sections/${ownSection}`, { method: 'DELETE' })
  assert.equal(await codeOf(removed), 'ACCESS_DENIED')
})

test('[class-teacher-section-scope] losing the post loses the section at once', async () => {
  await adminPool().query('UPDATE sections SET class_teacher_staff_id = NULL WHERE id = $1', [ownSection])
  // With the post gone this teacher has no class at all, so the gate itself
  // refuses them, exactly as it refuses a teacher who was never given one.
  const list = await teacherClient.fetch(`/api/schools/${schoolA}/sections`)
  assert.equal(await codeOf(list), 'ACCESS_DENIED')
  for (const path of [`sections/${ownSection}`, `students/${ownPupil}`]) {
    const gone = await teacherClient.fetch(`/api/schools/${schoolA}/${path}`)
    assert.ok(['ACCESS_DENIED', 'RESOURCE_NOT_FOUND'].includes(await codeOf(gone)), path)
  }
})
