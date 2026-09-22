/**
 * The three fee files (Task 19): one receipt as a document, the dues list and
 * the collection register.
 *
 * A route only decides that the caller may ask; the producer reads every row
 * again under that same person's own plans when it makes the bytes. So each
 * test here asks for the file, waits for the job to be ready and then reads
 * the bytes the server actually stored, rather than trusting the job row.
 *
 * The suite owns its year, class, section and pupils so no other suite's rows
 * can end up in one of its files.
 */
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

const schoolA = fixtureIds.schoolA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string

const suffix = randomUUID().slice(0, 8)
const exportYear = randomUUID()
const exportGrade = randomUUID()
const exportSection = randomUUID()
const YEAR_START = '2026-04-01'
const YEAR_END = '2027-03-31'

const tuitionHead = randomUUID()
const TUITION = 200_000

// The parent's own child, and a pupil of another family.
const child = randomUUID()
const stranger = randomUUID()

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let admin: Client
let parent: Client
const extraUserIds: string[] = []

let childReceiptId = ''
let strangerReceiptId = ''
let today = ''

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

/** A brand new member of school A with the roles named, signed in. */
async function member(roleKeys: readonly string[], label: string, withMfa: boolean): Promise<Client> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `fee-export-${label}-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [
    userId,
    `Fee export ${label}`,
    email,
  ])
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [schoolA, membershipId, [...roleKeys]],
  )
  if (label === 'parent') {
    // The family link the portal grant hangs on: a guardian, a verified
    // membership link, the relation and the approved access row.
    const guardianId = randomUUID()
    await pool.query('INSERT INTO guardians(id,school_id,first_name) VALUES ($1,$2,$3)', [
      guardianId,
      schoolA,
      'Export Guardian',
    ])
    await pool.query(
      `INSERT INTO membership_guardian_links(school_id,membership_id,guardian_id,verified_at)
       VALUES ($1,$2,$3,now())`,
      [schoolA, membershipId, guardianId],
    )
    await pool.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian')`,
      [schoolA, child, guardianId],
    )
    await pool.query(
      `INSERT INTO guardian_student_access
         (school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
       VALUES ($1,$2,$3,'approved',ARRAY['basic','fees'],$4,now())`,
      [schoolA, guardianId, child, ownerMembershipId],
    )
  }
  await setFixturePassword(server, userId, PASSWORD)
  extraUserIds.push(userId)
  return withMfa
    ? signInWithMfa(server, { userId, email, password: PASSWORD })
    : signInWithPassword(server, email, PASSWORD)
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  const OWNER_EMAIL = `fee-export-owner-${randomUUID()}@example.test`
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])

  await pool.query(
    `INSERT INTO academic_years(id,school_id,name,start_date,end_date,status)
     VALUES ($1,$2,$3,$4,$5,'upcoming')`,
    [exportYear, schoolA, `XFEE-${suffix}`, YEAR_START, YEAR_END],
  )
  await pool.query(
    `INSERT INTO grades(id,school_id,name,short_name,sort_order) VALUES ($1,$2,$3,$4,10)`,
    [exportGrade, schoolA, `Export fees ${suffix}`, `X${suffix.slice(0, 3)}`],
  )
  await pool.query(
    `INSERT INTO sections(id,school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4,$5)`,
    [exportSection, schoolA, exportYear, exportGrade, `XS-${suffix.slice(0, 4)}`],
  )
  for (const [index, [id, name]] of [
    [child, 'Own Child'],
    [stranger, 'Other Family'],
  ].entries()) {
    await pool.query(
      `INSERT INTO students(id,school_id,admission_number,first_name,status) VALUES ($1,$2,$3,$4,'active')`,
      [id, schoolA, `XFEE/${suffix}/${index + 1}`, name],
    )
    await pool.query(
      `INSERT INTO enrollments(id,school_id,student_id,academic_year_id,section_id,roll_number,joined_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), schoolA, id, exportYear, exportSection, index + 1, YEAR_START],
    )
  }
  await pool.query(
    `INSERT INTO fee_heads(id,school_id,name,category,applies_to,frequency)
     VALUES ($1,$2,$3,'tuition','class','yearly')`,
    [tuitionHead, schoolA, `Export tuition ${suffix}`],
  )
  await pool.query(
    `INSERT INTO fee_structures(school_id,academic_year_id,fee_head_id,grade_id,amount_paise)
     VALUES ($1,$2,$3,$4,$5)`,
    [schoolA, exportYear, tuitionHead, exportGrade, TUITION],
  )

  server = await startTestServer()
  await setFixturePassword(server, ownerUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  admin = await member(['admin'], 'admin', true)
  parent = await member(['parent'], 'parent', false)

  const statement = await json<{ asOf: string }>(
    await owner.fetch(
      `/api/schools/${schoolA}/fees/students/${child}/statement?academicYearId=${exportYear}`,
    ),
  )
  today = statement.asOf

  for (const [pupil, holder] of [
    [child, 'childReceiptId'],
    [stranger, 'strangerReceiptId'],
  ] as const) {
    const response = await owner.fetch(
      `/api/schools/${schoolA}/fees/students/${pupil}/collect`,
      post({
        academicYearId: exportYear,
        lines: [{ feeHeadId: tuitionHead, amountPaise: 50_000 }],
        mode: 'cash',
        receivedOn: today,
      }),
    )
    assert.equal(response.status, 201, await response.clone().text())
    const receipt = await json<{ id: string }>(response)
    if (holder === 'childReceiptId') childReceiptId = receipt.id
    else strangerReceiptId = receipt.id
  }
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, ...extraUserIds],
  ])
  await server.close()
  await closeAdminPool()
})

/** The job the route made, once, with the bytes the server stored for it. */
async function fileOf(response: Response, expected: 'pdf' | 'xlsx'): Promise<Uint8Array> {
  assert.equal(response.status, 202, await response.clone().text())
  const job = await json<Job>(response)
  assert.equal(job.status, 'ready', 'a small file is made in the request that asked for it')
  assert.equal(job.format, expected)
  assert.ok(job.fileName?.endsWith(`.${expected}`), `${job.fileName} is not a ${expected} file`)
  const bytes = await readExportFileBytes(server, job.id)
  assert.ok(bytes.byteLength > 0, 'the file is not empty')
  const head = Buffer.from(bytes.subarray(0, 4)).toString('latin1')
  // A PDF starts with %PDF; an xlsx is a zip, which starts with PK.
  assert.equal(head.startsWith(expected === 'pdf' ? '%PDF' : 'PK'), true, `the bytes start with ${head}`)
  return bytes
}

test('one receipt comes back as a document with bytes behind it', async () => {
  const response = await owner.fetch(
    `/api/schools/${schoolA}/fees/receipts/${childReceiptId}/export`,
    post({}),
  )
  await fileOf(response, 'pdf')
})

test('the dues list comes back as a spreadsheet and as a document', async () => {
  for (const format of ['xlsx', 'pdf'] as const) {
    const response = await owner.fetch(
      `/api/schools/${schoolA}/fees/dues/export`,
      post({ academicYearId: exportYear, show: 'all', format }),
    )
    await fileOf(response, format)
  }
})

test('the collection register comes back as a spreadsheet and as a document', async () => {
  for (const format of ['xlsx', 'pdf'] as const) {
    const response = await owner.fetch(
      `/api/schools/${schoolA}/fees/receipts/export`,
      post({ from: YEAR_START, to: today, format }),
    )
    await fileOf(response, format)
  }
})

test('a register longer than a year is refused before any job exists', async () => {
  const before = await jobCount()
  const response = await owner.fetch(
    `/api/schools/${schoolA}/fees/receipts/export`,
    post({ from: '2025-01-01', to: '2026-12-31', format: 'xlsx' }),
  )
  assert.equal(response.status, 400, await response.clone().text())
  assert.equal(await jobCount(), before, 'nothing was written')
})

test('a parent prints their own child’s receipt and never another family’s', async () => {
  const mine = await parent.fetch(
    `/api/schools/${schoolA}/fees/receipts/${childReceiptId}/export`,
    post({}),
  )
  await fileOf(mine, 'pdf')

  const before = await jobCount()
  const theirs = await parent.fetch(
    `/api/schools/${schoolA}/fees/receipts/${strangerReceiptId}/export`,
    post({}),
  )
  assert.equal(theirs.status, 404, await theirs.clone().text())
  assert.equal((await json<ErrorBody>(theirs)).error.code, 'RESOURCE_NOT_FOUND')
  assert.equal(await jobCount(), before, 'a refused request leaves no job row')

  // A receipt that never existed answers exactly the same way.
  const invented = await parent.fetch(
    `/api/schools/${schoolA}/fees/receipts/${randomUUID()}/export`,
    post({}),
  )
  assert.equal(invented.status, 404)
  assert.equal(await jobCount(), before)
})

test('an admin may collect and read, and is refused both list files', async () => {
  const before = await jobCount()
  const dues = await admin.fetch(
    `/api/schools/${schoolA}/fees/dues/export`,
    post({ academicYearId: exportYear, show: 'all', format: 'xlsx' }),
  )
  assert.equal(dues.status, 403, await dues.clone().text())
  assert.equal((await json<ErrorBody>(dues)).error.code, 'ACCESS_DENIED')

  const register = await admin.fetch(
    `/api/schools/${schoolA}/fees/receipts/export`,
    post({ from: YEAR_START, to: today, format: 'xlsx' }),
  )
  assert.equal(register.status, 403)
  assert.equal(await jobCount(), before, 'a refused file request leaves no job row')

  // Printing a receipt is reading it, so the admin's fees.read is enough.
  const receipt = await admin.fetch(
    `/api/schools/${schoolA}/fees/receipts/${childReceiptId}/export`,
    post({}),
  )
  await fileOf(receipt, 'pdf')
})
