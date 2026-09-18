import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import pg from 'pg'
import { fixtureIds } from '@erp/db/fixtures'
import {
  MIGRATOR_URL,
  clientFor,
  resetRateLimits,
  resetProviderRateLimits,
  throttleQuery,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from './harness.ts'
import { provisionPhoneIdentity } from '../src/identity/provision.ts'
import { hashPhone } from '../src/auth/phone-otp.ts'

/** A number nobody was ever given. */
const UNKNOWN_PHONE = '9000000001'
const TEACHER_PHONE = '+919000000002'
const OWNER_PHONE = '+919000000003'

let server: TestServer
let teacherUserId: string
let teacherEmail: string
const admin = new pg.Pool({ connectionString: MIGRATOR_URL })

interface ErrorBody {
  error: { code: string; requestId: string; retryAfterSeconds?: number }
}

function smsFor(server: TestServer, phone: string) {
  return server.delivery.outbox.filter(
    (message) => message.channel === 'sms' && message.to === phone,
  )
}

async function sendOtp(client: ReturnType<typeof clientFor>, phone: string) {
  return client.fetch('/api/auth/phone-number/send-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone }),
  })
}

async function verifyOtp(
  client: ReturnType<typeof clientFor>,
  phone: string,
  code: string,
) {
  return client.fetch('/api/auth/phone-number/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone, code }),
  })
}

/** The most recent code the sandbox "delivered" to a number. */
function latestCode(phone: string): string {
  const messages = smsFor(server, phone)
  const last = messages.at(-1)
  assert.ok(last, `no OTP was delivered to ${phone}`)
  return last.secret
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const teacher = await provisionPhoneIdentity(server.auth, {
    name: 'Phone Only Teacher',
    phone: TEACHER_PHONE,
  })
  teacherUserId = teacher.userId
  teacherEmail = teacher.email
  // An owner of school A can also log in by OTP; that login is single factor.
  await admin.query(
    'UPDATE auth_user SET phone_number = $2, phone_number_verified = true WHERE id = $1',
    [fixtureIds.ownerAUser, OWNER_PHONE],
  )
})

beforeEach(async () => {
  await resetRateLimits()
})

after(async () => {
  await admin.query('DELETE FROM auth_user WHERE id = $1', [teacherUserId])
  await server.close()
  await admin.end()
})

test('an unknown number gets the same answer and no message and no user', async () => {
  const before = await admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM auth_user',
  )
  const client = clientFor(server)
  const response = await sendOtp(client, UNKNOWN_PHONE)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'sent' })
  assert.equal(smsFor(server, `+91${UNKNOWN_PHONE}`).length, 0)

  // Verifying anyway must not create an identity either.
  const verified = await verifyOtp(client, UNKNOWN_PHONE, '000000')
  assert.ok(verified.status >= 400)
  const after = await admin.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM auth_user',
  )
  assert.equal(after.rows[0]?.n, before.rows[0]?.n)
})

test('a malformed number is answered the same way and sends nothing', async () => {
  const client = clientFor(server)
  for (const value of ['12345', '+1 415 555 0100', '19000000002', '']) {
    const response = await sendOtp(client, value)
    assert.equal(response.status, 200, value)
    assert.deepEqual(await response.json(), { status: 'sent' })
  }
  assert.equal(smsFor(server, '+1 415 555 0100').length, 0)
})

test('a phone-only teacher receives a code, verifies it and can use /api/me', async () => {
  const client = clientFor(server)
  const sent = await sendOtp(client, '9000000002')
  assert.equal(sent.status, 200)
  assert.deepEqual(await sent.json(), { status: 'sent' })
  const delivered = smsFor(server, TEACHER_PHONE).at(-1)
  assert.ok(delivered)
  assert.equal(delivered.purpose, 'otp')
  assert.match(delivered.secret, /^\d{6}$/)

  // The login screen sends the 10 digit form to both endpoints.
  const verified = await verifyOtp(client, '9000000002', delivered.secret)
  assert.equal(verified.status, 200, await verified.text())

  const me = await client.fetch('/api/me')
  assert.equal(me.status, 200)
  const body = (await me.json()) as {
    user: { id: string; email?: string; phone?: string }
    session: { assurance: string }
    memberships: unknown[]
  }
  assert.equal(body.user.id, teacherUserId)
  assert.equal(body.session.assurance, 'single_factor')
  // The generated identifier is never returned as an email address.
  assert.equal(body.user.email, undefined)
  assert.deepEqual(body.memberships, [])
})

test('the generated .invalid identifier cannot be used to log in or reset', async () => {
  assert.ok(teacherEmail.endsWith('@phone-only.invalid'))
  const client = clientFor(server)
  const signIn = await client.signIn(teacherEmail, 'Whatever-Pass!42')
  assert.ok(signIn.status >= 400, `expected refusal, got ${signIn.status}`)

  const before = server.delivery.outbox.filter(
    (message) => message.channel === 'email',
  ).length
  const forgot = await client.fetch('/api/auth/request-password-reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: teacherEmail, redirectTo: '/reset' }),
  })
  assert.ok(forgot.status < 500)
  const emails = server.delivery.outbox.filter(
    (message) => message.channel === 'email',
  )
  assert.equal(emails.length, before)
})

test('a resend inside the cooldown is refused with a wait time', async () => {
  const client = clientFor(server)
  assert.equal((await sendOtp(client, TEACHER_PHONE)).status, 200)
  const again = await sendOtp(client, TEACHER_PHONE)
  assert.equal(again.status, 429)
  const body = (await again.json()) as ErrorBody
  assert.equal(body.error.code, 'RATE_LIMITED')
  assert.ok(
    (body.error.retryAfterSeconds ?? 0) > 0 &&
      (body.error.retryAfterSeconds ?? 0) <= 60,
    JSON.stringify(body),
  )
  assert.ok(body.error.requestId.length > 0)
})

test('three wrong codes invalidate the code and a new send is needed', async () => {
  const client = clientFor(server)
  assert.equal((await sendOtp(client, TEACHER_PHONE)).status, 200)
  const code = latestCode(TEACHER_PHONE)
  const wrong = code === '000000' ? '111111' : '000000'

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await verifyOtp(client, TEACHER_PHONE, wrong)
    assert.ok(response.status >= 400, `attempt ${attempt}`)
  }
  // The correct code is dead now.
  const late = await verifyOtp(client, TEACHER_PHONE, code)
  assert.ok(late.status >= 400, await late.text())

  await resetRateLimits()
  assert.equal((await sendOtp(client, TEACHER_PHONE)).status, 200)
  const fresh = latestCode(TEACHER_PHONE)
  const ok = await verifyOtp(client, TEACHER_PHONE, fresh)
  assert.equal(ok.status, 200, await ok.text())
})

test('two identical verifications yield exactly one success', async () => {
  const client = clientFor(server)
  assert.equal((await sendOtp(client, TEACHER_PHONE)).status, 200)
  const code = latestCode(TEACHER_PHONE)

  const [first, second] = await Promise.all([
    verifyOtp(client, TEACHER_PHONE, code),
    verifyOtp(client, TEACHER_PHONE, code),
  ])
  const statuses = [first.status, second.status]
  assert.equal(
    statuses.filter((status) => status === 200).length,
    1,
    `expected one success, got ${statuses.join(', ')}`,
  )
})

test('an OTP login of a privileged member is refused school context until MFA', async () => {
  const client = clientFor(server)
  assert.equal((await sendOtp(client, OWNER_PHONE)).status, 200)
  const code = latestCode(OWNER_PHONE)
  assert.equal((await verifyOtp(client, OWNER_PHONE, code)).status, 200)

  const me = (await (await client.fetch('/api/me')).json()) as {
    user: { id: string }
    session: { assurance: string }
  }
  assert.equal(me.user.id, fixtureIds.ownerAUser)
  assert.equal(me.session.assurance, 'single_factor')

  const context = await client.fetch(
    `/api/schools/${fixtureIds.schoolA}/context`,
  )
  const contextBody = (await context.json()) as ErrorBody
  assert.equal(context.status, 403, JSON.stringify(contextBody))
  assert.equal(contextBody.error.code, 'MFA_REQUIRED')
})

test('a student identity is never sent a code', async () => {
  const studentPhone = '+919000000004'
  await admin.query(
    'UPDATE auth_user SET phone_number = $2, phone_number_verified = true WHERE id = $1',
    [fixtureIds.studentUser, studentPhone],
  )
  const client = clientFor(server)
  const response = await sendOtp(client, studentPhone)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'sent' })
  assert.equal(smsFor(server, studentPhone).length, 0)
  await admin.query(
    'UPDATE auth_user SET phone_number = NULL, phone_number_verified = false WHERE id = $1',
    [fixtureIds.studentUser],
  )
})

test('the daily send budget is durable and survives the provider pruning its own table', async () => {
  const client = clientFor(server)
  const delivered = smsFor(server, TEACHER_PHONE).length
  const day = new Date().toISOString().slice(0, 10)
  // Five sends already made to this number today.
  await throttleQuery(
    `INSERT INTO auth_throttle (key, count, last_request, expires_at)
     VALUES ($1, 5, 0, now() + interval '1 hour')
     ON CONFLICT (key) DO UPDATE SET count = 5, last_request = 0,
       expires_at = now() + interval '1 hour'`,
    [`otp-send:day:${day}:${hashPhone(TEACHER_PHONE)}`],
  )
  // Better Auth prunes its own rate-limit rows on every window rollover. That
  // must not hand the caller a fresh daily budget.
  await resetProviderRateLimits()

  const response = await sendOtp(client, TEACHER_PHONE)
  const text = await response.text()
  assert.equal(response.status, 429, text)
  const body = JSON.parse(text) as ErrorBody
  assert.equal(body.error.code, 'RATE_LIMITED')
  // The wait points at the next UTC day, not at the 60 second cooldown.
  assert.ok(
    (body.error.retryAfterSeconds ?? 0) > 60,
    JSON.stringify(body),
  )
  assert.equal(smsFor(server, TEACHER_PHONE).length, delivered)
  // A throttle row is durable, so it must not carry the number itself.
  const keys = await throttleQuery<{ key: string }>(
    'SELECT key FROM auth_throttle',
  )
  for (const row of keys.rows)
    assert.equal(row.key.includes(TEACHER_PHONE.slice(-10)), false, row.key)
})

test('the daily budget per client address stops sends to other numbers too', async () => {
  const client = clientFor(server)
  const day = new Date().toISOString().slice(0, 10)
  await throttleQuery(
    `INSERT INTO auth_throttle (key, count, last_request, expires_at)
     VALUES ($1, 20, 0, now() + interval '1 hour')
     ON CONFLICT (key) DO UPDATE SET count = 20, last_request = 0,
       expires_at = now() + interval '1 hour'`,
    [`otp-send:day:${day}:ip:127.0.0.1`],
  )
  const response = await sendOtp(client, OWNER_PHONE)
  const text = await response.text()
  assert.equal(response.status, 429, text)
  assert.equal((JSON.parse(text) as ErrorBody).error.code, 'RATE_LIMITED')
})
