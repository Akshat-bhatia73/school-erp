import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
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

const PASSWORD = 'Fixture-Pass!42'
const PARENT_EMAIL = 'reset-parent-a2@example.test'
const UNKNOWN_EMAIL = 'nobody-here@example.test'
const PHONE = '+919000000044'

let server: TestServer
let phoneUserId: string
let phoneEmail: string
const admin = new pg.Pool({ connectionString: MIGRATOR_URL })
const parentUserId = fixtureIds.parentA2User as string

type Client = ReturnType<typeof clientFor>

async function forgetPassword(client: Client, email: string) {
  await resetRateLimits()
  return client.fetch('/api/auth/request-password-reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
}

async function resetPassword(client: Client, token: string, next: string) {
  await resetRateLimits()
  return client.fetch('/api/auth/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, newPassword: next }),
  })
}

/** The reset token the sandbox "delivered" to an address. */
function latestToken(email: string): string {
  const last = server.delivery.outbox
    .filter(
      (message) =>
        message.channel === 'email' &&
        message.purpose === 'password_reset' &&
        message.to === email,
    )
    .at(-1)
  assert.ok(last, `no reset email was produced for ${email}`)
  return last.secret
}

function emailCount(email: string): number {
  return server.delivery.outbox.filter((message) => message.to === email).length
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  await admin.query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    parentUserId,
    PARENT_EMAIL,
  ])
  await setFixturePassword(server, parentUserId, PASSWORD)
  const phoneOnly = await provisionPhoneIdentity(server.auth, {
    name: 'Phone Only Parent',
    phone: PHONE,
  })
  phoneUserId = phoneOnly.userId
  phoneEmail = phoneOnly.email
})

beforeEach(async () => {
  await resetRateLimits()
  await setFixturePassword(server, parentUserId, PASSWORD)
})

after(async () => {
  await admin.query('DELETE FROM auth_user WHERE id = $1', [phoneUserId])
  await server.close()
  await admin.end()
})

test('an unknown address gets the same answer and no email', async () => {
  const client = clientFor(server)
  const response = await forgetPassword(client, UNKNOWN_EMAIL)
  assert.equal(response.status, 200)
  assert.equal(emailCount(UNKNOWN_EMAIL), 0)
})

test('a phone-only identity never receives a reset email', async () => {
  const client = clientFor(server)
  const response = await forgetPassword(client, phoneEmail)
  // Same generic answer, but the generated identifier is nobody's mailbox.
  assert.equal(response.status, 200)
  assert.equal(emailCount(phoneEmail), 0)
})

test('a reset ends the other sessions and the token cannot be reused', async () => {
  const NEW_PASSWORD = 'Fixture-Pass!43'
  const signedIn = clientFor(server)
  assert.equal((await signedIn.signIn(PARENT_EMAIL, PASSWORD)).status, 200)
  assert.equal((await signedIn.fetch('/api/me')).status, 200)

  const client = clientFor(server)
  assert.equal((await forgetPassword(client, PARENT_EMAIL)).status, 200)
  const token = latestToken(PARENT_EMAIL)

  const reset = await resetPassword(client, token, NEW_PASSWORD)
  assert.equal(reset.status, 200)

  // The session held before the reset is dead on its next request.
  assert.equal((await signedIn.fetch('/api/me')).status, 401)

  // The old password is gone and the new one works.
  const stale = clientFor(server)
  assert.ok((await stale.signIn(PARENT_EMAIL, PASSWORD)).status >= 400)
  const fresh = clientFor(server)
  assert.equal((await fresh.signIn(PARENT_EMAIL, NEW_PASSWORD)).status, 200)

  // The token is single use.
  const replay = await resetPassword(client, token, 'Fixture-Pass!44')
  assert.ok(replay.status >= 400)
})

test('an expired reset token is refused', async () => {
  const client = clientFor(server)
  assert.equal((await forgetPassword(client, PARENT_EMAIL)).status, 200)
  const token = latestToken(PARENT_EMAIL)

  const rows = await admin.query(
    `SELECT expires_at FROM auth_verification WHERE identifier = $1`,
    [`reset-password:${token}`],
  )
  assert.equal(rows.rowCount, 1)
  const expiresAt = new Date(rows.rows[0].expires_at as string).getTime()
  // The token lives for fifteen minutes, not the provider default hour.
  assert.ok(expiresAt - Date.now() <= 15 * 60 * 1000 + 5000)

  await admin.query(
    `UPDATE auth_verification SET expires_at = now() - interval '1 minute'
      WHERE identifier = $1`,
    [`reset-password:${token}`],
  )
  const reset = await resetPassword(client, token, 'Fixture-Pass!45')
  assert.ok(reset.status >= 400)
})

test('changing the password needs the current one and ends other sessions', async () => {
  const NEW_PASSWORD = 'Fixture-Pass!46'
  const other = clientFor(server)
  assert.equal((await other.signIn(PARENT_EMAIL, PASSWORD)).status, 200)

  const client = clientFor(server)
  assert.equal((await client.signIn(PARENT_EMAIL, PASSWORD)).status, 200)

  await resetRateLimits()
  const wrong = await client.fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    }),
  })
  assert.ok(wrong.status >= 400)

  await resetRateLimits()
  const changed = await client.fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      // The caller asks to keep its other devices; the server overrides it.
      revokeOtherSessions: false,
    }),
  })
  assert.equal(changed.status, 200)

  assert.equal((await other.fetch('/api/me')).status, 401)
  assert.equal((await client.fetch('/api/me')).status, 200)
})
