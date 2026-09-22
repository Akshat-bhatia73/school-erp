/**
 * Matrix rows: attendance.
 *
 * The adversarial half of Task 20. The module's own suite proves the figures
 * are right; this file asks who may see a register and who may mark one. A
 * teacher reaches their own classes and no others, a relationship that ended
 * takes the class away with it, a parent reads their own child in every year
 * the child was here, the accountant is kept out of the children's registers
 * altogether, and an id from the school next door reads exactly like an id
 * that was never real.
 *
 * Every refusal is measured twice: the answer it gave, and the fingerprint of
 * both registers, which a refusal may never change.
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
  bumpAccessVersion,
  codeOf,
  createMember,
  ensureSubject,
  grantPortalAccess,
  postBody,
  putBody,
  signInMember,
  signInOffice,
  type Client,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerA = fixtureIds.ownerA as string
const ownerB = fixtureIds.ownerB as string
const studentB = fixtureIds.studentB as string

const suffix = randomUUID().slice(0, 8)

// School A's own rows: the year the children sit now and the year they were
// promoted out of, so a closed year can be read back.
const year = randomUUID()
const closedYear = randomUUID()
const grade = randomUUID()
const sectionOne = randomUUID()
const sectionTwo = randomUUID()
const closedSection = randomUUID()
const child = randomUUID()
const stranger = randomUUID()
const YEAR_START = '2026-06-01'
const CLOSED_MONTH = '2025-07'
const CLOSED_DAY = '2025-07-07'

// School B's rows. None of them is ever reachable through school A's paths.
const yearB = randomUUID()
const gradeB = randomUUID()
const sectionB = randomUUID()
let staffB = ''
let entryB = ''
let staffEntryB = ''

let server: TestServer
let classTeacher: Client
let subjectTeacher: Client
let endedTeacher: Client
let accountant: Client
let parent: Client
let office: Client
let classTeacherMembershipId = ''
let accountantMembershipId = ''
let parentMembershipId = ''
let endedMembershipId = ''
let classTeacherStaffId = ''
let subjectStaffId = ''
let endedStaffId = ''
let endedAssignmentId = ''

let today = ''
let month = ''
/** The one mark this file made through the API, for the id it minted. */
let entryId = ''

interface DayResponse {
  date: string
  rows: { student: { id: string }; mark?: string; entry?: { id: string } }[]
  window: { record: boolean; correct: boolean }
  marked: boolean
}
interface SectionsResponse {
  date: string
  items: { section: { id: string } }[]
}
interface StaffDay {
  rows: { staff: { id: string }; self: boolean }[]
}

/** Every attendance route about children, with the smallest body it accepts. */
interface Route {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  body?: unknown
}

function pupilRoutes(): Route[] {
  const marks = [{ studentId: child, mark: 'present' }]
  return [
    { method: 'GET', path: `/attendance/sections?date=${today}` },
    { method: 'GET', path: `/attendance/sections/${sectionOne}/days/${today}` },
    { method: 'PUT', path: `/attendance/sections/${sectionOne}/days/${today}`, body: { marks } },
    {
      method: 'POST',
      path: `/attendance/sections/${sectionOne}/days/${today}/corrections`,
      body: { marks, reason: 'security suite' },
    },
    { method: 'GET', path: `/attendance/students/${child}/months/${month}` },
    { method: 'GET', path: `/attendance/sections/${sectionOne}/months/${month}` },
    {
      method: 'POST',
      path: `/attendance/sections/${sectionOne}/months/${month}/export`,
      body: { format: 'xlsx' },
    },
    { method: 'POST', path: `/attendance/students/${child}/months/${month}/export`, body: {} },
  ]
}

/** The writes a parent must never reach, on their own child's own class. */
function pupilWrites(): Route[] {
  return pupilRoutes().filter((route) => route.method !== 'GET')
}

function call(client: Client, route: Route, schoolId = schoolA): Promise<Response> {
  const path = `/api/schools/${schoolId}${route.path}`
  if (route.method === 'GET') return client.fetch(path)
  const init = route.method === 'PUT' ? putBody(route.body ?? {}) : postBody(route.body ?? {})
  return client.fetch(path, init)
}

/** Both registers of a school, as one fingerprint a refusal must not change. */
async function fingerprint(schoolId: string): Promise<string> {
  const found = await adminPool().query<{ fingerprint: string }>(
    `SELECT
       (SELECT count(*)::text FROM attendance_entries WHERE school_id = $1) || '/' ||
       (SELECT COALESCE(sum(revision), 0)::text FROM attendance_entries WHERE school_id = $1) || '/' ||
       (SELECT count(*)::text FROM staff_attendance_entries WHERE school_id = $1) || '/' ||
       (SELECT COALESCE(sum(revision), 0)::text FROM staff_attendance_entries WHERE school_id = $1)
       AS fingerprint`,
    [schoolId],
  )
  return found.rows[0]?.fingerprint ?? ''
}

async function deniedRows(membershipId: string): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND actor_membership_id = $2 AND result = 'denied'
        AND (action LIKE 'attendance.%' OR action LIKE 'staff_attendance.%')`,
    [schoolA, membershipId],
  )
  return Number(found.rows[0]?.count)
}

/** One staff record, joined at the start of the year so it is on the register. */
async function insertStaff(schoolId: string, label: string, joinedOn: string): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,$3,$4,'teaching','Teacher','active',$5)`,
    [id, schoolId, `SEC-ATT-${suffix}-${label}`, `Security ${label}`, joinedOn],
  )
  return id
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,'2027-03-31','upcoming'),
            ($5,$2,$6,'2025-04-01','2026-03-31','closed')`,
    [year, schoolA, `SEC-ATT-${suffix}`, YEAR_START, closedYear, `SEC-ATT-OLD-${suffix}`],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,710)`,
    [grade, schoolA, `Sec attendance ${suffix}`, `SA${suffix.slice(0, 3)}`],
  )
  classTeacherStaffId = await insertStaff(schoolA, 'class', YEAR_START)
  subjectStaffId = await insertStaff(schoolA, 'subject', YEAR_START)
  endedStaffId = await insertStaff(schoolA, 'ended', YEAR_START)
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6),($7,$2,$3,$4,$8,NULL),($9,$2,$10,$4,$11,NULL)`,
    [
      sectionOne, schoolA, year, grade, `SA-${suffix.slice(0, 4)}`, classTeacherStaffId,
      sectionTwo, `SB-${suffix.slice(0, 4)}`,
      closedSection, closedYear, `SO-${suffix.slice(0, 4)}`,
    ],
  )
  // Both children sat the closed year and were promoted into this one.
  for (const [index, [pupil, name]] of [
    [child, 'Sec Child'],
    [stranger, 'Sec Stranger'],
  ].entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status)
       VALUES ($1,$2,$3,$4,'active')`,
      [pupil, schoolA, `SA/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on,left_on)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'2025-04-01','2026-03-31'),
              (gen_random_uuid(),$1,$2,$6,$7,$5,$8,NULL)`,
      [schoolA, pupil, closedYear, closedSection, index + 1, year, sectionOne, YEAR_START],
    )
    // A mark in the year they have left, written straight to the table: no
    // route marks a closed year, and a parent must still be able to read it.
    await pool.query(
      `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,
                                      revision,kind,recorded_by_membership_id)
       VALUES ($1,$2,$3,$4,$5::date,'present',1,'marking',$6)`,
      [schoolA, pupil, closedSection, closedYear, CLOSED_DAY, ownerA],
    )
  }

  // School B: a class, a pupil's mark and a staff member's mark of its own.
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,'2027-03-31','current')`,
    [yearB, schoolB, `SEC-ATT-B-${suffix}`, YEAR_START],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,710)`,
    [gradeB, schoolB, `Sec B ${suffix}`, `SB${suffix.slice(0, 3)}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [sectionB, schoolB, yearB, gradeB, `BS-${suffix.slice(0, 4)}`],
  )
  await pool.query(
    `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,1,$5)`,
    [schoolB, studentB, yearB, sectionB, YEAR_START],
  )
  staffB = await insertStaff(schoolB, 'b', YEAR_START)
  const markB = await pool.query<{ id: string }>(
    `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,
                                    revision,kind,recorded_by_membership_id)
     VALUES ($1,$2,$3,$4,$5::date,'present',1,'marking',$6) RETURNING id`,
    [schoolB, studentB, sectionB, yearB, CLOSED_DAY, ownerB],
  )
  entryB = markB.rows[0]?.id as string
  const staffMarkB = await pool.query<{ id: string }>(
    `INSERT INTO staff_attendance_entries(school_id,staff_id,date,mark,revision,kind,recorded_by_membership_id)
     VALUES ($1,$2,$3::date,'present',1,'marking',$4) RETURNING id`,
    [schoolB, staffB, CLOSED_DAY, ownerB],
  )
  staffEntryB = staffMarkB.rows[0]?.id as string

  const subjectId = await ensureSubject(schoolA, `SEC-ATT-${suffix.slice(0, 4)}`)

  const classMember = await createMember(schoolA, ['teacher'], 'Attendance Class Teacher')
  classTeacherMembershipId = classMember.membershipId
  await pool.query(
    'INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)',
    [schoolA, classMember.membershipId, classTeacherStaffId],
  )
  classTeacher = await signInMember(server, classMember)

  // A teacher of the class next door: the same role, a different relationship.
  const subjectMember = await createMember(schoolA, ['teacher'], 'Attendance Subject Teacher')
  await pool.query(
    'INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)',
    [schoolA, subjectMember.membershipId, subjectStaffId],
  )
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [schoolA, subjectStaffId, year, sectionTwo, subjectId, YEAR_START],
  )
  subjectTeacher = await signInMember(server, subjectMember)

  // A teacher whose assignment to the first class is still live; a test ends
  // it and asks for the class back.
  const endedMember = await createMember(schoolA, ['teacher'], 'Attendance Ended Teacher')
  endedMembershipId = endedMember.membershipId
  await pool.query(
    'INSERT INTO membership_staff_links(school_id,membership_id,staff_id) VALUES ($1,$2,$3)',
    [schoolA, endedMember.membershipId, endedStaffId],
  )
  const assignment = await pool.query<{ id: string }>(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [schoolA, endedStaffId, year, sectionOne, subjectId, YEAR_START],
  )
  endedAssignmentId = assignment.rows[0]?.id as string
  endedTeacher = await signInMember(server, endedMember)

  const accountantMember = await createMember(schoolA, ['accountant'], 'Attendance Accountant')
  accountantMembershipId = accountantMember.membershipId
  accountant = await signInOffice(server, accountantMember)

  const officeMember = await createMember(schoolA, ['principal'], 'Attendance Office')
  office = await signInOffice(server, officeMember)

  const parentMember = await createMember(schoolA, ['parent'], 'Attendance Parent')
  parentMembershipId = parentMember.membershipId
  await grantPortalAccess({
    schoolId: schoolA,
    membershipId: parentMember.membershipId,
    studentId: child,
    approvedBy: ownerA,
  })
  parent = await signInMember(server, parentMember)

  const listed = await body<SectionsResponse>(
    await classTeacher.fetch(`/api/schools/${schoolA}/attendance/sections`),
  )
  today = listed.date
  month = today.slice(0, 7)

  // The one register this file marks, so there is an entry id it minted.
  const marked = await classTeacher.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionOne}/days/${today}`,
    putBody({
      marks: [
        { studentId: child, mark: 'present' },
        { studentId: stranger, mark: 'absent' },
      ],
    }),
  )
  assert.equal(marked.status, 200, await marked.clone().text())
  const day = await body<DayResponse>(marked)
  entryId = day.rows.find((row) => row.student.id === child)?.entry?.id ?? ''
  assert.ok(entryId, 'the save left a mark to point at')
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

test('[attendance] school B’s ids read exactly like ids that were never real', async () => {
  const before = await fingerprint(schoolA)
  const foreignSection = [sectionB, entryB]
  const invented = randomUUID()

  for (const id of [...foreignSection, invented]) {
    const reads = [
      `/attendance/sections/${id}/days/${today}`,
      `/attendance/sections/${id}/months/${month}`,
      `/attendance/students/${id}/months/${month}`,
      `/staff-attendance/staff/${id}/months/${month}`,
    ]
    for (const path of reads) {
      const response = await office.fetch(`/api/schools/${schoolA}${path}`)
      assert.equal(response.status, 404, `${path} answered ${response.status}`)
      assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND', path)
    }
    const writes: Route[] = [
      {
        method: 'PUT',
        path: `/attendance/sections/${id}/days/${today}`,
        body: { marks: [{ studentId: studentB, mark: 'present' }] },
      },
      {
        method: 'POST',
        path: `/attendance/sections/${id}/days/${today}/corrections`,
        body: { marks: [{ studentId: studentB, mark: 'present' }], reason: 'security suite' },
      },
      { method: 'POST', path: `/attendance/students/${id}/months/${month}/export`, body: {} },
    ]
    for (const route of writes) {
      const response = await call(office, route)
      assert.equal(response.status, 404, `${route.method} ${route.path} answered ${response.status}`)
    }
  }

  // Another school's pupil named in a body of this school's own class is not
  // a stranger to the school: they are simply not on the roll.
  const notOnRoll = await office.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionOne}/days/${today}`,
    putBody({ marks: [{ studentId: studentB, mark: 'present' }] }),
  )
  assert.equal(notOnRoll.status, 400, await notOnRoll.clone().text())
  assert.equal(
    (await body<{ error: { reason?: string } }>(notOnRoll)).error.reason,
    'attendance_pupil_not_on_roster',
  )

  // A staff mark of school B is not a staff member of school A either.
  const foreignStaff = await office.fetch(
    `/api/schools/${schoolA}/staff-attendance/days/${today}`,
    putBody({ marks: [{ staffId: staffB, mark: 'present' }] }),
  )
  assert.equal(foreignStaff.status, 400, await foreignStaff.clone().text())
  assert.equal(
    (await body<{ error: { reason?: string } }>(foreignStaff)).error.reason,
    'staff_attendance_not_on_register',
  )

  assert.equal(await fingerprint(schoolA), before, 'nothing of school A moved')
  assert.equal(
    await fingerprint(schoolB),
    `1/1/1/1`,
    'school B still holds exactly the two marks it started with',
  )
  assert.ok(staffEntryB.length > 0)
})

test('[attendance] a teacher of the class next door reaches neither its roll nor its register', async () => {
  const before = await fingerprint(schoolA)

  // The day list omits the class they do not teach, so nothing on the screen
  // ever offers it.
  const listed = await body<SectionsResponse>(
    await subjectTeacher.fetch(`/api/schools/${schoolA}/attendance/sections?date=${today}`),
  )
  assert.deepEqual(
    listed.items.map((item) => item.section.id),
    [sectionTwo],
  )

  for (const path of [
    `/attendance/sections/${sectionOne}/days/${today}`,
    `/attendance/sections/${sectionOne}/months/${month}`,
    `/attendance/students/${child}/months/${month}`,
  ]) {
    const response = await subjectTeacher.fetch(`/api/schools/${schoolA}${path}`)
    assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND', path)
  }
  const marking = await subjectTeacher.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionOne}/days/${today}`,
    putBody({ marks: [{ studentId: child, mark: 'absent' }] }),
  )
  assert.equal(marking.status, 404, await marking.clone().text())
  assert.equal(await fingerprint(schoolA), before)
})

test('[attendance] the class teacher marks their own class and no other', async () => {
  const listed = await body<SectionsResponse>(
    await classTeacher.fetch(`/api/schools/${schoolA}/attendance/sections?date=${today}`),
  )
  assert.deepEqual(
    listed.items.map((item) => item.section.id),
    [sectionOne],
  )

  // The list and the detail agree: a class on the list opens, and a class off
  // it is not there at all.
  const listedIds = new Set(listed.items.map((item) => item.section.id))
  for (const id of [sectionOne, sectionTwo]) {
    const response = await classTeacher.fetch(
      `/api/schools/${schoolA}/attendance/sections/${id}/days/${today}`,
    )
    assert.equal(response.status === 200, listedIds.has(id), `${id} disagrees with the list`)
  }

  const before = await fingerprint(schoolA)
  const other = await classTeacher.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionTwo}/days/${today}`,
    putBody({ marks: [{ studentId: child, mark: 'present' }] }),
  )
  assert.equal(other.status, 404, await other.clone().text())
  assert.equal(await fingerprint(schoolA), before)
})

test('[attendance] an assignment that has ended takes the class with it', async () => {
  // While the assignment is live, the class is theirs to read and to mark.
  const open = await endedTeacher.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionOne}/days/${today}`,
  )
  assert.equal(open.status, 200, await open.clone().text())

  await adminPool().query(
    `UPDATE teaching_assignments SET effective_to = $2::date WHERE id = $1`,
    [endedAssignmentId, '2026-06-30'],
  )
  await bumpAccessVersion(endedMembershipId)

  // That was their only class, so the key itself is gone with it: the route
  // gate refuses before any record is named. A teacher who still teaches
  // somewhere is told instead that this class is not there, which is what the
  // test above the previous one proves.
  const before = await fingerprint(schoolA)
  const closed = await endedTeacher.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionOne}/days/${today}`,
  )
  assert.equal(closed.status, 403, await closed.clone().text())
  assert.equal(await codeOf(closed), 'ACCESS_DENIED')
  const marking = await endedTeacher.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionOne}/days/${today}`,
    putBody({ marks: [{ studentId: child, mark: 'absent' }] }),
  )
  assert.equal(marking.status, 403, await marking.clone().text())

  const listed = await endedTeacher.fetch(`/api/schools/${schoolA}/attendance/sections?date=${today}`)
  assert.equal(listed.status, 403, 'a teacher with no class left is offered no list either')
  assert.equal(await fingerprint(schoolA), before)
})

test('[attendance] a parent reads their own child in every year, and never another family', async () => {
  for (const readMonth of [month, CLOSED_MONTH]) {
    const mine = await parent.fetch(
      `/api/schools/${schoolA}/attendance/students/${child}/months/${readMonth}`,
    )
    assert.equal(mine.status, 200, await mine.clone().text())
    const theirs = await parent.fetch(
      `/api/schools/${schoolA}/attendance/students/${stranger}/months/${readMonth}`,
    )
    assert.equal(theirs.status, 404, `${readMonth}: ${await theirs.clone().text()}`)
    assert.equal(await codeOf(theirs), 'RESOURCE_NOT_FOUND', `${readMonth} leaked another family`)
  }

  // The year the child has left still holds the mark that was written then.
  const old = await body<{ days: { date: string; mark?: string }[]; summary: { present: number } }>(
    await parent.fetch(`/api/schools/${schoolA}/attendance/students/${child}/months/${CLOSED_MONTH}`),
  )
  assert.equal(old.days.find((day) => day.date === CLOSED_DAY)?.mark, 'present')
  assert.equal(old.summary.present, 1)

  // The class their own child sits in opens, because the roster answers
  // through that child — but it holds one row, the child's own. Nobody
  // else's name, and nobody else's mark, is in it.
  const day = await parent.fetch(`/api/schools/${schoolA}/attendance/sections/${sectionOne}/days/${today}`)
  assert.equal(day.status, 200, await day.clone().text())
  const register = await body<DayResponse>(day)
  assert.deepEqual(register.rows.map((row) => row.student.id), [child])
  assert.equal(register.window.record, false, 'and there is nothing on it to mark')
  assert.equal(register.window.correct, false)

  const grid = await parent.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionOne}/months/${month}`,
  )
  assert.equal(grid.status, 200, await grid.clone().text())
  assert.deepEqual(
    (await body<{ rows: { student: { id: string } }[] }>(grid)).rows.map((row) => row.student.id),
    [child],
  )

  // A class no child of theirs has ever sat in is not there at all.
  const other = await parent.fetch(
    `/api/schools/${schoolA}/attendance/sections/${sectionTwo}/days/${today}`,
  )
  assert.equal(other.status, 404, await other.clone().text())
})

test('[attendance] a parent may not mark anything, and every refusal is on the record', async () => {
  const before = await fingerprint(schoolA)
  const denials = await deniedRows(parentMembershipId)
  const writes = pupilWrites().filter(
    // Printing their own child's month is a parent's right, and the module
    // suite proves it; everything else that writes is refused at the gate.
    (route) => !route.path.startsWith(`/attendance/students/${child}/months`),
  )
  for (const route of writes) {
    const response = await call(parent, route)
    assert.equal(response.status, 403, `${route.method} ${route.path} answered ${response.status}`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', `${route.method} ${route.path}`)
  }
  assert.equal(await fingerprint(schoolA), before)
  assert.equal(await deniedRows(parentMembershipId), denials + writes.length)
})

test('[attendance] the accountant is kept out of the children’s registers entirely', async () => {
  const before = await fingerprint(schoolA)
  const denials = await deniedRows(accountantMembershipId)
  const routes = pupilRoutes()
  for (const route of routes) {
    const response = await call(accountant, route)
    assert.equal(response.status, 403, `${route.method} ${route.path} answered ${response.status}`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED', `${route.method} ${route.path}`)
  }
  assert.equal(await fingerprint(schoolA), before)
  assert.equal(await deniedRows(accountantMembershipId), denials + routes.length)

  // The staff register is a different question, and the answer is yes.
  const register = await accountant.fetch(`/api/schools/${schoolA}/staff-attendance/days/${today}`)
  assert.equal(register.status, 200, await register.clone().text())
  const rows = (await body<StaffDay>(register)).rows
  assert.ok(rows.some((row) => row.staff.id === classTeacherStaffId), 'the whole register is theirs to read')
})

test('[attendance] a teacher sees only their own row of the staff register', async () => {
  const day = await body<StaffDay>(
    await classTeacher.fetch(`/api/schools/${schoolA}/staff-attendance/days/${today}`),
  )
  assert.deepEqual(
    day.rows.map((row) => row.staff.id),
    [classTeacherStaffId],
    'the self scope is one row, not a directory',
  )
  assert.equal(day.rows[0]?.self, true)

  // Somebody else's month is not there at all.
  const other = await classTeacher.fetch(
    `/api/schools/${schoolA}/staff-attendance/staff/${subjectStaffId}/months/${month}`,
  )
  assert.equal(await codeOf(other), 'RESOURCE_NOT_FOUND')
  const mine = await classTeacher.fetch(
    `/api/schools/${schoolA}/staff-attendance/staff/${classTeacherStaffId}/months/${month}`,
  )
  assert.equal(mine.status, 200, await mine.clone().text())

  const before = await fingerprint(schoolA)
  const denials = await deniedRows(classTeacherMembershipId)
  const writes: Route[] = [
    {
      method: 'PUT',
      path: `/staff-attendance/days/${today}`,
      body: { marks: [{ staffId: subjectStaffId, mark: 'present' }] },
    },
    {
      method: 'POST',
      path: `/staff-attendance/days/${today}/corrections`,
      body: { marks: [{ staffId: subjectStaffId, mark: 'present' }], reason: 'security suite' },
    },
    { method: 'POST', path: `/staff-attendance/months/${month}/export`, body: { format: 'xlsx' } },
  ]
  for (const route of writes) {
    const response = await call(classTeacher, route)
    assert.equal(response.status, 403, `${route.method} ${route.path} answered ${response.status}`)
    assert.equal(await codeOf(response), 'ACCESS_DENIED')
  }
  assert.equal(await fingerprint(schoolA), before)
  assert.equal(await deniedRows(classTeacherMembershipId), denials + writes.length)
})
