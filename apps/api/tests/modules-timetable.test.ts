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
const OWNER_EMAIL = `timetable-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `timetable-teacher-${randomUUID()}@example.test`
const PARENT_EMAIL = `timetable-parent-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const sectionA = fixtureIds.sectionA as string
const staffA = fixtureIds.staffA as string
const studentA2 = fixtureIds.studentA2 as string

// Rows this file inserts itself, so every assertion is exact.
const subjectMath = '30000000-0000-4000-8000-000000000001'
const subjectScience = '30000000-0000-4000-8000-000000000002'
const sectionB2 = '30000000-0000-4000-8000-000000000010'
const sectionC = '30000000-0000-4000-8000-000000000011'
const staffOther = '30000000-0000-4000-8000-000000000020'
const bellSchedule = '30000000-0000-4000-8000-000000000030'
const yearB = '30000000-0000-4000-8000-000000000040'
const gradeB = '30000000-0000-4000-8000-000000000041'
const sectionOtherSchool = '30000000-0000-4000-8000-000000000042'
/** A Monday inside the fixture academic year. */
const MONDAY = '2026-04-06'

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let teacher: Client
let parent: Client

function apiA(path: string): string {
  return `/api/schools/${schoolA}${path}`
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { code?: string } }
  return body.error?.code ?? ''
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  // This file owns the whole timetable of the fixture school, so a rerun
  // starts from the same empty grid rather than yesterday's rows.
  for (const table of ['substitutions', 'timetable_entries', 'teaching_assignments', 'bell_schedules', 'enrollments', 'grade_subjects']) {
    await pool.query(`DELETE FROM ${table} WHERE school_id = $1`, [schoolA])
  }
  await pool.query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES
       ($1,$3,'Mathematics','TTMATH','scholastic'),($2,$3,'Science','TTSCI','scholastic')
     ON CONFLICT (id) DO NOTHING`,
    [subjectMath, subjectScience, schoolA],
  )
  await pool.query(
    `INSERT INTO grade_subjects(school_id,grade_id,academic_year_id,subject_id) VALUES
       ($1,$2,$3,$4),($1,$2,$3,$5) ON CONFLICT DO NOTHING`,
    [schoolA, gradeA, yearA, subjectMath, subjectScience],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$3,$4,$5,'TT-B'),($2,$3,$4,$5,'TT-C')
     ON CONFLICT (id) DO NOTHING`,
    [sectionB2, sectionC, schoolA, yearA, gradeA],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,last_name,staff_type,designation,status)
     VALUES ($1,$2,'TT-OTHER','Other','Teacher','teaching','Teacher','active') ON CONFLICT (id) DO NOTHING`,
    [staffOther, schoolA],
  )
  // The fixture teacher holds maths in section A only; the other teacher holds
  // science in sections B and C, which is what a clash needs.
  await pool.query(
    `INSERT INTO teaching_assignments(school_id,staff_id,academic_year_id,section_id,subject_id,effective_from)
     VALUES ($1,$2,$3,$4,$5,'2026-04-01'),($1,$6,$3,$7,$8,'2026-04-01'),($1,$6,$3,$9,$8,'2026-04-01')`,
    [schoolA, staffA, yearA, sectionA, subjectMath, staffOther, sectionB2, subjectScience, sectionC],
  )
  await pool.query(
    `INSERT INTO timetable_entries(school_id,academic_year_id,section_id,day_of_week,period_index,subject_id,staff_id)
     VALUES ($1,$2,$3,1,1,$4,$5),($1,$2,$6,1,2,$7,$8)
     ON CONFLICT (school_id,academic_year_id,section_id,day_of_week,period_index) DO NOTHING`,
    [schoolA, yearA, sectionA, subjectMath, staffA, sectionB2, subjectScience, staffOther],
  )
  await pool.query(
    `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on)
     VALUES ($1,$2,$3,$4,'2026-04-01')`,
    [schoolA, studentA2, yearA, sectionA],
  )
  await pool.query(
    `INSERT INTO bell_schedules(id,school_id,academic_year_id,name,grade_ids,working_days,periods)
     VALUES ($1,$2,$3,'Main','{}'::uuid[],'{1,2}'::smallint[],$4::jsonb) ON CONFLICT (id) DO NOTHING`,
    [
      bellSchedule,
      schoolA,
      yearA,
      JSON.stringify([
        { index: 1, name: 'Period 1', startTime: '08:00', endTime: '08:40', type: 'period' },
        { index: 2, name: 'Period 2', startTime: '08:40', endTime: '09:20', type: 'period' },
      ]),
    ],
  )
  // A whole class in the other school, for the cross-tenant reads.
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,'TT-B','2026-04-01','2027-03-31','current') ON CONFLICT (id) DO NOTHING`,
    [yearB, schoolB],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,'TT Six','6',6)
     ON CONFLICT (id) DO NOTHING`,
    [gradeB, schoolB],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,'A')
     ON CONFLICT (id) DO NOTHING`,
    [sectionOtherSchool, schoolB, yearB, gradeB],
  )

  server = await startTestServer()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [fixtureIds.ownerAUser, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [fixtureIds.adultUser, TEACHER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [fixtureIds.parentA2User, PARENT_EMAIL])
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
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [fixtureIds.ownerAUser])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [fixtureIds.ownerAUser])
  await server.close()
  await closeAdminPool()
})

test('a timetable read needs a session', async () => {
  const response = await fetch(
    `${server.origin}${apiA(`/timetable/sections/${sectionA}?academicYearId=${yearA}`)}`,
  )
  assert.equal(response.status, 401)
})

test('a school A member may not read through school B in the path', async () => {
  const response = await owner.fetch(
    `/api/schools/${schoolB}/timetable/sections/${sectionOtherSchool}?academicYearId=${yearB}`,
  )
  assert.equal(response.status, 403)
  assert.equal(await errorCode(response), 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('another school’s section is simply not found on a school A path', async () => {
  const response = await owner.fetch(
    apiA(`/timetable/sections/${sectionOtherSchool}?academicYearId=${yearA}`),
  )
  assert.equal(response.status, 404)
  assert.equal(await errorCode(response), 'RESOURCE_NOT_FOUND')
})

test('an owner reads a section grid with only the contract fields', async () => {
  const response = await owner.fetch(apiA(`/timetable/sections/${sectionA}?academicYearId=${yearA}`))
  assert.equal(response.status, 200)
  const body = await json(response)
  assert.deepEqual(Object.keys(body).sort(), ['allowedActions', 'cells'])
  const cells = body.cells as Record<string, unknown>[]
  assert.equal(cells.length, 1)
  assert.deepEqual(Object.keys(cells[0] ?? {}).sort(), [
    'dayOfWeek',
    'periodIndex',
    'section',
    'subject',
    'teacher',
  ])
  assert.deepEqual(Object.keys((cells[0]?.teacher ?? {}) as object).sort(), ['id', 'name'])
  assert.ok((body.allowedActions as string[]).includes('timetable.manage_entries'))
})

test('a teacher sees the section they are assigned to and not another one', async () => {
  const mine = await teacher.fetch(apiA(`/timetable/sections/${sectionA}?academicYearId=${yearA}`))
  assert.equal(mine.status, 200)
  const body = await json(mine)
  assert.equal((body.cells as unknown[]).length, 1)
  assert.ok(!(body.allowedActions as string[]).includes('timetable.manage_entries'))

  const other = await teacher.fetch(apiA(`/timetable/sections/${sectionB2}?academicYearId=${yearA}`))
  assert.equal(other.status, 404)
  assert.equal(await errorCode(other), 'RESOURCE_NOT_FOUND')
})

test('a teacher reads their own week and not a colleague’s', async () => {
  const own = await teacher.fetch(apiA(`/timetable/staff/${staffA}?academicYearId=${yearA}`))
  assert.equal(own.status, 200)
  assert.equal(((await json(own)).cells as unknown[]).length, 1)

  const colleague = await teacher.fetch(apiA(`/timetable/staff/${staffOther}?academicYearId=${yearA}`))
  assert.equal(colleague.status, 404)
})

test('a parent sees their child’s class only', async () => {
  const child = await parent.fetch(apiA(`/timetable/sections/${sectionA}?academicYearId=${yearA}`))
  assert.equal(child.status, 200)
  assert.equal(((await json(child)).cells as unknown[]).length, 1)

  const other = await parent.fetch(apiA(`/timetable/sections/${sectionB2}?academicYearId=${yearA}`))
  assert.equal(other.status, 404)
})

test('a teacher may not reach the management endpoints', async () => {
  const free = await teacher.fetch(
    apiA(`/timetable/free-teachers?academicYearId=${yearA}&dayOfWeek=1&periodIndex=1`),
  )
  assert.equal(free.status, 403)
  assert.equal(await errorCode(free), 'ACCESS_DENIED')

  const conflicts = await teacher.fetch(apiA(`/timetable/conflicts?academicYearId=${yearA}`))
  assert.equal(conflicts.status, 403)
})

test('free teachers excludes the teacher who is already busy in that slot', async () => {
  const response = await owner.fetch(
    apiA(`/timetable/free-teachers?academicYearId=${yearA}&dayOfWeek=1&periodIndex=1&subjectId=${subjectScience}`),
  )
  assert.equal(response.status, 200)
  const rows = (await response.json()) as { teacher: { id: string }; teachesSubject: boolean }[]
  const ids = rows.map((row) => row.teacher.id)
  assert.ok(!ids.includes(staffA))
  assert.ok(ids.includes(staffOther))
  assert.equal(rows.find((row) => row.teacher.id === staffOther)?.teachesSubject, true)
})

test('setting an entry refuses a busy teacher and an unassigned one, and then writes', async () => {
  const busy = await owner.fetch(apiA('/timetable/entries'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      sectionId: sectionC,
      dayOfWeek: 1,
      periodIndex: 2,
      subjectId: subjectScience,
      staffId: staffOther,
    }),
  })
  assert.equal(busy.status, 400)
  assert.equal(await errorCode(busy), 'INVALID_REQUEST')

  const notAssigned = await owner.fetch(apiA('/timetable/entries'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      sectionId: sectionA,
      dayOfWeek: 2,
      periodIndex: 1,
      subjectId: subjectScience,
      staffId: staffA,
    }),
  })
  assert.equal(notAssigned.status, 400)

  const stored = await adminPool().query(
    'SELECT count(*)::int AS total FROM timetable_entries WHERE school_id = $1 AND section_id IN ($2,$3)',
    [schoolA, sectionA, sectionC],
  )
  assert.equal(stored.rows[0]?.total, 1)

  const ok = await owner.fetch(apiA('/timetable/entries'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      sectionId: sectionA,
      dayOfWeek: 2,
      periodIndex: 1,
      subjectId: subjectMath,
      staffId: staffA,
      roomNumber: '12',
    }),
  })
  assert.equal(ok.status, 200)
  const cell = await json(ok)
  assert.equal(cell.roomNumber, '12')
  assert.equal((cell.teacher as { id: string }).id, staffA)

  const cleared = await owner.fetch(
    apiA(`/timetable/entries?academicYearId=${yearA}&sectionId=${sectionA}&dayOfWeek=2&periodIndex=1`),
    { method: 'DELETE' },
  )
  assert.equal(cleared.status, 204)
})

test('an entry body that carries a forbidden field is refused and writes nothing', async () => {
  const response = await owner.fetch(apiA('/timetable/entries'), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schoolId: schoolB,
      academicYearId: yearA,
      sectionId: sectionA,
      dayOfWeek: 3,
      periodIndex: 1,
      subjectId: subjectMath,
      staffId: staffA,
    }),
  })
  assert.equal(response.status, 400)
  assert.equal(await errorCode(response), 'INVALID_REQUEST')
  const stored = await adminPool().query(
    'SELECT count(*)::int AS total FROM timetable_entries WHERE school_id = $1 AND day_of_week = 3',
    [schoolA],
  )
  assert.equal(stored.rows[0]?.total, 0)
})

test('a bell schedule can be created, listed and matched to a grade', async () => {
  const created = await owner.fetch(apiA('/timetable/bell-schedules'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      academicYearId: yearA,
      name: `Wing ${randomUUID().slice(0, 8)}`,
      gradeIds: [gradeA],
      workingDays: [1, 2, 3],
      periods: [{ index: 1, name: 'Period 1', startTime: '08:00', endTime: '08:40', type: 'period' }],
    }),
  })
  assert.equal(created.status, 201)
  const body = await json(created)
  assert.deepEqual(body.gradeIds, [gradeA])

  const forGrade = await owner.fetch(apiA(`/timetable/bell-schedules/for-grade/${gradeA}?academicYearId=${yearA}`))
  assert.equal(forGrade.status, 200)
  assert.equal((await json(forGrade)).id, body.id)

  const list = await owner.fetch(apiA(`/timetable/bell-schedules?academicYearId=${yearA}`))
  assert.equal(list.status, 200)
  assert.ok(((await list.json()) as unknown[]).length >= 2)

  const forbidden = await owner.fetch(apiA('/timetable/bell-schedules'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schoolId: schoolB,
      academicYearId: yearA,
      name: 'Rejected',
      gradeIds: [],
      workingDays: [1],
      periods: [],
    }),
  })
  assert.equal(forbidden.status, 400)
})

test('a bell schedule update refuses a version the table cannot hold', async () => {
  const stale = await owner.fetch(apiA(`/timetable/bell-schedules/${bellSchedule}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: 2,
      academicYearId: yearA,
      name: 'Never written',
      gradeIds: [],
      workingDays: [1],
      periods: [],
    }),
  })
  assert.equal(stale.status, 400)
  assert.equal(await errorCode(stale), 'INVALID_REQUEST')
  const kept = await adminPool().query('SELECT name FROM bell_schedules WHERE id = $1', [bellSchedule])
  assert.notEqual(kept.rows[0]?.name, 'Never written')
})

test('a bell schedule update accepts the only version it reports', async () => {
  const updated = await owner.fetch(apiA(`/timetable/bell-schedules/${bellSchedule}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: 1,
      academicYearId: yearA,
      name: 'Main renamed',
      gradeIds: [],
      workingDays: [1, 2],
      periods: [{ index: 1, name: 'Period 1', startTime: '08:00', endTime: '08:40', type: 'period' }],
    }),
  })
  assert.equal(updated.status, 200)
  assert.equal((await json(updated)).name, 'Main renamed')

  const forbidden = await owner.fetch(apiA(`/timetable/bell-schedules/${bellSchedule}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      expectedVersion: 1,
      schoolId: schoolB,
      academicYearId: yearA,
      name: 'Rejected',
      gradeIds: [],
      workingDays: [1],
      periods: [],
    }),
  })
  assert.equal(forbidden.status, 400)
  const stored = await adminPool().query('SELECT name FROM bell_schedules WHERE id = $1', [bellSchedule])
  assert.equal(stored.rows[0]?.name, 'Main renamed')
})

test('generation fills the empty slots of a class and keeps what is there', async () => {
  const response = await owner.fetch(apiA(`/timetable/sections/${sectionA}/generate`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ academicYearId: yearA, reason: 'Start of term planning' }),
  })
  assert.equal(response.status, 200)
  const result = (await response.json()) as { placed: number; unplaced: number }
  assert.ok(result.placed > 0)
  const kept = await adminPool().query(
    `SELECT staff_id::text AS staff FROM timetable_entries
      WHERE school_id = $1 AND section_id = $2 AND day_of_week = 1 AND period_index = 1`,
    [schoolA, sectionA],
  )
  assert.equal(kept.rows[0]?.staff, staffA)
})

test('conflicts and teacher loads are school-wide and owner only', async () => {
  const conflicts = await owner.fetch(apiA(`/timetable/conflicts?academicYearId=${yearA}`))
  assert.equal(conflicts.status, 200)
  const loads = await owner.fetch(apiA(`/timetable/teacher-loads?academicYearId=${yearA}`))
  assert.equal(loads.status, 200)
  const rows = (await loads.json()) as { teacher: { id: string }; periodsPerWeek: number }[]
  assert.ok((rows.find((row) => row.teacher.id === staffA)?.periodsPerWeek ?? 0) >= 1)
})

test('a substitution is visible to the class it covers and hidden from other teachers', async () => {
  const created = await owner.fetch(apiA('/timetable/substitutions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: MONDAY,
      sectionId: sectionA,
      periodIndex: 1,
      subjectId: subjectMath,
      absentStaffId: staffA,
      substituteStaffId: staffOther,
      reason: 'On leave',
    }),
  })
  assert.equal(created.status, 201)
  const substitution = await json(created)
  assert.deepEqual(Object.keys(substitution).sort(), [
    'absentTeacher',
    'date',
    'id',
    'notified',
    'periodIndex',
    'section',
    'subject',
    'substituteTeacher',
  ])
  assert.equal(substitution.date, MONDAY)

  const forTeacher = await teacher.fetch(apiA(`/timetable/substitutions?date=${MONDAY}`))
  assert.equal(forTeacher.status, 200)
  const teacherBody = await json(forTeacher)
  assert.equal((teacherBody.substitutions as unknown[]).length, 1)
  assert.deepEqual(teacherBody.allowedActions, [])

  const clash = await owner.fetch(apiA('/timetable/substitutions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: MONDAY,
      sectionId: sectionC,
      periodIndex: 2,
      subjectId: subjectScience,
      absentStaffId: staffA,
      substituteStaffId: staffOther,
    }),
  })
  // The stand-in already teaches section B in that period on a Monday.
  assert.equal(clash.status, 400)

  const notified = await owner.fetch(apiA('/timetable/substitutions/notify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date: MONDAY }),
  })
  assert.equal(notified.status, 200)
  assert.equal((await json(notified)).queued, 1)

  const absent = await owner.fetch(apiA(`/timetable/substitutions/absent-periods?staffId=${staffA}&date=${MONDAY}`))
  assert.equal(absent.status, 200)
  assert.ok(((await absent.json()) as unknown[]).length >= 1)

  const removed = await owner.fetch(apiA(`/timetable/substitutions/${substitution.id as string}`), {
    method: 'DELETE',
  })
  assert.equal(removed.status, 204)
})

test('a substitution body may not carry a school or a role field', async () => {
  const response = await owner.fetch(apiA('/timetable/substitutions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schoolId: schoolB,
      date: MONDAY,
      sectionId: sectionA,
      periodIndex: 4,
      subjectId: subjectMath,
      absentStaffId: staffA,
    }),
  })
  assert.equal(response.status, 400)
  const stored = await adminPool().query(
    'SELECT count(*)::int AS total FROM substitutions WHERE school_id = $1 AND period_index = 4',
    [schoolA],
  )
  assert.equal(stored.rows[0]?.total, 0)
})

test('a substitution for a class the teacher does not take is hidden from them', async () => {
  // The absent teacher is this teacher's own staff record, so a predicate that
  // ORs in "my own row" outside the read plan would leak section C to them.
  const created = await owner.fetch(apiA('/timetable/substitutions'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      date: MONDAY,
      sectionId: sectionC,
      periodIndex: 1,
      subjectId: subjectScience,
      absentStaffId: staffA,
    }),
  })
  assert.equal(created.status, 201)
  const id = (await json(created)).id as string

  const forTeacher = await teacher.fetch(apiA(`/timetable/substitutions?date=${MONDAY}`))
  assert.equal(forTeacher.status, 200)
  const teacherRows = (await json(forTeacher)).substitutions as { id: string }[]
  assert.ok(!teacherRows.some((row) => row.id === id))

  // The parent of a child in section A must not see section C either.
  const forParent = await parent.fetch(apiA(`/timetable/substitutions?date=${MONDAY}`))
  assert.equal(forParent.status, 200)
  const parentRows = (await json(forParent)).substitutions as { id: string }[]
  assert.ok(!parentRows.some((row) => row.id === id))

  // A teacher may not remove a cover arrangement at all.
  const refused = await teacher.fetch(apiA(`/timetable/substitutions/${id}`), { method: 'DELETE' })
  assert.equal(refused.status, 403)
  assert.equal(await errorCode(refused), 'ACCESS_DENIED')
  const still = await adminPool().query('SELECT count(*)::int AS total FROM substitutions WHERE id = $1', [id])
  assert.equal(still.rows[0]?.total, 1)

  // Notifying twice marks the day once and leaves one audit row, not two.
  const first = await owner.fetch(apiA('/timetable/substitutions/notify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date: MONDAY }),
  })
  assert.equal((await json(first)).queued, 1)
  const before = await adminPool().query(
    "SELECT count(*)::int AS total FROM audit_events WHERE school_id = $1 AND action = 'timetable.notify_substitutions'",
    [schoolA],
  )
  const second = await owner.fetch(apiA('/timetable/substitutions/notify'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ date: MONDAY }),
  })
  assert.equal((await json(second)).queued, 0)
  const after = await adminPool().query(
    "SELECT count(*)::int AS total FROM audit_events WHERE school_id = $1 AND action = 'timetable.notify_substitutions'",
    [schoolA],
  )
  assert.equal(after.rows[0]?.total, before.rows[0]?.total)

  await owner.fetch(apiA(`/timetable/substitutions/${id}`), { method: 'DELETE' })
})

test('a teacher may not clear a timetable slot', async () => {
  const response = await teacher.fetch(
    apiA(`/timetable/entries?academicYearId=${yearA}&sectionId=${sectionA}&dayOfWeek=1&periodIndex=1`),
    { method: 'DELETE' },
  )
  assert.equal(response.status, 403)
  assert.equal(await errorCode(response), 'ACCESS_DENIED')
  const kept = await adminPool().query(
    'SELECT count(*)::int AS total FROM timetable_entries WHERE school_id = $1 AND section_id = $2 AND day_of_week = 1 AND period_index = 1',
    [schoolA, sectionA],
  )
  assert.equal(kept.rows[0]?.total, 1)
})
