import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import pg from 'pg'
import { fixtureIds } from '@erp/db/fixtures'
import {
  MIGRATOR_URL,
  clientFor,
  seedDatabaseFixtures,
  setFixturePassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
/**
 * The shared fixtures use `@test` addresses, which are not valid email
 * addresses for the provider or for the contract. Give each fixture identity a
 * deliverable-looking address here instead of changing the shared fixtures.
 */
const EMAILS = {
  ownerA: 'fixture-owner-a@example.test',
  adult: 'fixture-adult@example.test',
  suspended: 'fixture-suspended@example.test',
  parentA2: 'fixture-parent-a2@example.test',
  parentB: 'fixture-parent-b@example.test',
  student: 'fixture-student@example.test',
}

let server: TestServer
const admin = new pg.Pool({ connectionString: MIGRATOR_URL })

interface ErrorBody {
  error: { code: string; requestId: string; message: string }
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const identities: [string, string][] = [
    [fixtureIds.ownerAUser as string, EMAILS.ownerA],
    [fixtureIds.adultUser as string, EMAILS.adult],
    [fixtureIds.suspendedUser as string, EMAILS.suspended],
    [fixtureIds.parentA2User as string, EMAILS.parentA2],
    [fixtureIds.parentBUser as string, EMAILS.parentB],
    [fixtureIds.studentUser as string, EMAILS.student],
  ]
  for (const [userId, email] of identities) {
    await admin.query('UPDATE auth_user SET email = $2 WHERE id = $1', [
      userId,
      email,
    ])
    await setFixturePassword(server, userId, PASSWORD)
  }
})

after(async () => {
  await server.close()
  await admin.end()
})

test('/api/me returns the viewer, session and active memberships', async () => {
  const client = clientFor(server)
  assert.equal((await client.signIn(EMAILS.ownerA, PASSWORD)).status, 200)

  const response = await client.fetch('/api/me')
  const text = await response.text()
  assert.equal(response.status, 200, text)
  const body = JSON.parse(text) as {
    user: { id: string; displayName: string }
    session: { assurance: string; mfaVerifiedAt: string | null; expiresAt: string }
    memberships: { school: { code: string }; roleKeys: string[]; status: string }[]
  }
  assert.equal(body.user.id, fixtureIds.ownerAUser)
  assert.equal(body.session.assurance, 'single_factor')
  assert.equal(body.session.mfaVerifiedAt, null)
  assert.equal(body.memberships.length, 1)
  assert.equal(body.memberships[0]?.school.code, 'fixture-a')
  assert.deepEqual(body.memberships[0]?.roleKeys, ['owner'])
  assert.equal(body.memberships[0]?.status, 'active')
  // The absolute limit is 8 hours for a privileged member, not the 7 day
  // provider expiry.
  const expiresIn = Date.parse(body.session.expiresAt) - Date.now()
  assert.ok(expiresIn <= 8 * 3600 * 1000 + 1000, body.session.expiresAt)
})

test('a suspended membership is never listed', async () => {
  const client = clientFor(server)
  assert.equal((await client.signIn(EMAILS.suspended, PASSWORD)).status, 200)
  const body = (await (await client.fetch('/api/me')).json()) as {
    memberships: unknown[]
  }
  assert.deepEqual(body.memberships, [])
})

test('sign-out invalidates the server session', async () => {
  const client = clientFor(server)
  await client.signIn(EMAILS.adult, PASSWORD)
  assert.equal((await client.fetch('/api/me')).status, 200)

  const out = await client.fetch('/api/auth/sign-out', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(out.status, 200)

  const after = await client.fetch('/api/me')
  assert.equal(after.status, 401)
  assert.equal(
    ((await after.json()) as ErrorBody).error.code,
    'AUTHENTICATION_REQUIRED',
  )
})

test('revoking other sessions fails the first session on its next request', async () => {
  const first = clientFor(server)
  const second = clientFor(server)
  await first.signIn(EMAILS.parentA2, PASSWORD)
  await second.signIn(EMAILS.parentA2, PASSWORD)
  assert.equal((await first.fetch('/api/me')).status, 200)

  const revoked = await second.fetch('/api/auth/revoke-other-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(revoked.status, 200, await revoked.text())

  assert.equal((await first.fetch('/api/me')).status, 401)
  assert.equal((await second.fetch('/api/me')).status, 200)
})

test('the absolute session limit follows the memberships, not the cookie', async () => {
  const owner = clientFor(server)
  await owner.signIn(EMAILS.ownerA, PASSWORD)
  const parent = clientFor(server)
  await parent.signIn(EMAILS.parentB, PASSWORD)
  await backdateSessions(fixtureIds.ownerAUser as string, 9)
  await backdateSessions(fixtureIds.parentBUser as string, 9)

  const expired = await owner.fetch('/api/me')
  assert.equal(expired.status, 401)
  assert.equal(((await expired.json()) as ErrorBody).error.code, 'SESSION_EXPIRED')

  // A parent-only session may last 7 days with no idle limit.
  assert.equal((await parent.fetch('/api/me')).status, 200)
})

test('the idle limit ends a teacher session that was left alone', async () => {
  const client = clientFor(server)
  await client.signIn(EMAILS.adult, PASSWORD)
  assert.equal((await client.fetch('/api/me')).status, 200)
  // Two hours is inside the 12 hour absolute life but past the 60 minute idle
  // limit for a teacher.
  await backdateSessions(fixtureIds.adultUser as string, 2)
  const response = await client.fetch('/api/me')
  assert.equal(response.status, 401)
  assert.equal(
    ((await response.json()) as ErrorBody).error.code,
    'SESSION_EXPIRED',
  )
})

test('a student identity can neither sign in nor carry a session', async () => {
  const client = clientFor(server)
  const signIn = await client.signIn(EMAILS.student, PASSWORD)
  assert.ok(signIn.status >= 400, `expected refusal, got ${signIn.status}`)
  const rows = await admin.query(
    'SELECT 1 FROM auth_session WHERE user_id = $1',
    [fixtureIds.studentUser],
  )
  assert.equal(rows.rowCount, 0)

  // Even a session row planted directly in the database is refused and revoked.
  const hijack = clientFor(server)
  await hijack.signIn(EMAILS.parentA2, PASSWORD)
  await admin.query('UPDATE auth_session SET user_id = $1 WHERE user_id = $2', [
    fixtureIds.studentUser,
    fixtureIds.parentA2User,
  ])
  const denied = await hijack.fetch('/api/me')
  assert.equal(denied.status, 403)
  assert.equal(((await denied.json()) as ErrorBody).error.code, 'FEATURE_DISABLED')
  const left = await admin.query(
    'SELECT 1 FROM auth_session WHERE user_id = $1',
    [fixtureIds.studentUser],
  )
  assert.equal(left.rowCount, 0)
})

test('blocked provider endpoints are not published and change nothing', async () => {
  const before = await admin.query('SELECT count(*)::int AS n FROM auth_user')
  for (const path of [
    '/api/auth/sign-up/email',
    '/api/auth/update-user',
    '/api/auth/delete-user',
    '/api/auth/change-email',
    '/api/auth/sign-in/phone-number',
    '/api/auth/not-a-real-route',
  ]) {
    const response = await server.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'walkin@example.test', password: 'Str0ng-Pass!42' }),
    })
    assert.equal(response.status, 404, path)
    const body = (await response.json()) as ErrorBody
    assert.equal(body.error.code, 'RESOURCE_NOT_FOUND')
    assert.ok(body.error.requestId.length > 0)
  }
  const after = await admin.query('SELECT count(*)::int AS n FROM auth_user')
  assert.equal(after.rows[0]?.n, before.rows[0]?.n)
})

test('school context requires an active membership and the right assurance', async () => {
  const owner = clientFor(server)
  await owner.signIn(EMAILS.ownerA, PASSWORD)

  const foreign = await owner.fetch(
    `/api/schools/${fixtureIds.schoolB}/context`,
  )
  assert.equal(foreign.status, 403)
  assert.equal(
    ((await foreign.json()) as ErrorBody).error.code,
    'SCHOOL_ACCESS_UNAVAILABLE',
  )

  const ownSchool = await owner.fetch(
    `/api/schools/${fixtureIds.schoolA}/context`,
  )
  assert.equal(ownSchool.status, 403)
  assert.equal(
    ((await ownSchool.json()) as ErrorBody).error.code,
    'MFA_REQUIRED',
  )

  const parent = clientFor(server)
  await parent.signIn(EMAILS.parentB, PASSWORD)
  const allowed = await parent.fetch(
    `/api/schools/${fixtureIds.schoolB}/context`,
  )
  const allowedText = await allowed.text()
  assert.equal(allowed.status, 200, allowedText)
  const body = JSON.parse(allowedText) as {
    roleKeys: string[]
    capabilities: string[]
    studentLoginEnabled: boolean
    school: { code: string }
  }
  assert.deepEqual(body.roleKeys, ['parent'])
  assert.equal(body.school.code, 'fixture-b')
  assert.equal(body.studentLoginEnabled, false)
  // Capabilities are now the policy service's answer: every permission this
  // member could exercise somewhere in the school. This parent has an approved
  // child, so the child-scoped reads appear and nothing else does.
  assert.ok(body.capabilities.includes('students.read_basic'))
  assert.ok(body.capabilities.includes('timetable.read'))
  assert.ok(!body.capabilities.includes('students.read_sensitive'))
  assert.ok(!body.capabilities.includes('school.update'))
})

async function backdateSessions(userId: string, hours: number): Promise<void> {
  await admin.query(
    `UPDATE auth_session
        SET created_at = created_at - make_interval(hours => $2),
            updated_at = updated_at - make_interval(hours => $2)
      WHERE user_id = $1`,
    [userId, hours],
  )
}

/** The opaque id of the session this client currently holds. */
async function currentSessionId(
  client: ReturnType<typeof clientFor>,
): Promise<string> {
  const body = (await (await client.fetch('/api/sessions')).json()) as {
    sessions: { id: string; current: boolean }[]
  }
  const current = body.sessions.find((entry) => entry.current)
  assert.ok(current, 'the client must hold a session')
  return current.id
}

/** Only the creation time moves: the session stays freshly used. */
async function backdateCreatedOnly(
  userId: string,
  hours: number,
): Promise<void> {
  await admin.query(
    `UPDATE auth_session
        SET created_at = now() - make_interval(hours => $2),
            updated_at = now()
      WHERE user_id = $1`,
    [userId, hours],
  )
}

test('the absolute limit ends a still-active privileged session', async () => {
  const owner = clientFor(server)
  await owner.signIn(EMAILS.ownerA, PASSWORD)
  assert.equal((await owner.fetch('/api/me')).status, 200)
  // Used seconds ago, so the 30 minute idle limit is not what fires here.
  await backdateCreatedOnly(fixtureIds.ownerAUser as string, 9)
  const response = await owner.fetch('/api/me')
  assert.equal(response.status, 401)
  assert.equal(
    ((await response.json()) as ErrorBody).error.code,
    'SESSION_EXPIRED',
  )
})

test('the absolute limit ends a still-active teacher session after 12 hours', async () => {
  const client = clientFor(server)
  await client.signIn(EMAILS.adult, PASSWORD)
  assert.equal((await client.fetch('/api/me')).status, 200)
  await backdateCreatedOnly(fixtureIds.adultUser as string, 13)
  const response = await client.fetch('/api/me')
  assert.equal(response.status, 401)
  assert.equal(
    ((await response.json()) as ErrorBody).error.code,
    'SESSION_EXPIRED',
  )
})

test('/api/me reports the absolute limit, not a shorter or longer life', async () => {
  const client = clientFor(server)
  await client.signIn(EMAILS.ownerA, PASSWORD)
  const body = (await (await client.fetch('/api/me')).json()) as {
    session: { expiresAt: string }
  }
  const expiresIn = Date.parse(body.session.expiresAt) - Date.now()
  assert.ok(expiresIn > 7.5 * 3600 * 1000, body.session.expiresAt)
  assert.ok(expiresIn <= 8 * 3600 * 1000 + 1000, body.session.expiresAt)
})

test('an over-limit session is refused on the provider routes too', async () => {
  const owner = clientFor(server)
  await owner.signIn(EMAILS.ownerA, PASSWORD)
  assert.equal((await owner.fetch('/api/auth/get-session')).status, 200)
  const sessionId = await currentSessionId(owner)
  await backdateCreatedOnly(fixtureIds.ownerAUser as string, 9)

  const session = await owner.fetch('/api/auth/get-session')
  assert.equal(session.status, 401)
  assert.equal(
    ((await session.json()) as ErrorBody).error.code,
    'SESSION_EXPIRED',
  )
  // The stale row is gone, not merely refused.
  const rows = await admin.query('SELECT 1 FROM auth_session WHERE id = $1', [
    sessionId,
  ])
  assert.equal(rows.rowCount, 0)

  const revoke = await owner.fetch('/api/auth/revoke-other-sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  assert.equal(revoke.status, 401)
})

test('a stale cookie does not block a fresh sign-in', async () => {
  const owner = clientFor(server)
  await owner.signIn(EMAILS.ownerA, PASSWORD)
  const staleId = await currentSessionId(owner)
  await backdateCreatedOnly(fixtureIds.ownerAUser as string, 9)

  // The browser still carries the over-limit cookie. Signing in again must
  // succeed on the first try, and the stale row must be gone.
  const again = await owner.signIn(EMAILS.ownerA, PASSWORD)
  assert.equal(again.status, 200, await again.text())
  const rows = await admin.query('SELECT 1 FROM auth_session WHERE id = $1', [
    staleId,
  ])
  assert.equal(rows.rowCount, 0)
  assert.equal((await owner.fetch('/api/me')).status, 200)
})

test('a shared-device session gets the shorter limits', async () => {
  const shared = clientFor(server)
  const signIn = await shared.fetch('/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: EMAILS.adult,
      password: PASSWORD,
      sharedDevice: true,
    }),
  })
  assert.equal(signIn.status, 200, await signIn.text())
  assert.equal((await shared.fetch('/api/me')).status, 200)
  const sharedId = await currentSessionId(shared)
  const flagged = await admin.query<{ shared_device: boolean }>(
    'SELECT shared_device FROM auth_session WHERE id = $1',
    [sharedId],
  )
  assert.equal(flagged.rows[0]?.shared_device, true)

  // A personal teacher session is still valid three hours in; the shared one
  // is not, because its absolute life is two hours.
  const personal = clientFor(server)
  await personal.signIn(EMAILS.suspended, PASSWORD)
  await backdateCreatedOnly(fixtureIds.suspendedUser as string, 3)
  assert.equal((await personal.fetch('/api/me')).status, 200)

  await backdateCreatedOnly(fixtureIds.adultUser as string, 3)
  const expired = await shared.fetch('/api/me')
  assert.equal(expired.status, 401)
  assert.equal(
    ((await expired.json()) as ErrorBody).error.code,
    'SESSION_EXPIRED',
  )
})

test('sessions are listed and revoked by opaque id, never by token', async () => {
  const first = clientFor(server)
  const second = clientFor(server)
  await first.signIn(EMAILS.parentB, PASSWORD)
  await second.signIn(EMAILS.parentB, PASSWORD)

  const listed = await second.fetch('/api/sessions')
  assert.equal(listed.status, 200)
  const body = (await listed.json()) as {
    sessions: { id: string; current: boolean }[]
  }
  assert.ok(body.sessions.length >= 2)
  assert.equal(JSON.stringify(body).includes('token'), false)
  const other = body.sessions.find((entry) => !entry.current)
  assert.ok(other)

  const revoked = await second.fetch(`/api/sessions/${other.id}/revoke`, {
    method: 'POST',
  })
  assert.equal(revoked.status, 200, await revoked.text())
  assert.equal((await first.fetch('/api/me')).status, 401)
  assert.equal((await second.fetch('/api/me')).status, 200)

  // Another person's session id is simply not found.
  const outsider = clientFor(server)
  await outsider.signIn(EMAILS.parentA2, PASSWORD)
  const denied = await outsider.fetch(
    `/api/sessions/${body.sessions[0]?.id}/revoke`,
    { method: 'POST' },
  )
  assert.equal(denied.status, 404)
  assert.equal((await second.fetch('/api/me')).status, 200)

  // The provider routes that speak in raw tokens are not published.
  for (const path of ['/api/auth/list-sessions', '/api/auth/revoke-session']) {
    const response = await server.fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 404, path)
  }
})
