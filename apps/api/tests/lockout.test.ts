import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { fixtureIds } from '@erp/db/fixtures'
import {
  MIGRATOR_URL,
  clientFor,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  startTestServer,
  type TestServer,
} from './harness.ts'
import { provisionPhoneIdentity } from '../src/identity/provision.ts'
import { MAX_FAILED_SIGN_INS } from '../src/auth/lockout.ts'

const PASSWORD = 'Lockout-Pass!42'
const WRONG_PASSWORD = 'Lockout-Wrong!42'
const EMAIL = 'lockout-adult@example.test'
const PHONE = '+919000000021'

let server: TestServer
let phoneUserId: string
const admin = new pg.Pool({ connectionString: MIGRATOR_URL })

const userId = fixtureIds.adultUser as string

/** The same body twice, apart from the per-request identifier. */
function withoutRequestId(body: string): unknown {
  const parsed = JSON.parse(body) as { error?: Record<string, unknown> }
  if (parsed.error) delete parsed.error.requestId
  return parsed
}

async function signIn(password: string) {
  const client = clientFor(server)
  const response = await client.signIn(EMAIL, password)
  return { client, response, body: await response.text() }
}

async function counters() {
  const { rows } = await admin.query<{
    failed: number
    locked: string | null
  }>(
    'SELECT failed_sign_ins AS failed, locked_until AS locked FROM auth_user WHERE id = $1',
    [userId],
  )
  return rows[0]
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  await admin.query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    userId,
    EMAIL,
  ])
  await setFixturePassword(server, userId, PASSWORD)
  const phoneIdentity = await provisionPhoneIdentity(server.auth, {
    name: 'Lockout Phone Teacher',
    phone: PHONE,
  })
  phoneUserId = phoneIdentity.userId
})

after(async () => {
  await admin.query('DELETE FROM auth_user WHERE id = $1', [phoneUserId])
  await server.close()
  await admin.end()
})

test('ten wrong passwords lock the identity and the right one is refused identically', async () => {
  let wrongStatus = 0
  let wrongBody = ''
  for (let attempt = 0; attempt < MAX_FAILED_SIGN_INS; attempt += 1) {
    const { response, body } = await signIn(WRONG_PASSWORD)
    assert.equal(response.status, 401, body)
    wrongStatus = response.status
    wrongBody = body
  }

  const state = await counters()
  assert.ok((state?.failed ?? 0) >= MAX_FAILED_SIGN_INS)
  assert.ok(state?.locked, 'the identity should be locked')

  // The eleventh attempt has the right password: a caller must not be able to
  // tell a lock from a wrong password.
  const locked = await signIn(PASSWORD)
  assert.equal(locked.response.status, wrongStatus)
  assert.deepEqual(withoutRequestId(locked.body), withoutRequestId(wrongBody))
})

test('an expired lock lets the right password in and clears the counter', async () => {
  await admin.query(
    "UPDATE auth_user SET locked_until = now() - interval '1 minute' WHERE id = $1",
    [userId],
  )
  const { response, body } = await signIn(PASSWORD)
  assert.equal(response.status, 200, body)

  const state = await counters()
  assert.equal(state?.failed, 0)
  assert.equal(state?.locked, null)
})

test('the first wrong password after a lock expires does not re-lock', async () => {
  // Ten failures are still on the record and the lock has run out. That lock
  // is spent, so this attempt is the first of a fresh count, not the eleventh.
  await admin.query(
    `UPDATE auth_user SET failed_sign_ins = $2,
            locked_until = now() - interval '1 minute' WHERE id = $1`,
    [userId, MAX_FAILED_SIGN_INS],
  )
  await resetRateLimits()
  const { response } = await signIn(WRONG_PASSWORD)
  assert.equal(response.status, 401)

  const state = await counters()
  assert.equal(state?.failed, 1)
  assert.equal(state?.locked, null)

  // Leave the identity usable for the tests that follow.
  await admin.query(
    'UPDATE auth_user SET failed_sign_ins = 0, locked_until = NULL WHERE id = $1',
    [userId],
  )
})

test('a disabled identity loses its live session on the next request', async () => {
  const { client, response } = await signIn(PASSWORD)
  assert.equal(response.status, 200)
  assert.equal((await client.fetch('/api/me')).status, 200)

  await admin.query('UPDATE auth_user SET disabled_at = now() WHERE id = $1', [
    userId,
  ])
  const refused = await client.fetch('/api/me')
  assert.equal(refused.status, 401)
  assert.equal(
    ((await refused.json()) as { error: { code: string } }).error.code,
    'AUTHENTICATION_REQUIRED',
  )
  const { rows } = await admin.query<{ total: string }>(
    'SELECT count(*)::text AS total FROM auth_session WHERE user_id = $1',
    [userId],
  )
  assert.equal(rows[0]?.total, '0')

  // A disabled identity is answered exactly like a wrong password.
  const signedIn = await signIn(PASSWORD)
  assert.equal(signedIn.response.status, 401)

  await admin.query('UPDATE auth_user SET disabled_at = NULL WHERE id = $1', [
    userId,
  ])
})

test('a locked identity verifying a phone code is refused like a wrong code', async () => {
  await resetRateLimits()
  const client = clientFor(server)
  const send = await client.fetch('/api/auth/phone-number/send-otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PHONE }),
  })
  assert.equal(send.status, 200)
  const code = server.delivery.outbox
    .filter((message) => message.channel === 'sms' && message.to === PHONE)
    .at(-1)?.secret
  assert.ok(code)

  const verify = async (value: string) =>
    client.fetch('/api/auth/phone-number/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phoneNumber: PHONE, code: value }),
    })

  const wrong = await verify('000000')
  const wrongBody = await wrong.text()
  assert.equal(wrong.status, 400, wrongBody)

  await admin.query(
    "UPDATE auth_user SET locked_until = now() + interval '15 minutes' WHERE id = $1",
    [phoneUserId],
  )
  const locked = await verify(code)
  assert.equal(locked.status, wrong.status)
  assert.deepEqual(withoutRequestId(await locked.text()), withoutRequestId(wrongBody))
})
