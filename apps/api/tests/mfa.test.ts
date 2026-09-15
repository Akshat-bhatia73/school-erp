import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import pg from 'pg'
import { fixtureIds } from '@erp/db/fixtures'
import {
  MIGRATOR_URL,
  clientFor,
  resetRateLimits,
  resetProviderRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = 'mfa-owner-a@example.test'

let server: TestServer
const admin = new pg.Pool({ connectionString: MIGRATOR_URL })
const ownerUserId = fixtureIds.ownerAUser as string
const schoolA = fixtureIds.schoolA as string

interface ErrorBody {
  error: { code: string; requestId: string }
}

/**
 * The provider's own TOTP generator, given the secret it published in the
 * otpauth URI. Tests never re-implement the algorithm.
 */
function secretFromUri(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get('secret')
  assert.ok(secret, 'the enrolment response must contain a TOTP secret')
  return base32Decode(secret)
}

function base32Decode(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const char of input.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out += String.fromCharCode((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return out
}

async function totpCode(secret: string): Promise<string> {
  const result = await server.auth.api.generateTOTP({ body: { secret } })
  return result.code
}

type Client = ReturnType<typeof clientFor>

/** The two-factor routes are rate limited by the provider; keep tests honest. */
async function postTwoFactor(
  client: Client,
  route: string,
  body: Record<string, unknown>,
) {
  await resetRateLimits()
  return client.fetch(`/api/auth/two-factor/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function resetTwoFactorState(): Promise<void> {
  await admin.query('DELETE FROM auth_two_factor WHERE user_id = $1', [
    ownerUserId,
  ])
  await admin.query(
    'UPDATE auth_user SET two_factor_enabled = false WHERE id = $1',
    [ownerUserId],
  )
  await admin.query('DELETE FROM auth_session WHERE user_id = $1', [
    ownerUserId,
  ])
}

/** Sign in with the password and enrol a fresh authenticator. */
async function enrol(): Promise<{
  client: Client
  secret: string
  backupCodes: string[]
}> {
  const client = clientFor(server)
  const signIn = await client.signIn(OWNER_EMAIL, PASSWORD)
  assert.equal(signIn.status, 200)
  const enable = await postTwoFactor(client, 'enable', { password: PASSWORD })
  assert.equal(enable.status, 200)
  const body = (await enable.json()) as {
    totpURI: string
    backupCodes: string[]
  }
  const secret = secretFromUri(body.totpURI)
  const verify = await postTwoFactor(client, 'verify-totp', {
    code: await totpCode(secret),
  })
  assert.equal(verify.status, 200)
  return { client, secret, backupCodes: body.backupCodes }
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  await admin.query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    ownerUserId,
    OWNER_EMAIL,
  ])
  await setFixturePassword(server, ownerUserId, PASSWORD)
})

beforeEach(async () => {
  await resetTwoFactorState()
  await resetRateLimits()
})

after(async () => {
  await resetTwoFactorState()
  await server.close()
  await admin.end()
})

test('enrolment returns a TOTP URI and backup codes, and verifying stamps the session', async () => {
  const client = clientFor(server)
  assert.equal((await client.signIn(OWNER_EMAIL, PASSWORD)).status, 200)

  // A password-only session is single factor and cannot enter the school.
  const before = await client.fetch('/api/me')
  assert.equal(before.status, 200)
  const beforeBody = (await before.json()) as {
    session: { assurance: string; mfaVerifiedAt: string | null }
  }
  assert.equal(beforeBody.session.assurance, 'single_factor')
  assert.equal(beforeBody.session.mfaVerifiedAt, null)
  const denied = await client.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(denied.status, 403)
  assert.equal(((await denied.json()) as ErrorBody).error.code, 'MFA_REQUIRED')

  const enable = await postTwoFactor(client, 'enable', { password: PASSWORD })
  assert.equal(enable.status, 200)
  const body = (await enable.json()) as {
    totpURI: string
    backupCodes: string[]
  }
  assert.match(body.totpURI, /^otpauth:\/\/totp\//)
  assert.match(body.totpURI, /issuer=School\+ERP/)
  assert.ok(body.backupCodes.length >= 8)

  // Enrolment alone is not proof: the code has to be accepted first.
  const secret = secretFromUri(body.totpURI)
  const verify = await postTwoFactor(client, 'verify-totp', {
    code: await totpCode(secret),
  })
  assert.equal(verify.status, 200)

  const me = await client.fetch('/api/me')
  const meBody = (await me.json()) as {
    session: { assurance: string; mfaVerifiedAt: string | null }
  }
  assert.equal(meBody.session.assurance, 'mfa')
  assert.ok(meBody.session.mfaVerifiedAt)
  const allowed = await client.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(allowed.status, 200)
})

test('the enabled flag alone is not enough: an unstamped session is refused', async () => {
  const { client } = await enrol()
  assert.equal((await client.fetch(`/api/schools/${schoolA}/context`)).status, 200)

  // Same identity, two-factor enabled, but this session never completed it.
  await admin.query(
    'UPDATE auth_session SET mfa_verified_at = NULL WHERE user_id = $1',
    [ownerUserId],
  )
  const denied = await client.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(denied.status, 403)
  assert.equal(((await denied.json()) as ErrorBody).error.code, 'MFA_REQUIRED')
  const me = (await (await client.fetch('/api/me')).json()) as {
    session: { assurance: string }
  }
  assert.equal(me.session.assurance, 'single_factor')
})

test('a challenged sign-in holds no session until the code is verified', async () => {
  const { secret } = await enrol()

  const client = clientFor(server)
  const signIn = await client.signIn(OWNER_EMAIL, PASSWORD)
  assert.equal(signIn.status, 200)
  const challenge = (await signIn.json()) as { twoFactorRedirect?: boolean }
  assert.equal(challenge.twoFactorRedirect, true)
  assert.equal((await client.fetch('/api/me')).status, 401)

  // A wrong code neither signs anyone in nor stamps anything.
  const wrong = await postTwoFactor(client, 'verify-totp', { code: '000000' })
  assert.ok(wrong.status >= 400)
  assert.equal((await client.fetch('/api/me')).status, 401)

  const verify = await postTwoFactor(client, 'verify-totp', {
    code: await totpCode(secret),
  })
  assert.equal(verify.status, 200)
  const me = await client.fetch('/api/me')
  assert.equal(me.status, 200)
  const body = (await me.json()) as { session: { assurance: string } }
  assert.equal(body.session.assurance, 'mfa')
})

test('a backup code signs in once and only once', async () => {
  const { backupCodes } = await enrol()
  const code = backupCodes[0] as string

  const client = clientFor(server)
  assert.equal((await client.signIn(OWNER_EMAIL, PASSWORD)).status, 200)
  const used = await postTwoFactor(client, 'verify-backup-code', { code })
  assert.equal(used.status, 200)
  const me = (await (await client.fetch('/api/me')).json()) as {
    session: { assurance: string }
  }
  assert.equal(me.session.assurance, 'mfa')

  const second = clientFor(server)
  assert.equal((await second.signIn(OWNER_EMAIL, PASSWORD)).status, 200)
  const replay = await postTwoFactor(second, 'verify-backup-code', { code })
  assert.ok(replay.status >= 400)
  assert.equal((await second.fetch('/api/me')).status, 401)
})

test('a phone OTP session can be stepped up on the same session', async () => {
  const { client, secret } = await enrol()
  // Simulate a single-factor login on an already enrolled identity.
  await admin.query(
    'UPDATE auth_session SET mfa_verified_at = NULL WHERE user_id = $1',
    [ownerUserId],
  )
  const sessionsBefore = await admin.query(
    'SELECT id FROM auth_session WHERE user_id = $1',
    [ownerUserId],
  )

  const stepUp = await postTwoFactor(client, 'verify-totp', {
    code: await totpCode(secret),
  })
  assert.equal(stepUp.status, 200)

  const sessionsAfter = await admin.query(
    'SELECT id, mfa_verified_at FROM auth_session WHERE user_id = $1',
    [ownerUserId],
  )
  // The same session was upgraded rather than replaced.
  assert.equal(sessionsAfter.rowCount, sessionsBefore.rowCount)
  assert.equal(sessionsAfter.rows[0].id, sessionsBefore.rows[0].id)
  assert.ok(sessionsAfter.rows[0].mfa_verified_at)
  assert.equal((await client.fetch(`/api/schools/${schoolA}/context`)).status, 200)
})

test('trusting the device is refused, so the next sign-in is challenged again', async () => {
  const { secret } = await enrol()

  const client = clientFor(server)
  await client.signIn(OWNER_EMAIL, PASSWORD)
  const verify = await postTwoFactor(client, 'verify-totp', {
    code: await totpCode(secret),
    trustDevice: true,
  })
  assert.equal(verify.status, 200)
  assert.ok(
    !client.jar.rawSetCookies.some((line) => line.includes('trust_device')),
    'no trust-device cookie may be issued',
  )

  // The same browser signs in again and is challenged a second time.
  const again = await client.signIn(OWNER_EMAIL, PASSWORD)
  const body = (await again.json()) as { twoFactorRedirect?: boolean }
  assert.equal(body.twoFactorRedirect, true)
  assert.equal((await client.fetch('/api/me')).status, 401)
})

test('turning two-factor off needs the password and recent verification', async () => {
  const { client, secret } = await enrol()

  await admin.query(
    `UPDATE auth_session
        SET mfa_verified_at = now() - interval '10 minutes'
      WHERE user_id = $1`,
    [ownerUserId],
  )
  const stale = await postTwoFactor(client, 'disable', { password: PASSWORD })
  assert.equal(stale.status, 403)
  assert.equal(
    ((await stale.json()) as ErrorBody).error.code,
    'FRESH_AUTHENTICATION_REQUIRED',
  )

  // Prove the second factor again, then the change is allowed.
  const stepUp = await postTwoFactor(client, 'verify-totp', {
    code: await totpCode(secret),
  })
  assert.equal(stepUp.status, 200)
  const wrongPassword = await postTwoFactor(client, 'disable', {
    password: 'not-the-password',
  })
  assert.ok(wrongPassword.status >= 400)
  const disabled = await postTwoFactor(client, 'disable', {
    password: PASSWORD,
  })
  assert.equal(disabled.status, 200)

  const rows = await admin.query(
    'SELECT two_factor_enabled FROM auth_user WHERE id = $1',
    [ownerUserId],
  )
  assert.equal(rows.rows[0].two_factor_enabled, false)
})

test('second-factor provider routes that are not configured stay closed', async () => {
  for (const route of ['send-otp', 'verify-otp', 'view-backup-codes']) {
    const response = await server.fetch(`/api/auth/two-factor/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 404)
    assert.equal(
      ((await response.json()) as ErrorBody).error.code,
      'RESOURCE_NOT_FOUND',
    )
  }
})

test('guessing the second factor on an existing session is stopped', async () => {
  const { client, secret } = await enrol()
  // A single factor session on an enrolled identity: a stolen cookie, or a
  // phone OTP login, which the provider never challenges.
  await admin.query(
    'UPDATE auth_session SET mfa_verified_at = NULL WHERE user_id = $1',
    [ownerUserId],
  )

  const guess = async (code: string) => {
    // Clear only the provider's own per-IP window, so what is measured here
    // is our own per-session attempt budget.
    await resetProviderRateLimits()
    return client.fetch('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await guess('000000')
    assert.ok(response.status >= 400, `attempt ${attempt}`)
  }

  const blocked = await guess('000000')
  assert.equal(blocked.status, 429)
  const body = (await blocked.json()) as ErrorBody
  assert.equal(body.error.code, 'RATE_LIMITED')

  // Even the correct code is refused while the session is locked out, and the
  // session is still single factor.
  const correct = await guess(await totpCode(secret))
  assert.equal(correct.status, 429)
  const me = (await (await client.fetch('/api/me')).json()) as {
    session: { assurance: string }
  }
  assert.equal(me.session.assurance, 'single_factor')
})

test('a decoy cookie cannot open a fresh attempt budget', async () => {
  const { client } = await enrol()
  await admin.query(
    'UPDATE auth_session SET mfa_verified_at = NULL WHERE user_id = $1',
    [ownerUserId],
  )
  const realCookie = client.jar.header()
  assert.ok(realCookie)

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await resetProviderRateLimits()
    const response = await client.fetch('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    })
    assert.ok(response.status >= 400, `attempt ${attempt}`)
  }

  // The budget belongs to the person, not to the cookie header: prefixing a
  // made-up session cookie must not reset it.
  await resetProviderRateLimits()
  const decoy = await client.fetch('/api/auth/two-factor/verify-totp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `decoy.session_token=junk-${Math.random()}; ${realCookie}`,
    },
    body: JSON.stringify({ code: '000000' }),
  })
  assert.equal(decoy.status, 429)
  assert.equal(((await decoy.json()) as ErrorBody).error.code, 'RATE_LIMITED')
})

test('a successful step-up clears the attempt budget', async () => {
  const { client, secret } = await enrol()
  await admin.query(
    'UPDATE auth_session SET mfa_verified_at = NULL WHERE user_id = $1',
    [ownerUserId],
  )
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await resetProviderRateLimits()
    const wrong = await client.fetch('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    })
    assert.ok(wrong.status >= 400)
  }
  const ok = await postTwoFactor(client, 'verify-totp', {
    code: await totpCode(secret),
  })
  assert.equal(ok.status, 200)
  // The budget is back: three more wrong codes do not lock the session out.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await resetProviderRateLimits()
    const wrong = await client.fetch('/api/auth/two-factor/verify-totp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000' }),
    })
    assert.notEqual(wrong.status, 429)
  }
})
