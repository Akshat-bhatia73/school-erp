/**
 * Matrix rows: directory-filter-scope, class-teacher-name-scope, promotion-page-scope.
 *
 * Task 18 widened what several screens may read: the member directory now
 * filters on the server, a section names its class teacher, and a promotion
 * roster pages instead of stopping at a hundred. Each of those is a new place
 * a name or a roll could reach the wrong person, so this file asks the
 * adversarial questions: can a filter be used as a lookup by someone with no
 * directory key, can a name be fished out of another school through our own
 * path, and does a page of a roster follow the same read plan as the first.
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
  postBody,
  signInMember,
  signInOffice,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string

const suffix = randomUUID().slice(0, 8)

let server: TestServer
let owner: Member
let ownerClient: Client
let teacher: Awaited<ReturnType<typeof createTeacher>>
let teacherClient: Client
let parent: Member
let parentClient: Client
let ownerB: Member
let ownerBClient: Client

let ownSection = ''
let bigSection = ''
let nextYear = ''
let nextSection = ''
let staffInSchoolB = ''
let colleagueStaffId = ''

/** A roster larger than one page, so paging is exercised rather than argued about. */
const BIG_ROLL = 130

interface Page<T> { items: T[]; total: number }
interface MemberRow { id: string; displayName: string }
interface SectionRow {
  id: string
  classTeacherId?: string
  classTeacher?: { id: string; name: string }
}
interface PreviewPage { students: { id: string }[]; total: number; page: number; pageSize: number }

function membersPath(schoolId: string, query: string): string {
  return `/api/schools/${schoolId}/members${query}`
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()

  const subjectId = await ensureSubject(schoolA, `GAP-SUB-${suffix}`)
  ownSection = await ensureSection(schoolA, yearA, gradeA, `GAP-1-${suffix}`)
  bigSection = await ensureSection(schoolA, yearA, gradeA, `GAP-2-${suffix}`)

  owner = await createMember(schoolA, ['owner'], 'Gap Owner')
  ownerClient = await signInOffice(server, owner)

  teacher = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [ownSection, bigSection],
    subjectId,
    employeeCode: `GAP-T-${suffix}`,
  })
  teacherClient = await signInMember(server, teacher)

  // A colleague the teacher has no directory key for, put in charge of the
  // class the teacher only teaches in.
  colleagueStaffId = randomUUID()
  await pool.query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, last_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Gap', 'Colleague', 'teaching', 'Teacher', 'active')`,
    [colleagueStaffId, schoolA, `GAP-C-${suffix}`],
  )
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [
    bigSection,
    colleagueStaffId,
  ])
  await pool.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [
    ownSection,
    teacher.staffId,
  ])

  // The neighbouring school's own member of staff: a real row, and one this
  // school must never be able to name through its own path.
  staffInSchoolB = randomUUID()
  await pool.query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, last_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Neighbour', 'Secret', 'teaching', 'Teacher', 'active')`,
    [staffInSchoolB, schoolB, `GAP-B-${suffix}`],
  )
  ownerB = await createMember(schoolB, ['owner'], 'Gap Owner B')
  ownerBClient = await signInOffice(server, ownerB)

  parent = await createMember(schoolA, ['parent'], 'Gap Parent')
  parentClient = await signInMember(server, parent)

  // Next year, for the promotion roster.
  nextYear = randomUUID()
  await pool.query(
    `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
     VALUES ($1, $2, $3, '2027-04-01', '2028-03-31', 'upcoming')`,
    [nextYear, schoolA, `gap-${suffix}`],
  )
  nextSection = await ensureSection(schoolA, nextYear, gradeA, `GAP-N-${suffix}`)

  for (let index = 1; index <= BIG_ROLL; index += 1) {
    await createEnrolledStudent({
      schoolId: schoolA,
      academicYearId: yearA,
      sectionId: bigSection,
      firstName: 'Gap Pupil',
      admissionNumber: `GAP/${suffix}/${String(index).padStart(3, '0')}`,
      rollNumber: index,
    })
  }
})

after(async () => {
  await forgetTwoFactor([owner.userId, ownerB.userId])
  await server.close()
  await closeAdminPool()
})

test('[directory-filter-scope] a filter is not a way round the directory key', async () => {
  // A teacher holds no members.read, with or without a filter that would make
  // the answer a single row.
  for (const query of [
    '',
    '?search=Gap',
    '?role=owner',
    '?status=suspended',
    `?staffId=${teacher.staffId}`,
  ]) {
    const response = await teacherClient.fetch(membersPath(schoolA, query))
    assert.equal(response.status, 403, query)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', query)
  }

  const asParent = await parentClient.fetch(membersPath(schoolA, '?search=Gap'))
  assert.equal(asParent.status, 403)
  assert.equal(await codeOf(asParent), 'ACCESS_DENIED')
})

test('[directory-filter-scope] a school id in the path is not a school the caller belongs to', async () => {
  const across = await ownerClient.fetch(membersPath(schoolB, `?staffId=${staffInSchoolB}`))
  assert.equal(across.status, 403)
  const refusal = await across.text()
  assert.equal(JSON.parse(refusal).error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
  assert.equal(refusal.includes('Neighbour'), false)

  // The same id through our own path is simply nobody, not a refusal that
  // would confirm the record exists.
  const mine = await ownerClient.fetch(membersPath(schoolA, `?staffId=${staffInSchoolB}`))
  assert.equal(mine.status, 200)
  const page = await body<Page<MemberRow>>(mine)
  assert.equal(page.total, 0)
  assert.deepEqual(page.items, [])
})

test('[directory-filter-scope] a search never reaches across the school boundary', async () => {
  const here = await ownerClient.fetch(membersPath(schoolA, '?pageSize=100&search=Gap Owner B'))
  assert.equal(here.status, 200)
  const page = await body<Page<MemberRow>>(here)
  assert.equal(page.items.some((row) => row.id === ownerB.membershipId), false)

  // The neighbour looking for our people finds none of them either.
  const there = await ownerBClient.fetch(membersPath(schoolB, '?pageSize=100&search=Gap'))
  assert.equal(there.status, 200)
  const theirs = await body<Page<MemberRow>>(there)
  assert.equal(theirs.items.some((row) => row.id === owner.membershipId), false)
  assert.equal(theirs.items.some((row) => row.id === teacher.membershipId), false)
})

test('[class-teacher-name-scope] a section names a teacher only to a reader of that record', async () => {
  const office = await body<SectionRow[]>(
    await ownerClient.fetch(`/api/schools/${schoolA}/sections?academicYearId=${yearA}`),
  )
  assert.equal(office.find((row) => row.id === bigSection)?.classTeacher?.id, colleagueStaffId)

  // The teacher reads their own staff record and nobody else's, so the class
  // they only teach in gives them an id and no name.
  const theirs = await body<SectionRow[]>(
    await teacherClient.fetch(`/api/schools/${schoolA}/sections?academicYearId=${yearA}`),
  )
  const taught = theirs.find((row) => row.id === bigSection)
  assert.ok(taught)
  assert.equal(taught.classTeacherId, colleagueStaffId)
  assert.equal('classTeacher' in taught, false)
  assert.equal(JSON.stringify(theirs).includes('Colleague'), false)

  // Their own class does name them, which is what the screen shows.
  assert.equal(theirs.find((row) => row.id === ownSection)?.classTeacher?.id, teacher.staffId)
})

test('[class-teacher-name-scope] a teacher from another school cannot be written into our section', async () => {
  const detail = await body<SectionRow & { name: string; version: number }>(
    await ownerClient.fetch(`/api/schools/${schoolA}/sections/${ownSection}`),
  )
  const refused = await ownerClient.fetch(`/api/schools/${schoolA}/sections/${ownSection}`, {
    ...postBody({
      name: detail.name,
      classTeacherStaffId: staffInSchoolB,
      expectedVersion: detail.version,
    }),
    method: 'PUT',
  })
  assert.equal(refused.status, 400)
  assert.equal(await codeOf(refused), 'INVALID_REQUEST')
  const kept = await adminPool().query<{ class_teacher_staff_id: string }>(
    'SELECT class_teacher_staff_id FROM sections WHERE id = $1',
    [ownSection],
  )
  assert.equal(kept.rows[0]?.class_teacher_staff_id, teacher.staffId)
})

test('[promotion-page-scope] every page of a roster follows the same read plan', async () => {
  const query =
    `?fromAcademicYearId=${yearA}&toAcademicYearId=${nextYear}` +
    `&fromSectionId=${bigSection}&toSectionId=${nextSection}`
  const path = `/api/schools/${schoolA}/students/promote/preview${query}`

  const first = await body<PreviewPage>(await ownerClient.fetch(path))
  assert.equal(first.total, BIG_ROLL)
  assert.equal(first.students.length, 100)
  const second = await body<PreviewPage>(await ownerClient.fetch(`${path}&page=2`))
  assert.equal(second.students.length, BIG_ROLL - 100)
  const everyone = new Set([...first.students, ...second.students].map((pupil) => pupil.id))
  assert.equal(everyone.size, BIG_ROLL)

  // A page past the end is empty rather than a wrap around to the first page.
  const beyond = await body<PreviewPage>(await ownerClient.fetch(`${path}&page=9`))
  assert.deepEqual(beyond.students, [])
  assert.equal(beyond.total, BIG_ROLL)

  // A teacher holds no promote key, so neither page is theirs to read and
  // nothing moves.
  for (const page of ['', '&page=2']) {
    const refused = await teacherClient.fetch(`${path}${page}`)
    assert.equal(refused.status, 403)
    assert.equal(await codeOf(refused), 'ACCESS_DENIED')
  }
  const promote = await teacherClient.fetch(
    `/api/schools/${schoolA}/students/promote`,
    postBody({
      fromAcademicYearId: yearA,
      toAcademicYearId: nextYear,
      fromSectionId: bigSection,
      toSectionId: nextSection,
      studentIds: [first.students[0]?.id],
      detainedStudentIds: [],
      reason: 'Year end promotion',
    }),
  )
  assert.equal(promote.status, 403)
  assert.equal(await codeOf(promote), 'ACCESS_DENIED')
  const moved = await adminPool().query<{ total: number }>(
    `SELECT count(*)::int AS total FROM enrollments
      WHERE school_id = $1 AND academic_year_id = $2`,
    [schoolA, nextYear],
  )
  assert.equal(moved.rows[0]?.total, 0)
})
