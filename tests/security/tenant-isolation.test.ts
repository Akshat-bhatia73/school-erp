/**
 * Matrix rows: anon-every-endpoint, cross-school-record, tenant-context-pooling.
 *
 * The first row is swept rather than sampled: the Fastify route table itself is
 * the list of business endpoints, so a route added later is covered the moment
 * it is registered.
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
} from '../../apps/api/tests/harness.ts'
import {
  PASSWORD,
  codeOf,
  createMember,
  forgetTwoFactor,
  signInOffice,
  startServerWith,
  type Client,
  type CustomServer,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const studentB = fixtureIds.studentB as string
const studentA = fixtureIds.studentA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const sectionA = fixtureIds.sectionA as string
const documentA = fixtureIds.documentA as string
const staffA = fixtureIds.staffA as string

let server: CustomServer
let ownerA: Client
let ownerAMember: Awaited<ReturnType<typeof createMember>>

/** Fixture strings that must never appear in an unauthenticated answer. */
const SECRET_MARKERS = ['Student A', 'Fixture A', 'A/2026-27/001', 'B/2026-27/001']

/**
 * Fastify prints its route table as a tree. Reading it, instead of a hand
 * written list, is what makes this row a sweep: a new protected route appears
 * here automatically and must answer 401 without a session.
 */
function routeTable(tree: string): { method: string; path: string }[] {
  const stack: { depth: number; segment: string }[] = []
  const routes: { method: string; path: string }[] = []
  for (const line of tree.split('\n')) {
    if (!line.trim()) continue
    const match = /^[\s│├└─]*/.exec(line)
    const depth = match ? match[0].length : 0
    const rest = line.slice(depth)
    const methods = /\s\((.+)\)\s*$/.exec(rest)
    const segment = methods ? rest.slice(0, methods.index) : rest
    while (stack.length > 0 && (stack[stack.length - 1]?.depth ?? 0) >= depth) stack.pop()
    stack.push({ depth, segment })
    if (!methods) continue
    const path = stack.map((entry) => entry.segment).join('')
    for (const method of (methods[1] ?? '').split(',').map((value) => value.trim())) {
      if (method === 'HEAD' || method === 'OPTIONS') continue
      routes.push({ method, path })
    }
  }
  return routes
}

/** A concrete, valid-looking URL for a printed route pattern. */
function concreteUrl(path: string): string {
  return path
    .replace(':schoolId', schoolA)
    .replace(':studentId', studentA)
    .replace(':staffId', staffA)
    .replace(':membershipId', ownerAMember.membershipId)
    .replace(':sectionId', sectionA)
    .replace(':documentId', documentA)
    .replace(':invitationId', fixtureIds.documentA as string)
    .replace(':jobId', fixtureIds.documentA as string)
    .replace(':assignmentId', fixtureIds.documentA as string)
    .replace(':sessionId', fixtureIds.documentA as string)
    .replace(/:[A-Za-z]+/g, fixtureIds.documentA as string)
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startServerWith({})
  ownerAMember = await createMember(schoolA, ['owner'], 'Isolation Owner')
  const { setFixturePassword } = await import('../../apps/api/tests/harness.ts')
  await setFixturePassword(server, ownerAMember.userId, PASSWORD)
  ownerA = await signInOffice(server, ownerAMember)
})

after(async () => {
  await forgetTwoFactor([ownerAMember.userId])
  await server.close()
  await closeAdminPool()
})

test('[anon-every-endpoint] every registered school route refuses an anonymous caller', async () => {
  const printed = server.printRoutes()
  const all = routeTable(printed)
  const business = all.filter(
    (route) =>
      route.path.startsWith('/api/schools/') ||
      route.path.startsWith('/api/members') ||
      route.path === '/api/me' ||
      route.path === '/api/sessions' ||
      route.path.startsWith('/api/invitations'),
  )
  assert.ok(business.length >= 40, `expected the school surface, saw ${business.length}`)

  const failures: string[] = []
  for (const route of business) {
    const url = concreteUrl(route.path)
    const init: RequestInit =
      route.method === 'GET' || route.method === 'DELETE'
        ? { method: route.method }
        : {
            method: route.method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          }
    const response = await fetch(`${server.origin}${url}`, init)
    const text = await response.text()
    if (response.status !== 401) {
      failures.push(`${route.method} ${route.path} -> ${response.status}`)
      continue
    }
    if (JSON.parse(text).error.code !== 'AUTHENTICATION_REQUIRED') {
      failures.push(`${route.method} ${route.path} -> ${JSON.parse(text).error.code}`)
    }
    for (const marker of SECRET_MARKERS) {
      if (text.includes(marker)) failures.push(`${route.method} ${route.path} leaked ${marker}`)
    }
  }
  assert.deepEqual(failures, [])

  // The same routes answer for a member, so a deny-everything server fails here.
  const permitted = await ownerA.fetch(`/api/schools/${schoolA}/students`)
  assert.equal(permitted.status, 200)
})

test('[cross-school-record] school B records, lists and exports are unreachable from school A', async () => {
  // The permitted half first: this owner really can read school A.
  const own = await ownerA.fetch(`/api/schools/${schoolA}/students/${studentA}`)
  assert.equal(own.status, 200)

  const inPath = await ownerA.fetch(`/api/schools/${schoolB}/students`)
  assert.equal(inPath.status, 403)
  assert.equal(await codeOf(inPath), 'SCHOOL_ACCESS_UNAVAILABLE')

  const detail = await ownerA.fetch(`/api/schools/${schoolA}/students/${studentB}`)
  assert.equal(detail.status, 404)
  const text = await detail.text()
  assert.equal(JSON.parse(text).error.code, 'RESOURCE_NOT_FOUND')
  assert.equal(text.includes('B/2026-27/001'), false)

  const exported = await ownerA.fetch(`/api/schools/${schoolA}/students/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentIds: [studentA, studentB] }),
  })
  assert.equal(exported.status, 404)
  const jobs = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM export_jobs
      WHERE school_id = $1 AND criteria::text LIKE '%' || $2 || '%'`,
    [schoolA, studentB],
  )
  assert.equal(jobs.rows[0]?.count, '0')

  const file = await ownerA.fetch(
    `/api/schools/${schoolA}/students/${studentB}/documents/${documentA}/content`,
  )
  assert.equal(file.status, 404)
})

test('[cross-school-record] a setup read of another school never crosses the boundary', async () => {
  const mine = await ownerA.fetch(`/api/schools/${schoolA}/academic-years`)
  assert.equal(mine.status, 200)
  const text = await mine.text()
  assert.equal(text.includes(fixtureIds.schoolB as string), false)

  const sections = await ownerA.fetch(
    `/api/schools/${schoolA}/sections?academicYearId=${yearA}&gradeId=${gradeA}`,
  )
  assert.equal(sections.status, 200)
  const other = await ownerA.fetch(`/api/schools/${schoolB}/academic-years`)
  assert.equal(other.status, 403)
})
