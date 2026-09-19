import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  signInWithMfa,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = `access-log-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const studentA = fixtureIds.studentA as string
const ownerUserId = fixtureIds.ownerAUser as string

let server: TestServer
let owner: Awaited<ReturnType<typeof signInWithMfa>>

interface LogRow {
  method: string
  route: string
  status: number
  code: string | null
  user_id: string | null
  school_id: string | null
  ip_hash: string | null
  duration_ms: number
  request_id: string
}

/**
 * The insert is fire and forget, so the assertion waits for it to land. The
 * table is append-only and this database is reused, so a row is found by the
 * id of the one request under test, never by its route alone.
 */
async function rowsForRequest(route: string, requestId: string): Promise<LogRow[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = await adminPool().query<LogRow>(
      'SELECT * FROM access_log WHERE route = $1 AND request_id = $2',
      [route, requestId],
    )
    if (found.rowCount && found.rowCount > 0) return found.rows
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return []
}

/** The id the API puts on every answer, and inside a refusal body as well. */
function requestIdOf(response: Response): string {
  const requestId = response.headers.get('x-request-id')
  assert.equal(typeof requestId, 'string')
  return requestId as string
}

before(async () => {
  await seedDatabaseFixtures()
  await adminPool().query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    ownerUserId,
    OWNER_EMAIL,
  ])
  server = await startTestServer()
  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
})

after(async () => {
  // The MFA enrolment this file made must not outlive it: another file signs
  // the same fixture identity in with a password alone.
  await adminPool().query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await adminPool().query(
    'UPDATE auth_user SET two_factor_enabled = false WHERE id = $1',
    [ownerUserId],
  )
  await server.close()
  await closeAdminPool()
})

test('a request leaves one row naming the route pattern and no URL', async () => {
  const response = await owner.fetch(
    `/api/schools/${schoolA}/students/${studentA}?ignored=secret`,
  )
  assert.equal(response.status, 200)
  const rows = await rowsForRequest(
    '/api/schools/:schoolId/students/:studentId',
    requestIdOf(response),
  )
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(row?.method, 'GET')
  assert.equal(row?.route, '/api/schools/:schoolId/students/:studentId')
  assert.equal(row?.status, 200)
  assert.equal(row?.code, null)
  assert.equal(row?.user_id, ownerUserId)
  assert.equal(row?.school_id, schoolA)
  // The address is present only as a keyed hash, never as an address.
  assert.match(row?.ip_hash ?? '', /^[0-9a-f]{32}$/)
  assert.equal(row?.ip_hash?.includes('127.0.0.1'), false)
  assert.equal(Number.isInteger(row?.duration_ms), true)
})

test('the health route writes nothing', async () => {
  const before = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM access_log',
  )
  const health = await server.fetch('/api/health')
  assert.equal(health.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 200))
  const after = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM access_log',
  )
  assert.equal(after.rows[0]?.count, before.rows[0]?.count)
})

test('a refusal records the code we sent', async () => {
  const refused = await server.fetch(`/api/schools/${schoolA}/students`)
  assert.equal(refused.status, 401)
  const requestId = requestIdOf(refused)
  const rows = await rowsForRequest('/api/schools/:schoolId/students', requestId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.code, 'AUTHENTICATION_REQUIRED')
  assert.equal(rows[0]?.status, 401)
  assert.equal(rows[0]?.user_id, null)
})
