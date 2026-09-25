import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import Fastify, { type FastifyInstance } from 'fastify'
import { z } from 'zod'
import { fixtureIds } from '@erp/db/fixtures'
import { protectedRoute } from '../src/modules/shared/route.ts'
import type { ModuleDependencies } from '../src/modules/shared/route.ts'
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
// Unique per run: other test files rewrite the same fixture identities.
const OWNER_EMAIL = `modules-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `modules-parent-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let parent: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}

/**
 * Two test-only routes, registered on the test server before it listens. They
 * never exist in the running application: one proves the happy path, the other
 * deliberately returns a shape its contract forbids.
 */
function registerProbeRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/test-probe',
    permission: 'school.read',
    query: z.strictObject({ page: z.number().int().min(1).default(1) }),
    response: z.strictObject({ schoolId: z.string(), page: z.number().int() }),
    handler: async ({ context, query }) => ({ schoolId: context.schoolId, page: query.page }),
  })
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/test-leak',
    permission: 'school.read',
    response: z.strictObject({ safe: z.string() }),
    // A projection bug: the handler keeps a field the contract does not allow.
    handler: async () => ({ safe: 'fine', secret: 'must not be sent' }) as unknown as { safe: string },
  })
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer({}, registerProbeRoutes)
  await adminPool().query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    ownerUserId,
    OWNER_EMAIL,
  ])
  await adminPool().query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    parentUserId,
    PARENT_EMAIL,
  ])
  await setFixturePassword(server, parentUserId, PASSWORD)
  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [
    ownerUserId,
  ])
  await server.close()
  await closeAdminPool()
})

test('a route registered without a known permission is refused at startup', () => {
  const throwaway = Fastify({ logger: false })
  const deps = { authz: {}, pools: {}, auth: {}, delivery: {}, documents: {} } as unknown as ModuleDependencies
  assert.throws(() =>
    protectedRoute(throwaway, deps, {
      method: 'GET',
      path: '/api/schools/:schoolId/never',
      // A permission is not optional, and an unknown one is not a permission.
      permission: 'not.a.permission' as never,
      response: z.null(),
      handler: async () => null,
    }),
  )
  assert.throws(() =>
    protectedRoute(throwaway, deps, {
      method: 'GET',
      path: '/api/schools/:schoolId/reserved',
      // A reserved permission can never be decided, so it fails closed too.
      permission: 'roles.manage',
      response: z.null(),
      handler: async () => null,
    }),
  )
})

test('a protected route needs a session and a membership in the school in the path', async () => {
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/test-probe`)
  assert.equal(anonymous.status, 401)
  assert.equal(((await anonymous.json()) as ErrorBody).error.code, 'AUTHENTICATION_REQUIRED')

  const other = await owner.fetch(`/api/schools/${schoolB}/test-probe`)
  assert.equal(other.status, 403)
  assert.equal(((await other.json()) as ErrorBody).error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('the declared permission is decided before the handler runs', async () => {
  // A parent holds no school.read grant anywhere in the school, so the gate
  // refuses the request even though the handler itself checks nothing.
  const response = await parent.fetch(`/api/schools/${schoolA}/test-probe`)
  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
})

test('the query schema owns the parsed values and rejects anything else', async () => {
  const ok = await owner.fetch(`/api/schools/${schoolA}/test-probe?page=3`)
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { schoolId: schoolA, page: 3 })

  const defaulted = await owner.fetch(`/api/schools/${schoolA}/test-probe`)
  assert.deepEqual(await defaulted.json(), { schoolId: schoolA, page: 1 })

  const bad = await owner.fetch(`/api/schools/${schoolA}/test-probe?page=many`)
  assert.equal(bad.status, 400)
  assert.equal(((await bad.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
})

test('a response that fails its contract is never sent', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/test-leak`)
  assert.equal(response.status, 503)
  const body = (await response.json()) as ErrorBody
  assert.equal(body.error.code, 'SERVICE_UNAVAILABLE')
  assert.equal(JSON.stringify(body).includes('must not be sent'), false)
})
