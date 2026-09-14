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
const OWNER_EMAIL = `staff-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `staff-teacher-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const teacherUserId = fixtureIds.adultUser as string
const staffA = fixtureIds.staffA as string
const yearA = fixtureIds.yearA as string
const sectionA = fixtureIds.sectionA as string

// Rows this file inserts itself, so every assertion is about known data.
const colleagueId = randomUUID()
const staffBId = randomUUID()
const subjectId = randomUUID()
const sectionBId = randomUUID()
const yearBId = randomUUID()
const gradeBId = randomUUID()
const suffix = randomUUID().slice(0, 8)

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let teacher: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()

  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [teacherUserId, TEACHER_EMAIL])

  // The whole suite shares one database. This file counts assignments and
  // export jobs of the fixture school exactly, so it starts from an empty
  // table rather than whatever an earlier module file left behind.
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM export_jobs WHERE school_id = $1', [schoolA])
  // The fixture teacher is also a parent, so a stray enrolment would hand them
  // a section through the own-children scope and soften the denials below.
  await pool.query('DELETE FROM enrollments WHERE school_id = $1', [schoolA])

  // The fixture staff row predates employment capture, so give the teacher's
  // own record the fields the employment and private blocks need.
  await pool.query(
    `UPDATE staff SET joining_date = '2026-04-01', employment_type = 'permanent',
            phone = '+919812345670', department = 'Science', address = to_jsonb('12 Fixture Road'::text)
      WHERE id = $1`,
    [staffA],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,last_name,staff_type,designation,status,department,employment_type,joining_date,phone,monthly_salary)
     VALUES ($1,$2,$3,'Colleague','Kumar','teaching','Teacher','active','Maths','permanent','2026-04-01','+919812345671',40000)`,
    [colleagueId, schoolA, `COL-${suffix}`],
  )
  await pool.query(
    `INSERT INTO staff(id,school_id,employee_code,first_name,staff_type,designation,status)
     VALUES ($1,$2,$3,'Other School','teaching','Teacher','active')`,
    [staffBId, schoolB, `OTH-${suffix}`],
  )
  await pool.query(
    `INSERT INTO subjects(id,school_id,name,code,type) VALUES ($1,$2,'Science',$3,'scholastic')`,
    [subjectId, schoolA, `SCI-${suffix}`],
  )
  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status) VALUES ($1,$2,$3,'2026-04-01','2027-03-31','current')`,
    [yearBId, schoolB, `B-${suffix}`],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,'6',6)`,
    [gradeBId, schoolB, `Six-${suffix}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [sectionBId, schoolB, yearBId, gradeBId, `B-${suffix}`],
  )

  await setFixturePassword(server, teacherUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [ownerUserId])
  await pool.query('DELETE FROM teaching_assignments WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM export_jobs WHERE school_id = $1', [schoolA])
  await pool.query('DELETE FROM staff WHERE id = ANY($1::uuid[])', [[colleagueId, staffBId]])
  await server.close()
  await closeAdminPool()
})

test('the staff directory and detail need a session', async () => {
  const list = await fetch(`${server.origin}/api/schools/${schoolA}/staff`)
  assert.equal(list.status, 401)
  assert.equal(await codeOf(list), 'AUTHENTICATION_REQUIRED')

  const detail = await fetch(`${server.origin}/api/schools/${schoolA}/staff/${staffA}`)
  assert.equal(detail.status, 401)
  assert.equal(await codeOf(detail), 'AUTHENTICATION_REQUIRED')
})

test('a member of one school cannot use another school in the path', async () => {
  const list = await owner.fetch(`/api/schools/${schoolB}/staff`)
  assert.equal(list.status, 403)
  assert.equal(await codeOf(list), 'SCHOOL_ACCESS_UNAVAILABLE')

  const detail = await owner.fetch(`/api/schools/${schoolB}/staff/${staffBId}`)
  assert.equal(detail.status, 403)
  assert.equal(await codeOf(detail), 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('another school record asked for through our own path is simply not there', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/staff/${staffBId}`)
  assert.equal(response.status, 404)
  const body = await response.text()
  assert.equal(body.includes('Other School'), false)
  assert.equal(JSON.parse(body).error.code, 'RESOURCE_NOT_FOUND')
})

test('an office reader sees the directory and nothing beyond the contract', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/staff?pageSize=100`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    items: Record<string, unknown>[]
    total: number
    page: number
    pageSize: number
  }
  const ids = body.items.map((item) => item.id)
  assert.ok(ids.includes(staffA))
  assert.ok(ids.includes(colleagueId))
  assert.equal(ids.includes(staffBId), false)
  for (const item of body.items) {
    assert.deepEqual(
      Object.keys(item).filter((key) => !['id', 'schoolId', 'version', 'displayName', 'designation', 'department'].includes(key)),
      [],
    )
  }

  const counted = await owner.fetch(`/api/schools/${schoolA}/staff/count`)
  assert.equal(counted.status, 200)
  assert.deepEqual(await counted.json(), { count: body.total })
})

test('search and departments answer from the same authorized rows', async () => {
  const search = await owner.fetch(`/api/schools/${schoolA}/staff/search?q=Colleague`)
  assert.equal(search.status, 200)
  const found = (await search.json()) as { id: string }[]
  assert.deepEqual(
    found.map((row) => row.id),
    [colleagueId],
  )

  const departments = await owner.fetch(`/api/schools/${schoolA}/staff/departments`)
  const list = (await departments.json()) as string[]
  assert.ok(list.includes('Maths'))
  assert.ok(list.includes('Science'))

  const teacherDepartments = await teacher.fetch(`/api/schools/${schoolA}/staff/departments`)
  // A teacher may read only their own record, so only their department shows.
  assert.deepEqual(await teacherDepartments.json(), ['Science'])
})

test('a teacher sees only their own record in the directory', async () => {
  const response = await teacher.fetch(`/api/schools/${schoolA}/staff?pageSize=100`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { items: { id: string }[]; total: number }
  assert.deepEqual(
    body.items.map((item) => item.id),
    [staffA],
  )
  assert.equal(body.total, 1)

  const colleague = await teacher.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)
  assert.equal(colleague.status, 404)
  assert.equal((await colleague.text()).includes('Colleague'), false)
})

test('a teacher reading their own record gets employment and private, never pay', async () => {
  const response = await teacher.fetch(`/api/schools/${schoolA}/staff/${staffA}`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as Record<string, unknown>
  assert.ok(body.employment)
  assert.ok(body.private)
  assert.equal('pay' in body, false)
  assert.deepEqual(Object.keys(body.private as object).sort(), ['address', 'phone'])
  assert.ok(Array.isArray(body.allowedActions))
})

test('pay is a separate key and only an office reader who holds it sees it', async () => {
  const teacherView = await teacher.fetch(`/api/schools/${schoolA}/staff/${staffA}`)
  assert.equal((await teacherView.text()).includes('monthlySalary'), false)

  const ownerView = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)
  const body = (await ownerView.json()) as { pay?: { monthlySalary: number } }
  assert.deepEqual(body.pay, { monthlySalary: 40000 })
})

test('creating a staff record refuses pay, identity and school fields', async () => {
  const before = await adminPool().query('SELECT count(*)::int AS n FROM staff WHERE school_id = $1', [schoolA])
  const response = await owner.fetch(`/api/schools/${schoolA}/staff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      schoolId: schoolB,
      employeeCode: `BAD-${suffix}`,
      firstName: 'Nope',
      staffType: 'teaching',
      designation: 'Teacher',
      employmentType: 'permanent',
      joiningDate: '2026-04-01',
      phone: '+919812345679',
      monthlySalary: 99999,
    }),
  })
  assert.equal(response.status, 400)
  assert.equal(await codeOf(response), 'INVALID_REQUEST')
  const after = await adminPool().query('SELECT count(*)::int AS n FROM staff WHERE school_id = $1', [schoolA])
  assert.equal(after.rows[0].n, before.rows[0].n)
})

test('a permitted create answers with the directory projection only', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/staff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      employeeCode: `NEW-${suffix}`,
      firstName: 'Newly',
      lastName: 'Hired',
      staffType: 'non_teaching',
      designation: 'Librarian',
      department: 'Library',
      employmentType: 'contract',
      joiningDate: '2026-04-01',
      phone: '+919812345672',
    }),
  })
  assert.equal(response.status, 201)
  const body = (await response.json()) as Record<string, unknown>
  assert.deepEqual(Object.keys(body).sort(), ['department', 'designation', 'displayName', 'id', 'schoolId', 'version'])
  assert.equal(body.displayName, 'Newly Hired')
  await adminPool().query('DELETE FROM staff WHERE id = $1', [body.id])
})

test('employment, private and pay updates each need their own key', async () => {
  const detail = (await (await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)).json()) as {
    staff: { version: number }
  }

  const forbidden = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/employment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: detail.staff.version, designation: 'Head', monthlySalary: 1 }),
  })
  assert.equal(forbidden.status, 400)
  assert.equal(await codeOf(forbidden), 'INVALID_REQUEST')
  const unchanged = await adminPool().query('SELECT designation, version FROM staff WHERE id = $1', [colleagueId])
  assert.equal(unchanged.rows[0].designation, 'Teacher')

  const ok = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/employment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: detail.staff.version, designation: 'Head Teacher' }),
  })
  assert.equal(ok.status, 200)
  const updated = (await ok.json()) as { staff: { designation: string; version: number } }
  assert.equal(updated.staff.designation, 'Head Teacher')
  assert.equal(updated.staff.version, detail.staff.version + 1)

  const stale = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/employment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: detail.staff.version, designation: 'Again' }),
  })
  assert.equal(await codeOf(stale), 'VERSION_CONFLICT')
})

test('a teacher may edit their own private contact and nobody else\'s', async () => {
  const mine = (await (await teacher.fetch(`/api/schools/${schoolA}/staff/${staffA}`)).json()) as {
    staff: { version: number }
  }
  const ok = await teacher.fetch(`/api/schools/${schoolA}/staff/${staffA}/private`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: mine.staff.version, phone: '+919812345678' }),
  })
  assert.equal(ok.status, 200)
  const body = (await ok.json()) as { private?: { phone: string } }
  assert.equal(body.private?.phone, '+919812345678')

  const theirs = await teacher.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/private`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, phone: '+919812345677' }),
  })
  assert.equal(theirs.status, 404)
  assert.equal(await codeOf(theirs), 'RESOURCE_NOT_FOUND')
  const untouched = await adminPool().query('SELECT phone FROM staff WHERE id = $1', [colleagueId])
  assert.equal(untouched.rows[0].phone, '+919812345671')
})

test('a teacher cannot reach the pay endpoint at all', async () => {
  const response = await teacher.fetch(`/api/schools/${schoolA}/staff/${staffA}/pay`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, monthlySalary: 1, reason: 'Trying it on' }),
  })
  assert.equal(response.status, 403)
  assert.equal(await codeOf(response), 'ACCESS_DENIED')
})

test('a pay change is audited without the amount', async () => {
  const detail = (await (await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)).json()) as {
    staff: { version: number }
  }
  const response = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/pay`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: detail.staff.version, monthlySalary: 45500, reason: 'Annual revision' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(((await response.json()) as { pay: unknown }).pay, { monthlySalary: 45500 })

  const audit = await adminPool().query(
    `SELECT summary, safe_changes FROM audit_events WHERE school_id = $1 AND action = 'staff.update_pay' ORDER BY created_at DESC LIMIT 1`,
    [schoolA],
  )
  const row = audit.rows[0]
  assert.ok(row)
  assert.equal(JSON.stringify(row).includes('45500'), false)
  assert.equal(row.safe_changes.reason, 'Annual revision')
})

test('assignments are managed, listed by staff and by section, and removed', async () => {
  const detail = (await (await owner.fetch(`/api/schools/${schoolA}/staff/${staffA}`)).json()) as {
    staff: { version: number }
  }
  const body = {
    expectedVersion: detail.staff.version,
    staffId: staffA,
    sectionId: sectionA,
    subjectId,
    academicYearId: yearA,
    validFrom: '2026-04-01',
    validUntil: null,
    reason: 'Timetable planning',
  }
  const created = await owner.fetch(`/api/schools/${schoolA}/staff/${staffA}/assignments`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(created.status, 200)
  const rows = (await created.json()) as { id: string; section: { name: string }; validUntil: string | null }[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.validUntil, null)

  const byStaff = await owner.fetch(`/api/schools/${schoolA}/staff/${staffA}/assignments`)
  assert.equal(byStaff.status, 200)
  assert.equal(((await byStaff.json()) as unknown[]).length, 1)

  const bySection = await owner.fetch(`/api/schools/${schoolA}/sections/${sectionA}/assignments`)
  assert.equal(bySection.status, 200)
  assert.equal(((await bySection.json()) as unknown[]).length, 1)

  // A teacher who is not assigned anywhere cannot read a colleague's load.
  const colleagueLoad = await teacher.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/assignments`)
  assert.equal(colleagueLoad.status, 404)
  assert.equal(await codeOf(colleagueLoad), 'RESOURCE_NOT_FOUND')

  const assignmentId = rows[0]?.id as string
  const removed = await owner.fetch(
    `/api/schools/${schoolA}/staff/${staffA}/assignments/${assignmentId}`,
    { method: 'DELETE' },
  )
  assert.equal(removed.status, 204)
  const left = await adminPool().query('SELECT count(*)::int AS n FROM teaching_assignments WHERE school_id = $1', [schoolA])
  assert.equal(left.rows[0].n, 0)
})

test('an assignment may not point at another school or an unknown record', async () => {
  const detail = (await (await owner.fetch(`/api/schools/${schoolA}/staff/${staffA}`)).json()) as {
    staff: { version: number }
  }
  const base = {
    expectedVersion: detail.staff.version,
    staffId: staffA,
    sectionId: sectionA,
    subjectId,
    academicYearId: yearA,
    validFrom: '2026-04-01',
    validUntil: null,
    reason: 'Timetable planning',
  }
  for (const patch of [{ sectionId: sectionBId }, { subjectId: randomUUID() }, { staffId: colleagueId }]) {
    const response = await owner.fetch(`/api/schools/${schoolA}/staff/${staffA}/assignments`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...base, ...patch }),
    })
    assert.equal(response.status, 400)
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }
  const left = await adminPool().query('SELECT count(*)::int AS n FROM teaching_assignments WHERE school_id = $1', [schoolA])
  assert.equal(left.rows[0].n, 0)
})

test('one unreachable id rejects the whole export and writes nothing', async () => {
  const bad = await owner.fetch(`/api/schools/${schoolA}/staff/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staffIds: [staffA, staffBId] }),
  })
  assert.equal(bad.status, 404)
  assert.equal(await codeOf(bad), 'RESOURCE_NOT_FOUND')
  const none = await adminPool().query('SELECT count(*)::int AS n FROM export_jobs WHERE school_id = $1', [schoolA])
  assert.equal(none.rows[0].n, 0)

  const ok = await owner.fetch(`/api/schools/${schoolA}/staff/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staffIds: [staffA, colleagueId] }),
  })
  assert.equal(ok.status, 202)
  const job = (await ok.json()) as { id: string; status: string }
  assert.equal(job.status, 'queued')
  const stored = await adminPool().query(
    `SELECT kind, permission, requested_by_membership_id FROM export_jobs WHERE id = $1`,
    [job.id],
  )
  assert.equal(stored.rows[0].kind, 'staff')
  assert.equal(stored.rows[0].permission, 'staff.export')
})


test('a write on an unreachable record is indistinguishable from an unknown one', async () => {
  const unknown = randomUUID()
  for (const path of [
    `/api/schools/${schoolA}/staff/${colleagueId}/private`,
    `/api/schools/${schoolA}/staff/${unknown}/private`,
  ]) {
    const response = await teacher.fetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, phone: '+919812345666' }),
    })
    assert.equal(response.status, 404)
    assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
  }
  const untouched = await adminPool().query('SELECT phone FROM staff WHERE id = $1', [colleagueId])
  assert.equal(untouched.rows[0].phone, '+919812345671')

  const load = await teacher.fetch(`/api/schools/${schoolA}/staff/${unknown}/assignments`)
  assert.equal(load.status, 404)
  assert.equal(await codeOf(load), 'RESOURCE_NOT_FOUND')
})

test('an identifier that is not a record id is answered as a missing record', async () => {
  for (const path of [
    `/api/schools/${schoolA}/staff/not-a-uuid`,
    `/api/schools/${schoolA}/sections/not-a-uuid/assignments`,
  ]) {
    const response = await owner.fetch(path)
    assert.equal(response.status, 404)
    assert.equal(await codeOf(response), 'RESOURCE_NOT_FOUND')
  }

  const removed = await owner.fetch(
    `/api/schools/${schoolA}/staff/${staffA}/assignments/not-a-uuid`,
    { method: 'DELETE' },
  )
  assert.equal(removed.status, 404)

  const exported = await owner.fetch(`/api/schools/${schoolA}/staff/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staffIds: ['not-a-uuid'] }),
  })
  assert.equal(exported.status, 404)
  assert.equal(await codeOf(exported), 'RESOURCE_NOT_FOUND')
})

test('a stored value the contract cannot carry drops its block, not the response', async () => {
  // A ten digit Indian number is what the rest of the product stores today.
  await adminPool().query('UPDATE staff SET phone = $2 WHERE id = $1', [staffA, '9812345670'])
  try {
    const response = await teacher.fetch(`/api/schools/${schoolA}/staff/${staffA}`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as Record<string, unknown>
    assert.equal('private' in body, false)
    assert.ok(body.employment)

    const list = await teacher.fetch(`/api/schools/${schoolA}/staff?pageSize=100`)
    assert.equal(list.status, 200)
  } finally {
    await adminPool().query('UPDATE staff SET phone = $2 WHERE id = $1', [staffA, '+919812345670'])
  }
})

test('an overlong stored designation is trimmed rather than failing the directory', async () => {
  const long = 'X'.repeat(300)
  await adminPool().query('UPDATE staff SET designation = $2 WHERE id = $1', [colleagueId, long])
  try {
    const response = await owner.fetch(`/api/schools/${schoolA}/staff?pageSize=100`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { items: { id: string; designation: string }[] }
    const row = body.items.find((item) => item.id === colleagueId)
    assert.equal(row?.designation.length, 160)
  } finally {
    await adminPool().query('UPDATE staff SET designation = $2 WHERE id = $1', [colleagueId, 'Teacher'])
  }
})

test('a leaving date before the stored joining date is refused', async () => {
  const detail = (await (await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)).json()) as {
    staff: { version: number }
  }
  const response = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/employment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: detail.staff.version, leavingDate: '2000-01-01' }),
  })
  assert.equal(response.status, 400)
  assert.equal(await codeOf(response), 'INVALID_REQUEST')
  const stored = await adminPool().query('SELECT leaving_date FROM staff WHERE id = $1', [colleagueId])
  assert.equal(stored.rows[0].leaving_date, null)
})

test('the section assignment list is guarded like every other read', async () => {
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/sections/${sectionA}/assignments`)
  assert.equal(anonymous.status, 401)

  const otherSchool = await owner.fetch(`/api/schools/${schoolB}/sections/${sectionBId}/assignments`)
  assert.equal(otherSchool.status, 403)
  assert.equal(await codeOf(otherSchool), 'SCHOOL_ACCESS_UNAVAILABLE')

  const foreignSection = await owner.fetch(`/api/schools/${schoolA}/sections/${sectionBId}/assignments`)
  assert.equal(foreignSection.status, 404)
  assert.equal(await codeOf(foreignSection), 'RESOURCE_NOT_FOUND')

  // The teacher teaches nothing, so no section of this school is theirs.
  const notTheirs = await teacher.fetch(`/api/schools/${schoolA}/sections/${sectionA}/assignments`)
  assert.ok([403, 404].includes(notTheirs.status))
  assert.equal((await notTheirs.text()).includes('Colleague'), false)
})
