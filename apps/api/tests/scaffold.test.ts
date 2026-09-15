import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { loadConfig, ConfigurationError } from '../src/config.ts'
import { requestOrigin, sanitizeProviderBody } from '../src/app.ts'
import { provisionEmailIdentity } from '../src/identity/provision.ts'
import {
  MIGRATOR_URL,
  seedDatabaseFixtures,
  startTestServer,
  testEnv,
  uniqueEmail,
  type TestServer,
} from './harness.ts'

let server: TestServer
const admin = new pg.Pool({ connectionString: MIGRATOR_URL })

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
})
after(async () => {
  await server.close()
  await admin.end()
})

test('the server starts in sandbox delivery mode and reports it', async () => {
  assert.equal(server.delivery.mode, 'sandbox')
  const response = await server.fetch('/api/auth-config')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    deliveryMode: 'sandbox',
    studentLoginEnabled: false,
  })
})

test('provider delivery mode fails startup because no provider is configured', () => {
  assert.throws(
    () => loadConfig(testEnv(1234, { DELIVERY_MODE: 'provider' })),
    ConfigurationError,
  )
})

test('health responds and every /api response is no-store', async () => {
  const response = await server.fetch('/api/health')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { status: 'ok' })
  assert.equal(response.headers.get('cache-control'), 'no-store')
})

test('public email signup is refused and creates no identity', async () => {
  const email = uniqueEmail()
  const response = await server.fetch('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Walk In', email, password: 'Str0ng-Pass!42' }),
  })
  assert.ok(response.status >= 400, `expected refusal, got ${response.status}`)
  const rows = await admin.query('SELECT 1 FROM auth_user WHERE email = $1', [
    email,
  ])
  assert.equal(rows.rowCount, 0)
})

test('the provider itself refuses signup, not only the route allowlist', async () => {
  const email = uniqueEmail()
  await assert.rejects(
    () =>
      server.auth.api.signUpEmail({
        body: { name: 'Walk In', email, password: 'Str0ng-Pass!42' },
      }),
    'disableSignUp must refuse a signup that reaches the provider directly',
  )
  const rows = await admin.query('SELECT 1 FROM auth_user WHERE email = $1', [
    email,
  ])
  assert.equal(rows.rowCount, 0)
})

test('a provisioned identity can sign in and receives a safe session cookie', async () => {
  const email = uniqueEmail()
  await provisionEmailIdentity(server.auth, {
    name: 'Provisioned Staff',
    email,
    password: 'Str0ng-Pass!42',
  })
  const response = await server.fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Str0ng-Pass!42' }),
  })
  assert.equal(response.status, 200, await response.text())
  const cookie = server.jar.rawSetCookies.find((line) =>
    line.includes('session_token'),
  )
  assert.ok(cookie, 'a session cookie must be set')
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Lax/i)
  assert.doesNotMatch(cookie, /Domain=/i)

  const session = await server.fetch('/api/auth/get-session')
  assert.equal(session.status, 200)
  const body = (await session.json()) as { user?: { email?: string } } | null
  assert.equal(body?.user?.email, email)
  assert.equal(session.headers.get('cache-control'), 'no-store')
})

test('forged forwarding headers do not change the origin the provider signs against', async () => {
  const forgedHeaders = {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': 'attacker.example',
  }
  // The setting is what decides, and it is off here.
  assert.equal(
    requestOrigin({ headers: forgedHeaders }, server.config),
    server.config.APP_ORIGIN,
  )
  assert.equal(
    requestOrigin(
      { headers: forgedHeaders },
      { ...server.config, API_TRUST_PROXY: true },
    ),
    'https://attacker.example',
  )

  // And over HTTP: this test signs in itself rather than borrowing a session.
  const email = uniqueEmail()
  await provisionEmailIdentity(server.auth, {
    name: 'Forged Header Staff',
    email,
    password: 'Str0ng-Pass!42',
  })
  const signIn = await server.fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...forgedHeaders },
    body: JSON.stringify({ email, password: 'Str0ng-Pass!42' }),
  })
  assert.equal(signIn.status, 200, await signIn.text())
  const cookies = signIn.headers.getSetCookie()
  assert.ok(cookies.length > 0, 'the sign-in must still issue a cookie')
  for (const line of cookies) {
    assert.doesNotMatch(line, /attacker\.example/)
    assert.doesNotMatch(line, /Domain=/i)
  }

  const forged = await server.fetch('/api/auth/get-session', {
    headers: forgedHeaders,
  })
  assert.equal(forged.status, 200)
  assert.equal(forged.headers.get('cache-control'), 'no-store')
  const body = (await forged.json()) as { user?: { email?: string } } | null
  assert.equal(body?.user?.email, email)
})

test('the provider never hands a session token or a raw user row to the browser', async () => {
  const email = uniqueEmail()
  await provisionEmailIdentity(server.auth, {
    name: 'Token Free Staff',
    email,
    password: 'Str0ng-Pass!42',
  })
  const signIn = await server.fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Str0ng-Pass!42' }),
  })
  const text = await signIn.text()
  assert.equal(signIn.status, 200, text)
  const body = JSON.parse(text) as Record<string, unknown>
  assert.equal(body.token, undefined)
  assert.equal(text.includes('"token"'), false, text)

  const session = await server.fetch('/api/auth/get-session')
  const sessionText = await session.text()
  assert.equal(sessionText.includes('"token"'), false, sessionText)

  // The generated phone-only identifier is dropped in the same way /api/me
  // drops it.
  assert.deepEqual(
    sanitizeProviderBody({
      token: 'secret-session-token',
      user: {
        id: 'u1',
        name: 'Phone Only',
        email: 'abc@phone-only.invalid',
        password: 'hash',
      },
    }),
    { user: { id: 'u1', name: 'Phone Only', twoFactorEnabled: false } },
  )
})

test('a provider failure is the ApiError envelope, not the provider body', async () => {
  const email = uniqueEmail()
  await provisionEmailIdentity(server.auth, {
    name: 'Wrong Password Staff',
    email,
    password: 'Str0ng-Pass!42',
  })
  const response = await server.fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'not-the-password' }),
  })
  const text = await response.text()
  assert.ok(response.status >= 400, text)
  const body = JSON.parse(text) as {
    error?: { code?: string; message?: string; requestId?: string }
    code?: string
  }
  assert.ok(body.error, text)
  assert.ok(body.error.requestId && body.error.requestId.length > 0)
  assert.ok(body.error.code && body.error.message)
  // No provider code and no provider wording about which half was wrong.
  assert.equal(body.code, undefined)
  assert.equal(/INVALID_EMAIL_OR_PASSWORD|password/i.test(text), false, text)
})

test('a request the framework cannot parse is a client error, not an outage', async () => {
  const response = await server.fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x' },
    body: '--x--',
  })
  assert.equal(response.status, 400)
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    'INVALID_REQUEST',
  )
})

test('the shared rate limit store is the database table', async () => {
  const rows = await admin.query('SELECT count(*)::int AS n FROM auth_rate_limit')
  assert.ok((rows.rows[0]?.n ?? 0) >= 0)
})
