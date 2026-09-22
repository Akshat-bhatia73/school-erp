/**
 * The three attendance files (Task 20): a section's monthly register, one
 * pupil's month as a document and the staff register.
 *
 * A route only decides that the caller may ask; the producer reads every row
 * again under that same person's own plans when it makes the bytes. So each
 * test here asks for the file, checks the job came back ready and then
 * downloads it through the shared export route, which is the only way a file
 * ever reaches anybody.
 *
 * The suite owns its year, class, section and pupils so that no other suite's
 * rows can end up in one of its files.
 */
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
const OWNER_EMAIL = `att-export-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string
const yearA = fixtureIds.yearA as string

const suffix = randomUUID().slice(0, 8)
const exportYear = randomUUID()
const exportGrade = randomUUID()
const exportSection = randomUUID()
// Earlier than the year the attendance module suite owns, so the calendar
// never has to settle a tie between the two.
const YEAR_START = '2026-05-01'
const YEAR_END = '2027-03-31'

// The parent's own child, and a pupil of another family in the same class.
const child = randomUUID()
const stranger = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let parent: Client
let staffId = ''
const extraUserIds: string[] = []
let previousCurrentYear: string | null = null
let today = ''
let month = ''

interface Job {
  id: string
  status: string
  fileName?: string
  format?: string
}
interface ErrorBody {
  error: { code: string; requestId: string; reason?: string }
}

function post(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}
function put(value: unknown): RequestInit {
  return { ...post(value), method: 'PUT' }
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function jobCount(): Promise<number> {
  const found = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM export_jobs WHERE school_id = $1`,
    [schoolA],
  )
  return Number(found.rows[0]?.count)
}

/**
 * The job a route made, downloaded through the shared export route. Nothing
 * here reads the storage key: a file reaches a person one way only.
 */
async function fileOf(client: Client, response: Response, expected: 'pdf' | 'xlsx'): Promise<void> {
  assert.equal(response.status, 202, await response.clone().text())
  const job = await json<Job>(response)
  assert.equal(job.status, 'ready', 'a small file is made in the request that asked for it')
  assert.equal(job.format, expected)
  assert.ok(job.fileName?.endsWith(`.${expected}`), `${job.fileName} is not a ${expected} file`)

  const download = await client.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(download.status, 200, await download.clone().text())
  assert.equal(
    download.headers.get('content-type'),
    expected === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  const bytes = Buffer.from(await download.arrayBuffer())
  assert.ok(bytes.byteLength > 0, 'the file is not empty')
  // A PDF starts with %PDF; an xlsx is a zip, which starts with PK.
  const head = bytes.subarray(0, 4).toString('latin1')
  assert.equal(head.startsWith(expected === 'pdf' ? '%PDF' : 'PK'), true, `the bytes start with ${head}`)
}

/** A brand new member of school A with the roles named, signed in. */
async function member(input: {
  roleKeys: readonly string[]
  label: string
  withMfa: boolean
  childId?: string
}): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `att-export-${input.label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [
    userId,
    `Attendance export ${input.label}`,
    email,
  ])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [schoolA, membershipId, [...input.roleKeys]],
  )
  if (input.childId !== undefined) {
    const guardianId = randomUUID()
    await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [
      guardianId,
      schoolA,
      'Export guardian',
    ])
    await pool.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at)
       VALUES ($1,$2,$3,now())`,
      [schoolA, membershipId, guardianId],
    )
    await pool.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian')`,
      [schoolA, input.childId, guardianId],
    )
    await pool.query(
      `INSERT INTO guardian_student_access
         (school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
       VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,now())`,
      [schoolA, guardianId, input.childId, ownerMembershipId],
    )
  }
  await setFixturePassword(server, userId, PASSWORD)
  extraUserIds.push(userId)
  return input.withMfa
    ? signInWithMfa(server, { userId, email, password: PASSWORD })
    : signInWithPassword(server, email, PASSWORD)
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,$5,'current')`,
    [exportYear, schoolA, `XATT-${suffix}`, YEAR_START, YEAR_END],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,12)`,
    [exportGrade, schoolA, `Attendance files ${suffix}`, `X${suffix.slice(0, 3)}`],
  )
  const staff = await pool.query<{ id: string }>(
    `INSERT INTO staff(school_id,employee_code,first_name,staff_type,designation,status,joining_date)
     VALUES ($1,$2,'Files','teaching','Teacher','active',$3) RETURNING id`,
    [schoolA, `XATT-${suffix}`, YEAR_START],
  )
  staffId = staff.rows[0]?.id as string
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name,class_teacher_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [exportSection, schoolA, exportYear, exportGrade, `XS-${suffix.slice(0, 4)}`, staffId],
  )
  for (const [index, [id, name]] of [
    [child, 'Own Child'],
    [stranger, 'Other Family'],
  ].entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, schoolA, `XATT/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), schoolA, id, exportYear, exportSection, index + 1, YEAR_START],
    )
  }

  const pinned = await pool.query<{ current_academic_year_id: string | null }>(
    'SELECT current_academic_year_id FROM schools WHERE id = $1',
    [schoolA],
  )
  previousCurrentYear = pinned.rows[0]?.current_academic_year_id ?? null
  await pool.query(
    `UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND status = 'current' AND id <> $2`,
    [schoolA, exportYear],
  )
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [schoolA, exportYear])

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  parent = await member({ roleKeys: ['parent'], label: 'parent', withMfa: false, childId: child })

  // A register worth printing: the class marked today, and the staff member
  // marked on the same day.
  const day = await json<{ date: string; rows: { student: { id: string } }[] }>(
    await owner.fetch(`/api/schools/${schoolA}/attendance/sections`),
  )
  today = day.date
  month = today.slice(0, 7)
  const marked = await owner.fetch(
    `/api/schools/${schoolA}/attendance/sections/${exportSection}/days/${today}`,
    put({
      marks: [
        { studentId: child, mark: 'present' },
        { studentId: stranger, mark: 'absent' },
      ],
    }),
  )
  assert.equal(marked.status, 200, await marked.clone().text())
  const register = await json<{ rows: { staff: { id: string } }[] }>(
    await owner.fetch(`/api/schools/${schoolA}/staff-attendance/days/${today}`),
  )
  const staffMarks = await owner.fetch(
    `/api/schools/${schoolA}/staff-attendance/days/${today}`,
    put({ marks: register.rows.map((row) => ({ staffId: row.staff.id, mark: 'present' })) }),
  )
  assert.equal(staffMarks.status, 200, await staffMarks.clone().text())
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await pool.query(`UPDATE academic_years SET status = 'closed' WHERE school_id = $1 AND id = $2`, [
    schoolA,
    exportYear,
  ])
  await pool.query(`UPDATE academic_years SET status = 'current' WHERE school_id = $1 AND id = $2`, [
    schoolA,
    previousCurrentYear ?? yearA,
  ])
  await pool.query('UPDATE schools SET current_academic_year_id = $2 WHERE id = $1', [
    schoolA,
    previousCurrentYear ?? yearA,
  ])
  await server.close()
  await closeAdminPool()
})

test('a section’s month comes back as a spreadsheet and as a document', async () => {
  for (const format of ['xlsx', 'pdf'] as const) {
    const response = await owner.fetch(
      `/api/schools/${schoolA}/attendance/sections/${exportSection}/months/${month}/export`,
      post({ format }),
    )
    await fileOf(owner, response, format)
  }
})

test('the staff register comes back as a spreadsheet and as a document', async () => {
  for (const format of ['xlsx', 'pdf'] as const) {
    const response = await owner.fetch(
      `/api/schools/${schoolA}/staff-attendance/months/${month}/export`,
      post({ format }),
    )
    await fileOf(owner, response, format)
  }
})

test('a month outside the section’s own year is refused before any job exists', async () => {
  const before = await jobCount()
  const response = await owner.fetch(
    `/api/schools/${schoolA}/attendance/sections/${exportSection}/months/2019-05/export`,
    post({ format: 'xlsx' }),
  )
  assert.equal(response.status, 400, await response.clone().text())
  assert.equal((await json<ErrorBody>(response)).error.reason, 'attendance_month_outside_year')
  assert.equal(await jobCount(), before, 'nothing was written')
})

test('a parent prints their own child’s month and never another family’s', async () => {
  const mine = await parent.fetch(
    `/api/schools/${schoolA}/attendance/students/${child}/months/${month}/export`,
    post({}),
  )
  await fileOf(parent, mine, 'pdf')

  const before = await jobCount()
  for (const id of [stranger, randomUUID()]) {
    // A pupil of another family and a pupil who never existed answer exactly
    // the same way, so asking never says which ids are real.
    const theirs = await parent.fetch(
      `/api/schools/${schoolA}/attendance/students/${id}/months/${month}/export`,
      post({}),
    )
    assert.equal(theirs.status, 404, await theirs.clone().text())
    assert.equal((await json<ErrorBody>(theirs)).error.code, 'RESOURCE_NOT_FOUND')
  }
  assert.equal(await jobCount(), before, 'a refused request leaves no job row')
})

test('a parent is refused both registers, and the class file of their own child', async () => {
  const before = await jobCount()
  const register = await parent.fetch(
    `/api/schools/${schoolA}/attendance/sections/${exportSection}/months/${month}/export`,
    post({ format: 'xlsx' }),
  )
  assert.equal(register.status, 403, await register.clone().text())
  assert.equal((await json<ErrorBody>(register)).error.code, 'ACCESS_DENIED')

  const staffRegister = await parent.fetch(
    `/api/schools/${schoolA}/staff-attendance/months/${month}/export`,
    post({ format: 'xlsx' }),
  )
  assert.equal(staffRegister.status, 403)
  assert.equal(await jobCount(), before, 'a refused file request leaves no job row')
})

test('one owner’s export file is not another member’s to download', async () => {
  const response = await owner.fetch(
    `/api/schools/${schoolA}/attendance/sections/${exportSection}/months/${month}/export`,
    post({ format: 'pdf' }),
  )
  assert.equal(response.status, 202, await response.clone().text())
  const job = await json<Job>(response)
  const theirs = await parent.fetch(`/api/schools/${schoolA}/exports/${job.id}/file`)
  assert.equal(theirs.status, 404, await theirs.clone().text())
})
