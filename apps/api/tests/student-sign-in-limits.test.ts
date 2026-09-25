/**
 * Sign-in limits for a class that shares one address.
 *
 * Every request in this suite comes from 127.0.0.1, which is exactly the
 * computer lab case: forty pupils behind one public address. The provider's
 * own rule (3 per 10 seconds per address and path) must not turn them away at
 * sign-in or at the first password change, while the staff email door keeps
 * that rule, one pupil account still has a small budget of its own, and one
 * person guessing a current password is stopped after five failures.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { ROLE_TEMPLATES } from '@erp/contracts'
import {
  CHANGE_PASSWORD_ATTEMPT_LIMIT,
  CHANGE_PASSWORD_ATTEMPT_WINDOW_SECONDS,
  changePasswordAttemptKey,
} from '../src/app.ts'
import {
  STUDENT_EMAIL_SUFFIX,
  STUDENT_SIGN_IN_ACCOUNT_LIMIT,
  STUDENT_SIGN_IN_ADDRESS_LIMIT,
  studentAddressBucketKey,
} from '../src/auth/student-sign-in.ts'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  startTestServer,
  throttleQuery,
  type TestServer,
} from './harness.ts'

const TEXTED = 'k7m3-p9xq-4tad'
const OWN = 'My-Own-Pass!2026'
const STAFF_PASSWORD = 'Fixture-Pass!42'
const LAB_SIZE = 40
const suffix = randomUUID().slice(0, 8)
const SCHOOL_CODE = `lim-${suffix}`
const school = randomUUID()

let server: TestServer
type Client = ReturnType<typeof clientFor>

interface Pupil {
  userId: string
  email: string
  admissionNumber: string
}
const pupils: Pupil[] = []

interface ErrorBody {
  error: { code: string; retryAfterSeconds?: number }
}

function json(value: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }
}

/** A pupil with a login straight into the tables, holding the texted password. */
async function makePupil(): Promise<Pupil> {
  const pool = adminPool()
  const studentId = randomUUID()
  const userId = randomUUID()
  const membershipId = randomUUID()
  const admissionNumber = `LIM/${suffix}/${randomUUID().slice(0, 6).toUpperCase()}`
  const email = `${randomUUID()}${STUDENT_EMAIL_SUFFIX}`
  await pool.query(
    `INSERT INTO students(id,school_id,admission_number,first_name,last_name,status) VALUES ($1,$2,$3,'Lab','Pupil','active')`,
    [studentId, school, admissionNumber],
  )
  await pool.query('INSERT INTO auth_user(id,name,email,must_change_password) VALUES ($1,$2,$3,true)', [
    userId,
    'Lab Pupil',
    email,
  ])
  await pool.query(`INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'student','active')`, [
    membershipId,
    school,
    userId,
  ])
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id) SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'student'`,
    [school, membershipId],
  )
  await pool.query('INSERT INTO membership_student_links(school_id,membership_id,student_id) VALUES ($1,$2,$3)', [
    school,
    membershipId,
    studentId,
  ])
  await setFixturePassword(server, userId, TEXTED)
  return { userId, email, admissionNumber }
}

async function pupilSignIn(
  admissionNumber: string,
  password: string,
  client: Client = clientFor(server),
): Promise<{ client: Client; response: Response; text: string }> {
  const response = await client.fetch('/api/student-sign-in', json({ schoolCode: SCHOOL_CODE, admissionNumber, password }))
  return { client, response, text: await response.text() }
}

function assertRateLimited(response: Response, text: string): void {
  assert.equal(response.status, 429, text)
  const body = JSON.parse(text) as ErrorBody
  assert.equal(body.error.code, 'RATE_LIMITED')
  const header = Number(response.headers.get('retry-after'))
  assert.ok(Number.isInteger(header) && header > 0, `retry-after was ${response.headers.get('retry-after')}`)
  assert.equal(body.error.retryAfterSeconds, header)
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query(`INSERT INTO schools(id,login_code,name,short_name) VALUES ($1,$2,$3,'LIM')`, [
    school,
    SCHOOL_CODE,
    `Sign-in Limits School ${suffix}`,
  ])
  for (const [key, template] of Object.entries(ROLE_TEMPLATES)) {
    const role = await pool.query<{ id: string }>(
      `INSERT INTO roles(school_id,key,name,is_system) VALUES ($1,$2,$3,true) RETURNING id`,
      [school, key, template.displayName],
    )
    for (const grant of template.grants)
      await pool.query(
        `INSERT INTO role_permissions(school_id,role_id,permission,scope) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [school, role.rows[0]?.id, grant.permission, grant.scope],
      )
  }
  server = await startTestServer()
  for (let index = 0; index < LAB_SIZE; index += 1) pupils.push(await makePupil())
})

after(async () => {
  await server.close()
  await closeAdminPool()
})

const labClients: Client[] = []

test(`${LAB_SIZE} pupils sign in from one address at the same moment and every one gets in`, async () => {
  await resetRateLimits()
  const results = await Promise.all(pupils.map((pupil) => pupilSignIn(pupil.admissionNumber, TEXTED)))
  for (const { response, text } of results) {
    assert.equal(response.status, 200, text)
    assert.deepEqual(JSON.parse(text), { signedIn: true, passwordChangeRequired: true })
  }
  labClients.push(...results.map((result) => result.client))
  // The provider counted none of them: the call from the pupil route is let
  // past its per-address rule, which proves the scope reaches that rule.
  const provider = await throttleQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM auth_rate_limit WHERE key LIKE '%sign-in/email%'`,
  )
  assert.equal(provider.rows[0]?.n, 0)
})

test(`the whole lab changes its texted password from one address in a row`, async () => {
  assert.equal(labClients.length, LAB_SIZE)
  for (const client of labClients) {
    const response = await client.fetch('/api/auth/change-password', json({ currentPassword: TEXTED, newPassword: OWN }))
    assert.equal(response.status, 200, await response.text())
  }
  const pending = await adminPool().query<{ n: number }>(
    'SELECT count(*)::int AS n FROM auth_user WHERE id = ANY($1::uuid[]) AND must_change_password',
    [pupils.map((pupil) => pupil.userId)],
  )
  assert.equal(pending.rows[0]?.n, 0)
})

test('one pupil knocking on their own account is stopped after five attempts; a classmate still gets in', async () => {
  await resetRateLimits()
  const [target, classmate] = pupils
  assert.ok(target && classmate)
  for (let attempt = 0; attempt < STUDENT_SIGN_IN_ACCOUNT_LIMIT; attempt += 1) {
    const { response, text } = await pupilSignIn(target.admissionNumber, `wrong-${attempt}`)
    assert.equal(response.status, 401, text)
  }
  // The right password is refused too until the minute is up, and the case
  // or spacing of what is typed does not open a fresh budget.
  const blocked = await pupilSignIn(target.admissionNumber, OWN)
  assertRateLimited(blocked.response, blocked.text)
  const retyped = await pupilSignIn(` ${target.admissionNumber.toLowerCase()} `, OWN)
  assertRateLimited(retyped.response, retyped.text)

  const other = await pupilSignIn(classmate.admissionNumber, OWN)
  assert.equal(other.response.status, 200, other.text)
})

test('an admission number nobody holds spends the same budget, so the limit is no oracle', async () => {
  await resetRateLimits()
  const unknown = `LIM/${suffix}/NOBODY`
  for (let attempt = 0; attempt < STUDENT_SIGN_IN_ACCOUNT_LIMIT; attempt += 1) {
    const { response, text } = await pupilSignIn(unknown, OWN)
    assert.equal(response.status, 401, text)
  }
  const blocked = await pupilSignIn(unknown, OWN)
  assertRateLimited(blocked.response, blocked.text)
  // No budget key carries a school code or an admission number.
  const keys = await throttleQuery<{ key: string }>('SELECT key FROM auth_throttle')
  for (const { key } of keys.rows) {
    assert.ok(!key.toLowerCase().includes(SCHOOL_CODE.toLowerCase()), key)
    assert.ok(!key.toLowerCase().includes(suffix.toLowerCase()), key)
  }
})

test('an address past its own budget is refused before the provider is asked', async () => {
  await resetRateLimits()
  await throttleQuery(
    `INSERT INTO auth_throttle(key,count,last_request,expires_at) VALUES ($1,$2,0,now() + interval '60 seconds')`,
    [studentAddressBucketKey('127.0.0.1'), STUDENT_SIGN_IN_ADDRESS_LIMIT],
  )
  const pupil = pupils[2]
  assert.ok(pupil)
  const blocked = await pupilSignIn(pupil.admissionNumber, OWN)
  assertRateLimited(blocked.response, blocked.text)
  await resetRateLimits()
  assert.equal((await pupilSignIn(pupil.admissionNumber, OWN)).response.status, 200)
})

test('the staff email door is still limited by the provider after three tries in ten seconds', async () => {
  await resetRateLimits()
  const userId = randomUUID()
  const email = `lim-${randomUUID()}@example.test`
  await adminPool().query('INSERT INTO auth_user(id,name,email) VALUES ($1,$2,$3)', [userId, 'Staff member', email])
  await setFixturePassword(server, userId, STAFF_PASSWORD)
  const client = clientFor(server)
  const statuses: number[] = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await client.fetch('/api/auth/sign-in/email', json({ email, password: STAFF_PASSWORD }))
    statuses.push(response.status)
    if (response.status === 429)
      assert.equal(((await response.json()) as ErrorBody).error.code, 'RATE_LIMITED')
    else await response.text()
  }
  assert.deepEqual(statuses, [200, 200, 200, 429])
})

test("a pupil's generated address typed into the staff email door is still refused", async () => {
  await resetRateLimits()
  const pupil = pupils[3]
  assert.ok(pupil)
  const client = clientFor(server)
  const response = await client.fetch('/api/auth/sign-in/email', json({ email: pupil.email, password: OWN }))
  const text = await response.text()
  assert.equal(response.status, 401, text)
  assert.equal((JSON.parse(text) as ErrorBody).error.code, 'AUTHENTICATION_REQUIRED')
})

test('five failed password changes stop that person, even with the right password next', async () => {
  await resetRateLimits()
  const pupil = pupils[4]
  assert.ok(pupil)
  const { client, response } = await pupilSignIn(pupil.admissionNumber, OWN)
  assert.equal(response.status, 200)
  for (let attempt = 0; attempt < CHANGE_PASSWORD_ATTEMPT_LIMIT; attempt += 1) {
    const failed = await client.fetch(
      '/api/auth/change-password',
      json({ currentPassword: `wrong-${attempt}`, newPassword: 'Another-Pass!2026' }),
    )
    assert.ok(failed.status >= 400 && failed.status < 429, await failed.text())
  }
  const blocked = await client.fetch(
    '/api/auth/change-password',
    json({ currentPassword: OWN, newPassword: 'Another-Pass!2026' }),
  )
  const text = await blocked.text()
  assertRateLimited(blocked, text)
  assert.equal(Number(blocked.headers.get('retry-after')), CHANGE_PASSWORD_ATTEMPT_WINDOW_SECONDS)

  // A classmate on the same address is not affected.
  const classmate = pupils[5]
  assert.ok(classmate)
  const other = await pupilSignIn(classmate.admissionNumber, OWN)
  assert.equal(other.response.status, 200)
  const changed = await other.client.fetch(
    '/api/auth/change-password',
    json({ currentPassword: OWN, newPassword: 'Another-Pass!2026' }),
  )
  assert.equal(changed.status, 200, await changed.text())
})

test('a successful change clears the earlier failures', async () => {
  await resetRateLimits()
  const pupil = pupils[6]
  assert.ok(pupil)
  const { client, response } = await pupilSignIn(pupil.admissionNumber, OWN)
  assert.equal(response.status, 200)
  for (let attempt = 0; attempt < 2; attempt += 1)
    await (
      await client.fetch('/api/auth/change-password', json({ currentPassword: 'wrong', newPassword: 'Another-Pass!2026' }))
    ).text()
  const key = changePasswordAttemptKey(pupil.userId)
  assert.equal((await throttleQuery<{ count: number }>('SELECT count FROM auth_throttle WHERE key = $1', [key])).rows[0]?.count, 2)
  const changed = await client.fetch('/api/auth/change-password', json({ currentPassword: OWN, newPassword: 'Another-Pass!2026' }))
  assert.equal(changed.status, 200, await changed.text())
  assert.equal((await throttleQuery('SELECT 1 FROM auth_throttle WHERE key = $1', [key])).rowCount, 0)
})
