import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import ExcelJS from 'exceljs'
import { isVerhoeffValid } from '@erp/contracts'
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
const OWNER_EMAIL = `staff-owner-${randomUUID()}@example.test`
const TEACHER_EMAIL = `staff-teacher-${randomUUID()}@example.test`
const OFFICER_EMAIL = `staff-officer-${randomUUID()}@example.test`

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
// A second office member, so the employee counter can be shown to belong to
// the school rather than to whoever is signed in.
const officerUser = randomUUID()
const officerMembership = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let teacher: Client
let officer: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}

/**
 * Runs `check` with the fixture year as the school's current year. Earlier files in
 * the shared database may have made another year current, and the directory names
 * only this year's subjects. The year state is put back whatever happens.
 */
async function withFixtureYearCurrent(check: () => Promise<void>): Promise<void> {
  const pool = adminPool()
  const years = (await pool.query<{ id: string; status: string }>(
    'SELECT id, status FROM academic_years WHERE school_id = $1', [schoolA],
  )).rows
  const pinned = (await pool.query<{ current_academic_year_id: string | null }>(
    'SELECT current_academic_year_id FROM schools WHERE id = $1', [schoolA],
  )).rows[0]?.current_academic_year_id ?? null
  await pool.query(`UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND status = 'current'`, [schoolA])
  await pool.query(`UPDATE academic_years SET status = 'current' WHERE school_id = $1 AND id = $2`, [schoolA, yearA])
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [schoolA, yearA])
  try {
    await check()
  } finally {
    // Close first, then reopen, so two years are never current at once.
    await pool.query(`UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND status = 'current'`, [schoolA])
    for (const year of years) {
      await pool.query('UPDATE academic_years SET status = $3 WHERE school_id = $1 AND id = $2', [schoolA, year.id, year.status])
    }
    await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [schoolA, pinned])
  }
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

  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'Office Admin',$2)`,
    [officerUser, OFFICER_EMAIL],
  )
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [officerMembership, schoolA, officerUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'admin' ON CONFLICT DO NOTHING`,
    [schoolA, officerMembership],
  )

  await setFixturePassword(server, teacherUserId, PASSWORD)
  await setFixturePassword(server, officerUser, PASSWORD)
  officer = await signInWithMfa(server, { userId: officerUser, email: OFFICER_EMAIL, password: PASSWORD })
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  for (const userId of [ownerUserId, officerUser]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
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
      Object.keys(item).filter((key) => !['id', 'schoolId', 'version', 'displayName', 'designation', 'department', 'anonymised', 'hasPhoto', 'photoUpdatedAt', 'subjects'].includes(key)),
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

test('the directory can be filtered to one department', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/staff?pageSize=100&department=Maths`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { items: { id: string }[]; total: number }
  assert.deepEqual(
    body.items.map((item) => item.id),
    [colleagueId],
  )
  // The total describes the filtered rows, not the whole directory.
  assert.equal(body.total, 1)

  // A teacher reads their own record only, so another department is empty.
  const theirs = await teacher.fetch(`/api/schools/${schoolA}/staff?pageSize=100&department=Maths`)
  assert.equal(theirs.status, 200)
  const mine = (await theirs.json()) as { items: { id: string }[]; total: number }
  assert.deepEqual(mine.items, [])
  assert.equal(mine.total, 0)
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
  assert.deepEqual(Object.keys(body).sort(), [
    'anonymised', 'department', 'designation', 'displayName', 'employeeCode', 'hasPhoto', 'id', 'schoolId', 'version',
  ])
  assert.equal(body.displayName, 'Newly Hired')
  // The create response names the assigned code, so the screen shows it without a second read.
  assert.match(String(body.employeeCode), /^A-E\d{3,}$/)
  await adminPool().query('DELETE FROM staff WHERE id = $1', [body.id])
})

async function createStaffAs(client: Client, firstName: string): Promise<string> {
  const response = await client.fetch(`/api/schools/${schoolA}/staff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName,
      staffType: 'non_teaching',
      designation: 'Clerk',
      employmentType: 'contract',
      joiningDate: '2026-04-01',
      phone: '+919812345673',
    }),
  })
  assert.equal(response.status, 201)
  return ((await response.json()) as { id: string }).id
}

test('a create may not choose its own employee code', async () => {
  const before = await adminPool().query('SELECT count(*)::int AS n FROM staff WHERE school_id = $1', [schoolA])
  const response = await owner.fetch(`/api/schools/${schoolA}/staff`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      employeeCode: 'A-E900',
      firstName: 'Numbered',
      staffType: 'teaching',
      designation: 'Teacher',
      employmentType: 'permanent',
      joiningDate: '2026-04-01',
      phone: '+919812345679',
    }),
  })
  assert.equal(response.status, 400)
  assert.equal(await codeOf(response), 'INVALID_REQUEST')
  const after = await adminPool().query('SELECT count(*)::int AS n FROM staff WHERE school_id = $1', [schoolA])
  assert.equal(after.rows[0].n, before.rows[0].n)
})

test('the employee code comes from the school counter, whoever creates the record', async () => {
  const first = await createStaffAs(owner, 'Counter One')
  const second = await createStaffAs(officer, 'Counter Two')
  const pool = adminPool()
  const codes = await pool.query<{ id: string; employee_code: string }>(
    'SELECT id, employee_code FROM staff WHERE id = ANY($1::uuid[])',
    [[first, second]],
  )
  const byId = new Map(codes.rows.map((row) => [row.id, row.employee_code]))
  const firstCode = byId.get(first)
  const secondCode = byId.get(second)
  assert.ok(firstCode && secondCode)
  for (const code of [firstCode, secondCode]) assert.match(code, /^A-E\d{3,}$/)
  const counter = (code: string) => Number(code.slice('A-E'.length))
  assert.equal(counter(secondCode), counter(firstCode) + 1)
  await pool.query('DELETE FROM staff WHERE id = ANY($1::uuid[])', [[first, second]])
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

  // The reason a person typed lives in the redactable note table, never in the
  // permanent safe_changes.
  const audit = await adminPool().query<{
    summary: string
    safe_changes: Record<string, unknown>
    note: string | null
  }>(
    `SELECT e.summary, e.safe_changes, n.note
       FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.action = 'staff.update_pay' ORDER BY e.created_at DESC LIMIT 1`,
    [schoolA],
  )
  const row = audit.rows[0]
  assert.ok(row)
  assert.equal(JSON.stringify(row.safe_changes).includes('45500'), false)
  assert.equal('reason' in row.safe_changes, false)
  assert.equal(row.note, 'Annual revision')
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

  // The directory names what each person teaches this year, for a reader of their employment.
  type DirectoryRow = { id: string; subjects?: string[] }
  await withFixtureYearCurrent(async () => {
    const officeRows = ((await (await owner.fetch(`/api/schools/${schoolA}/staff?pageSize=100`)).json()) as { items: DirectoryRow[] }).items
    assert.deepEqual(officeRows.find((row) => row.id === staffA)?.subjects, ['Science'])
    assert.equal(officeRows.find((row) => row.id === colleagueId)?.subjects, undefined)
    const ownRows = ((await (await teacher.fetch(`/api/schools/${schoolA}/staff?pageSize=100`)).json()) as { items: DirectoryRow[] }).items
    assert.deepEqual(ownRows.find((row) => row.id === staffA)?.subjects, ['Science'])
  })

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
  const job = (await ok.json()) as { id: string; status: string; format: string }
  // Two rows are well under the inline limit, so the file is already made.
  assert.equal(job.status, 'ready')
  assert.equal(job.format, 'xlsx')
  const stored = await adminPool().query(
    `SELECT kind, permission, requested_by_membership_id FROM export_jobs WHERE id = $1`,
    [job.id],
  )
  assert.equal(stored.rows[0].kind, 'staff')
  assert.equal(stored.rows[0].permission, 'staff.export')

  // The file is real and holds the two people who were asked for, with the
  // directory columns only: no salary, no private contact, no identifiers.
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load((await readExportFileBytes(server, job.id)) as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  assert.ok(sheet)
  assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1).map(String), [
    'Employee code',
    'Name',
    'Role',
    'Department',
    'Status',
  ])
  assert.equal(sheet.rowCount, 3)
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

test('a leaving date that is set comes back, and clearing it takes it away again', async () => {
  const read = async () =>
    (await (await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)).json()) as {
      staff: { version: number }
      employment?: Record<string, unknown>
    }

  const before = await read()
  assert.ok(before.employment)
  assert.equal('leavingDate' in before.employment, false)

  const set = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/employment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: before.staff.version, leavingDate: '2027-03-31' }),
  })
  assert.equal(set.status, 200)
  const withDate = await read()
  assert.equal(withDate.employment?.leavingDate, '2027-03-31')

  // The office corrects a mistake: the date goes away rather than staying on
  // a record of somebody who is still here.
  const cleared = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/employment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: withDate.staff.version, leavingDate: null }),
  })
  assert.equal(cleared.status, 200)
  const after = await read()
  assert.ok(after.employment)
  assert.equal('leavingDate' in after.employment, false)
})

test('a leaving date is never on a row of the directory, which carries no employment', async () => {
  const detail = (await (await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)).json()) as {
    staff: { version: number }
  }
  const set = await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/employment`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: detail.staff.version, leavingDate: '2027-03-31' }),
  })
  assert.equal(set.status, 200)
  try {
    const list = await owner.fetch(`/api/schools/${schoolA}/staff?pageSize=100`)
    assert.equal(list.status, 200)
    const body = (await list.json()) as { items: Record<string, unknown>[] }
    const row = body.items.find((item) => item.id === colleagueId)
    assert.ok(row)
    assert.equal('employment' in row, false)
    assert.equal('leavingDate' in row, false)
  } finally {
    const current = (await (await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)).json()) as {
      staff: { version: number }
    }
    await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}/employment`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedVersion: current.staff.version, leavingDate: null }),
    })
  }
})

/** A twelve digit number that passes the Aadhaar check digit. */
function makeAadhaar(): string {
  for (;;) {
    const head = String(2 + Math.floor(Math.random() * 8)) + String(Math.floor(Math.random() * 1e10)).padStart(10, '0')
    for (let digit = 0; digit <= 9; digit += 1) {
      if (isVerhoeffValid(`${head}${digit}`)) return `${head}${digit}`
    }
  }
}

async function versionOf(staffId: string): Promise<number> {
  const found = await adminPool().query<{ version: number }>('SELECT version FROM staff WHERE id = $1', [staffId])
  return Number(found.rows[0]?.version)
}

async function putPrivate(client: Client, staffId: string, fields: Record<string, unknown>): Promise<Response> {
  return client.fetch(`/api/schools/${schoolA}/staff/${staffId}/private`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: await versionOf(staffId), ...fields }),
  })
}

test('a staff Aadhaar number is sealed, shown as its last four and cleared with null', async () => {
  const aadhaar = makeAadhaar()
  const saved = await putPrivate(owner, colleagueId, { aadhaar })
  assert.equal(saved.status, 200)
  const text = await saved.text()
  assert.equal(text.includes(aadhaar), false)
  assert.equal((JSON.parse(text) as { private?: { aadhaarLast4?: string } }).private?.aadhaarLast4, aadhaar.slice(-4))

  const pool = adminPool()
  const stored = await pool.query<{ aadhaar_ciphertext: string | null; aadhaar_last4: string | null }>(
    'SELECT aadhaar_ciphertext, aadhaar_last4 FROM staff WHERE id = $1',
    [colleagueId],
  )
  assert.match(stored.rows[0]?.aadhaar_ciphertext ?? '', /^v1\./)
  assert.equal(stored.rows[0]?.aadhaar_ciphertext?.includes(aadhaar), false)
  assert.equal(stored.rows[0]?.aadhaar_last4, aadhaar.slice(-4))

  const detail = (await (await owner.fetch(`/api/schools/${schoolA}/staff/${colleagueId}`)).json()) as {
    private?: { aadhaarLast4?: string }
  }
  assert.equal(detail.private?.aadhaarLast4, aadhaar.slice(-4))

  // A malformed number is refused and changes nothing.
  const bad = await putPrivate(owner, colleagueId, { aadhaar: '123456789012' })
  assert.equal(bad.status, 400)

  const cleared = await putPrivate(owner, colleagueId, { aadhaar: null })
  assert.equal(cleared.status, 200)
  const gone = await pool.query<{ aadhaar_ciphertext: string | null; aadhaar_last4: string | null }>(
    'SELECT aadhaar_ciphertext, aadhaar_last4 FROM staff WHERE id = $1',
    [colleagueId],
  )
  assert.deepEqual(gone.rows[0], { aadhaar_ciphertext: null, aadhaar_last4: null })

  // One audit row per change: it says the Aadhaar changed, never the number.
  const audits = await pool.query<{ safe_changes: Record<string, unknown> }>(
    `SELECT safe_changes FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = 'staff.update_private'
        AND safe_changes ? 'aadhaarChanged'
      ORDER BY created_at`,
    [schoolA, colleagueId],
  )
  assert.deepEqual(audits.rows.map((row) => row.safe_changes), [
    { fields: ['aadhaar'], aadhaarChanged: true, aadhaarCleared: false },
    { fields: ['aadhaar'], aadhaarChanged: true, aadhaarCleared: true },
  ])
  assert.equal(JSON.stringify(audits.rows).includes(aadhaar), false)
})

/** The export as a grid of text: the header row first, then one row per person. */
async function staffGrid(
  client: Client,
  request: Record<string, unknown>,
): Promise<{ jobId: string; grid: string[][] }> {
  const response = await client.fetch(`/api/schools/${schoolA}/staff/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  })
  assert.equal(response.status, 202)
  const job = (await response.json()) as { id: string; status: string }
  assert.equal(job.status, 'ready')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load((await readExportFileBytes(server, job.id)) as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  assert.ok(sheet)
  const grid: string[][] = []
  sheet.eachRow((row) => {
    const cells: string[] = []
    for (let index = 1; index <= sheet.columnCount; index += 1) {
      const value = row.getCell(index).value
      cells.push(value === null || value === undefined ? '' : String(value))
    }
    grid.push(cells)
  })
  return { jobId: job.id, grid }
}

/** A fresh office member with one role, signed in with the second step. */
async function officeMember(role: string): Promise<{ client: Client; membershipId: string }> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `staff-${role}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user (id, name, email) VALUES ($1, $2, $3)', [userId, `Export ${role}`, email])
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status) VALUES ($1, $2, $3, 'adult', 'active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = $3`,
    [schoolA, membershipId, role],
  )
  return { client: await signInWithMfa(server, { userId, email, password: PASSWORD }), membershipId }
}

test('a staff export with no columns is the five directory columns, chosen ones come in list order', async () => {
  const plain = await staffGrid(owner, { staffIds: [colleagueId] })
  assert.deepEqual(plain.grid, [
    ['Employee code', 'Name', 'Role', 'Department', 'Status'],
    [`COL-${suffix}`, 'Colleague Kumar', 'Teacher', 'Maths', 'active'],
  ])

  const chosen = await staffGrid(owner, {
    staffIds: [colleagueId],
    columns: ['phone', 'employmentType', 'name', 'joiningDate', 'employeeCode'],
  })
  assert.deepEqual(chosen.grid, [
    ['Employee code', 'Name', 'Employment type', 'Joining date', 'Phone'],
    [`COL-${suffix}`, 'Colleague Kumar', 'Permanent', '01 Apr 2026', '+919812345671'],
  ])
  const audit = await adminPool().query<{ safe_changes: Record<string, unknown> }>(
    `SELECT safe_changes FROM audit_events WHERE school_id = $1 AND target_id = $2 AND action = 'staff.export'`,
    [schoolA, chosen.jobId],
  )
  assert.equal(audit.rowCount, 1)
  assert.deepEqual(audit.rows[0]?.safe_changes.columns, ['employeeCode', 'name', 'employmentType', 'joiningDate', 'phone'])
  assert.equal(JSON.stringify(audit.rows[0]?.safe_changes).includes('+919812345671'), false)
})

test('the whole staff Aadhaar is for the owner and the administrator, and pay is never a column', async () => {
  const aadhaar = makeAadhaar()
  assert.equal((await putPrivate(owner, colleagueId, { aadhaar })).status, 200)
  try {
    const request = { staffIds: [colleagueId], columns: ['employeeCode', 'aadhaarLast4', 'aadhaar'] }
    for (const client of [owner, officer]) {
      const { grid } = await staffGrid(client, request)
      assert.deepEqual(grid[1], [`COL-${suffix}`, aadhaar.slice(-4), aadhaar])
    }

    const principal = await officeMember('principal')
    const refused = await principal.client.fetch(`/api/schools/${schoolA}/staff/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    assert.equal(refused.status, 403)
    assert.equal(await codeOf(refused), 'ACCESS_DENIED')
    const none = await adminPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM export_jobs WHERE school_id = $1 AND requested_by_membership_id = $2',
      [schoolA, principal.membershipId],
    )
    assert.equal(none.rows[0]?.n, 0)

    const salary = await owner.fetch(`/api/schools/${schoolA}/staff/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ staffIds: [colleagueId], columns: ['monthlySalary'] }),
    })
    assert.equal(salary.status, 400)
  } finally {
    await putPrivate(owner, colleagueId, { aadhaar: null })
  }
})

test('an accountant exports private staff columns through the finance scope', async () => {
  const accountant = await officeMember('accountant')
  const { grid } = await staffGrid(accountant.client, {
    staffIds: [colleagueId],
    columns: ['employeeCode', 'staffType', 'phone', 'joiningDate'],
  })
  assert.deepEqual(grid, [
    ['Employee code', 'Staff type', 'Joining date', 'Phone'],
    [`COL-${suffix}`, 'Teaching', '01 Apr 2026', '+919812345671'],
  ])
  const refused = await accountant.client.fetch(`/api/schools/${schoolA}/staff/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ staffIds: [colleagueId], columns: ['employeeCode', 'aadhaar'] }),
  })
  assert.equal(refused.status, 403)
  assert.equal(await codeOf(refused), 'ACCESS_DENIED')
})
