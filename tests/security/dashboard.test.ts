/**
 * Matrix rows: dashboard-tenant-probe, dashboard-relationship-scope,
 * dashboard-field-boundaries.
 *
 * A dashboard is the one screen that mixes a dozen reads into a single
 * response, so it is the easiest place for a row to escape the plan that
 * should have hidden it. This file asks the adversarial questions: can a
 * teacher of one school pull a row out of another by moving the date, can a
 * teacher see a colleague's periods or a cover in a class they do not teach,
 * can a parent with no approved link see anything of the school, and does any
 * audience's response carry a telephone number, an address, a date of birth or
 * the key of a stored file.
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
  codeOf,
  createEnrolledStudent,
  createMember,
  createTeacher,
  ensureSection,
  ensureSubject,
  forgetTwoFactor,
  grantPortalAccess,
  signInMember,
  signInOffice,
  bumpAccessVersion,
  roleIdFor,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const studentB = fixtureIds.studentB as string
const ownerA = fixtureIds.ownerA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string

const suffix = randomUUID().slice(0, 8)

/** A Monday inside the fixture year, and the Sunday before it. */
const MONDAY = '2026-12-14'
const SUNDAY = '2026-12-13'

const bellScheduleId = randomUUID()

let server: TestServer

let sectionMine = ''
let sectionTheirs = ''
let subjectId = ''
let myStudentId = ''
let theirStudentId = ''

let teacherMine: Member & { staffId: string }
let teacherTheirs: Member & { staffId: string }
let mine: Client
let theirs: Client
let parentOfMine: Client
let lonelyParent: Client
let accountant: Client
let office: Client
let suspended: Client
let suspendedMembershipId = ''

const madeUserIds: string[] = []

/** Everything that must never appear as a key in a dashboard response. */
const FORBIDDEN_KEYS = [
  'phone',
  'email',
  'dateOfBirth',
  'date_of_birth',
  'safe_changes',
  'safeChanges',
  'note',
  'storageKey',
  'storage_key',
  'photoStorageKey',
  'address',
]

function assertNoForbiddenKeys(raw: string, where: string): void {
  for (const key of FORBIDDEN_KEYS) {
    assert.ok(
      !new RegExp(`"${key}"\\s*:`).test(raw),
      `the ${where} dashboard carries a ${key} field`,
    )
  }
}

async function rawDashboard(client: Client, schoolId: string, date?: string): Promise<string> {
  const query = date === undefined ? '' : `?date=${date}`
  const response = await client.fetch(`/api/schools/${schoolId}/dashboard${query}`)
  assert.equal(response.status, 200, `the dashboard answered ${response.status}`)
  return response.text()
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(
    `UPDATE academic_years SET status = 'current' WHERE school_id = $1 AND id = $2`,
    [schoolA, yearA],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [schoolA, yearA])

  server = await startTestServer()

  sectionMine = await ensureSection(schoolA, yearA, gradeA, `SEC-M-${suffix}`)
  sectionTheirs = await ensureSection(schoolA, yearA, gradeA, `SEC-T-${suffix}`)
  subjectId = await ensureSubject(schoolA, `SEC-${suffix}`)

  teacherMine = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionMine],
    subjectId,
    employeeCode: `A-SEC-M-${suffix}`,
  })
  teacherTheirs = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionTheirs],
    subjectId,
    employeeCode: `A-SEC-T-${suffix}`,
  })

  myStudentId = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId: sectionMine,
    firstName: 'Mine',
    admissionNumber: `SEC-M-${suffix}`,
    rollNumber: 1,
  })
  theirStudentId = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId: sectionTheirs,
    firstName: 'Theirs',
    admissionNumber: `SEC-T-${suffix}`,
    rollNumber: 2,
  })
  // A date of birth and a guardian telephone number exist for both children,
  // so a response that leaked either would be caught below.
  await pool.query(
    `UPDATE students SET date_of_birth = '2014-12-14' WHERE school_id = $1 AND id = ANY($2::uuid[])`,
    [schoolA, [myStudentId, theirStudentId]],
  )

  // The bell schedule both classes ring to.
  await pool.query('DELETE FROM bell_schedules WHERE school_id = $1 AND academic_year_id = $2', [schoolA, yearA])
  await pool.query(
    `INSERT INTO bell_schedules(id,school_id,academic_year_id,name,grade_ids,working_days,periods)
     VALUES ($1,$2,$3,$4,'{}'::uuid[],ARRAY[1,2,3,4,5,6]::smallint[],$5::jsonb)`,
    [
      bellScheduleId,
      schoolA,
      yearA,
      `Security bell ${suffix}`,
      JSON.stringify([
        { index: 1, name: 'Period 1', startTime: '08:15', endTime: '09:00', type: 'period' },
        { index: 2, name: 'Period 2', startTime: '09:00', endTime: '09:45', type: 'period' },
      ]),
    ],
  )
  await pool.query(
    `INSERT INTO bell_schedule_grades(school_id,bell_schedule_id,grade_id) VALUES ($1,$2,$3)`,
    [schoolA, bellScheduleId, gradeA],
  )

  // Monday: each teacher has one period of their own, and a colleague teaches
  // the other period of the same class.
  await pool.query(
    `INSERT INTO timetable_entries(id,school_id,academic_year_id,section_id,day_of_week,period_index,subject_id,staff_id)
     VALUES ($1,$2,$3,$4,1,1,$5,$6), ($7,$2,$3,$4,1,2,$5,$8), ($9,$2,$3,$10,1,1,$5,$8)`,
    [
      randomUUID(), schoolA, yearA, sectionMine, subjectId, teacherMine.staffId,
      randomUUID(), teacherTheirs.staffId, randomUUID(), sectionTheirs,
    ],
  )
  // A cover duty handed to the teacher in a class they do not teach: the
  // absent teacher owns the period, so it stays out of their day.
  await pool.query(
    `INSERT INTO substitutions(id,school_id,date,section_id,period_index,subject_id,absent_staff_id,substitute_staff_id)
     VALUES ($1,$2,$3::date,$4,1,$5,$6,$7)`,
    [randomUUID(), schoolA, MONDAY, sectionTheirs, subjectId, teacherTheirs.staffId, teacherMine.staffId],
  )

  mine = await signInMember(server, teacherMine)
  theirs = await signInMember(server, teacherTheirs)

  const parentMember = await createMember(schoolA, ['parent'], 'Security Parent')
  await grantPortalAccess({
    schoolId: schoolA,
    membershipId: parentMember.membershipId,
    studentId: myStudentId,
    approvedBy: ownerA,
  })
  parentOfMine = await signInMember(server, parentMember)

  const lonely = await createMember(schoolA, ['parent'], 'Security Lonely Parent')
  lonelyParent = await signInMember(server, lonely)

  const accountantMember = await createMember(schoolA, ['accountant'], 'Security Accountant')
  accountant = await signInOffice(server, accountantMember)

  // The widest answer of the four, and the one that carries the birthdays.
  const officeMember = await createMember(schoolA, ['principal'], 'Security Principal')
  office = await signInOffice(server, officeMember)

  const suspendableMember = await createMember(schoolA, ['principal'], 'Security Suspended')
  suspended = await signInOffice(server, suspendableMember)
  suspendedMembershipId = suspendableMember.membershipId

  madeUserIds.push(
    teacherMine.userId,
    teacherTheirs.userId,
    parentMember.userId,
    lonely.userId,
    accountantMember.userId,
    officeMember.userId,
    suspendableMember.userId,
  )
})

after(async () => {
  await forgetTwoFactor(madeUserIds)
  const pool = adminPool()
  await pool.query('DELETE FROM substitutions WHERE school_id = $1 AND section_id = ANY($2::uuid[])', [
    schoolA,
    [sectionMine, sectionTheirs],
  ])
  await pool.query('DELETE FROM timetable_entries WHERE school_id = $1 AND section_id = ANY($2::uuid[])', [
    schoolA,
    [sectionMine, sectionTheirs],
  ])
  await pool.query('DELETE FROM bell_schedules WHERE school_id = $1 AND id = $2', [schoolA, bellScheduleId])
  await server.close()
  await closeAdminPool()
})

test('a teacher of one school gets no row of another, whatever date is asked', async () => {
  for (const date of [MONDAY, SUNDAY, '2026-04-01', '2027-03-31']) {
    const refused = await mine.fetch(`/api/schools/${schoolB}/dashboard?date=${date}`)
    assert.equal(refused.status, 403, date)
    assert.equal(await codeOf(refused), 'SCHOOL_ACCESS_UNAVAILABLE')
    // The same date against their own school carries nothing of school B.
    const raw = await rawDashboard(mine, schoolA, date)
    assert.ok(!raw.includes(schoolB), `school B appears in the answer for ${date}`)
    assert.ok(!raw.includes(studentB), `a school B child appears in the answer for ${date}`)
  }
})

test('a teacher sees their own periods, never a colleague’s and never a cover in a class they do not teach', async () => {
  const raw = await rawDashboard(mine, schoolA, MONDAY)
  assert.ok(raw.includes(sectionMine), 'their own class is missing')
  // The documented limit: the absent teacher owns the period a cover covers,
  // so a cover in a class this teacher does not teach is not shown to them.
  assert.ok(!raw.includes(sectionTheirs), 'a class they do not teach appears')
  assert.ok(!raw.includes(teacherTheirs.staffId), 'a colleague is named on their own day')

  const body = JSON.parse(raw) as {
    audience: string
    week: { periodIndex: number; section: { id: string } }[]
    timeline: { periodIndex: number; lesson?: { cover: boolean } }[]
  }
  assert.equal(body.audience, 'teacher')
  assert.deepEqual([...new Set(body.week.map((entry) => entry.section.id))], [sectionMine])
  // The colleague's period in the same class is the colleague's alone.
  assert.deepEqual(body.week.map((entry) => entry.periodIndex), [1])
  assert.ok(body.timeline.every((slot) => slot.lesson?.cover !== true))

  // And the other teacher's answer is the mirror image of it: their own two
  // classes, and no period of the first teacher's own class.
  const other = JSON.parse(await rawDashboard(theirs, schoolA, MONDAY)) as {
    week: { periodIndex: number; section: { id: string } }[]
  }
  assert.deepEqual([...new Set(other.week.map((entry) => entry.section.id))].sort(), [
    sectionMine,
    sectionTheirs,
  ].sort())
  // Each of the two periods belongs to whoever teaches it.
  assert.ok(other.week.some((entry) => entry.section.id === sectionMine && entry.periodIndex === 2))
  assert.ok(!other.week.some((entry) => entry.section.id === sectionMine && entry.periodIndex === 1))
})

test('a parent with no approved child link never reaches the school at all', async () => {
  // A parent's dashboard.read is scoped to their own children, so a parent
  // with none holds it nowhere in the school: the door does not open, and no
  // empty shell of a school dashboard is built for them either.
  const response = await lonelyParent.fetch(`/api/schools/${schoolA}/dashboard?date=${MONDAY}`)
  assert.equal(response.status, 403)
  const raw = await response.text()
  assert.equal(JSON.parse(raw).error.code, 'ACCESS_DENIED')
  assert.ok(!raw.includes(myStudentId))
  assert.ok(!raw.includes(theirStudentId))
  assert.ok(!raw.includes(sectionMine))
})

test('a parent never sees another family’s child', async () => {
  const raw = await rawDashboard(parentOfMine, schoolA, MONDAY)
  const body = JSON.parse(raw) as { children: { student: { id: string } }[] }
  assert.deepEqual(body.children.map((child) => child.student.id), [myStudentId])
  assert.ok(!raw.includes(theirStudentId), 'another family’s child appears')
  assert.ok(!raw.includes(studentB), 'a child of another school appears')
  assert.ok(!raw.includes(sectionTheirs), 'another family’s class appears')
})

test('the accountant sees money-shaped figures alone: no birthdays, no attention, no activity', async () => {
  const raw = await rawDashboard(accountant, schoolA, MONDAY)
  const body = JSON.parse(raw) as Record<string, unknown>
  assert.equal(body.audience, 'accountant')
  for (const key of ['birthdays', 'attention', 'recentActivity', 'securityEvents', 'setup', 'holidays']) {
    assert.ok(!(key in body), `the accountant dashboard carries ${key}`)
  }
  assert.equal(body.feesNote, 'Fee cards arrive with the fees module')
})

test('a member whose role no longer allows holidays.read gets an empty calendar list', async () => {
  const before = JSON.parse(await rawDashboard(mine, schoolA, MONDAY)) as { holidays: unknown[] }
  assert.ok(Array.isArray(before.holidays))
  const holidayId = randomUUID()
  await adminPool().query(
    `INSERT INTO holidays(id,school_id,academic_year_id,name,start_date,end_date,type)
     VALUES ($1,$2,$3,'Security holiday','2026-12-16','2026-12-16','school')`,
    [holidayId, schoolA, yearA],
  )
  const withHoliday = JSON.parse(await rawDashboard(mine, schoolA, MONDAY)) as {
    holidays: { id: string }[]
  }
  assert.ok(withHoliday.holidays.some((entry) => entry.id === holidayId))

  // The school takes the calendar grant off the teacher role itself.
  const teacherRoleId = await roleIdFor(schoolA, 'teacher')
  await adminPool().query(
    `DELETE FROM role_permissions WHERE school_id = $1 AND role_id = $2 AND permission = 'holidays.read'`,
    [schoolA, teacherRoleId],
  )
  await bumpAccessVersion(teacherMine.membershipId)
  const after = JSON.parse(await rawDashboard(mine, schoolA, MONDAY)) as { holidays: unknown[] }
  assert.deepEqual(after.holidays, [], 'the calendar was read without the permission')

  await adminPool().query(
    `INSERT INTO role_permissions(school_id, role_id, permission, scope)
     VALUES ($1, $2, 'holidays.read', 'school') ON CONFLICT DO NOTHING`,
    [schoolA, teacherRoleId],
  )
  await bumpAccessVersion(teacherMine.membershipId)
  await adminPool().query('DELETE FROM holidays WHERE id = $1', [holidayId])
})

test('no audience’s dashboard carries a number, an address, a birth date or a file key', async () => {
  const answers: [string, string][] = [
    ['teacher', await rawDashboard(mine, schoolA, MONDAY)],
    ['parent', await rawDashboard(parentOfMine, schoolA, MONDAY)],
    ['accountant', await rawDashboard(accountant, schoolA, MONDAY)],
    ['office', await rawDashboard(office, schoolA, MONDAY)],
  ]
  for (const [where, raw] of answers) {
    assertNoForbiddenKeys(raw, where)
    // Nothing of the private store, under any spelling.
    assert.ok(!/fixtures\//.test(raw), `the ${where} dashboard names a stored file`)
    assert.ok(!/"[^"]*\/[^"]*\.(pdf|png|jpg|xlsx)"/.test(raw), `the ${where} dashboard names a file path`)
  }
})

test('a suspended member reaches no dashboard at all', async () => {
  // While the membership is live the door opens.
  const allowed = await suspended.fetch(`/api/schools/${schoolA}/dashboard?date=${MONDAY}`)
  assert.equal(allowed.status, 200)

  await adminPool().query(
    `UPDATE school_memberships SET status = 'suspended' WHERE id = $1`,
    [suspendedMembershipId],
  )
  await bumpAccessVersion(suspendedMembershipId)

  const refused = await suspended.fetch(`/api/schools/${schoolA}/dashboard?date=${MONDAY}`)
  assert.ok(refused.status === 403, `a suspended member was answered ${refused.status}`)
  const raw = await refused.text()
  assert.ok(!raw.includes(myStudentId), 'a child appears in the refusal')
  assert.ok(!raw.includes(sectionMine), 'a class appears in the refusal')
})
