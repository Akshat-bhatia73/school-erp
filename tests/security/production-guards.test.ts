/**
 * Matrix rows: production-bundle-clean, service-unavailable-no-fallback,
 * tenant-context-pooling (HTTP leg).
 *
 * Two kinds of guard: what the shipped browser bundle may contain, and what the
 * server answers when the thing that decides access is not there. A permission
 * service that cannot answer must deny; it must never fall back to a cached or
 * mock decision.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  closeAdminPool,
  closeRateLimitPool,
  seedDatabaseFixtures,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createEnrolledStudent,
  createMember,
  ensureSection,
  forgetTwoFactor,
  signInOffice,
  startServerWith,
  type Client,
  type Member,
} from './support.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '../..')
const webSrc = path.join(repoRoot, 'apps/web/src')
const webDist = path.join(repoRoot, 'apps/web/dist')

const schoolA = fixtureIds.schoolA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const suffix = Math.random().toString(36).slice(2, 10)

let server: TestServer
let owner: Member
let ownerClient: Client
let pupilId = ''

function walk(dir: string): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startServerWith({})
  owner = await createMember(schoolA, ['owner'], 'Guard Owner')
  ownerClient = await signInOffice(server, owner)
  const sectionId = await ensureSection(schoolA, yearA, gradeA, `GRD-${suffix}`)
  pupilId = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId,
    firstName: 'Guard Pupil',
    admissionNumber: `GRD/${suffix}/1`,
    rollNumber: 9,
  })
})

after(async () => {
  await forgetTwoFactor([owner.userId])
  await server.close().catch(() => undefined)
  await closeAdminPool()
  await closeRateLimitPool()
})

test('[production-bundle-clean] the deleted mock data layer has not come back', async () => {
  for (const name of ['client.ts', 'seed.ts', 'store.ts']) {
    const candidate = path.join(webSrc, 'api', name)
    let exists = true
    try {
      statSync(candidate)
    } catch {
      exists = false
    }
    assert.equal(exists, false, `apps/web/src/api/${name} must stay deleted`)
  }

  const offenders: string[] = []
  for (const file of walk(webSrc)) {
    if (!/\.(ts|tsx)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    if (/from ['"][^'"]*api\/(seed|store|client)['"]/.test(text)) {
      offenders.push(path.relative(repoRoot, file))
    }
  }
  assert.deepEqual(offenders, [])
})

test('[production-bundle-clean] no fixture, seed or credential marker reaches the web sources', async () => {
  const markers = [
    'fixture-owner-a@test',
    'fixture-adult@test',
    'A/2026-27/',
    'erp_migrator',
    'AUTH_SECRET',
    'Fixture-Pass!42',
  ]
  const offenders: string[] = []
  for (const file of walk(webSrc)) {
    // The web unit tests may name fixtures; they are not shipped.
    if (/\.test\.(ts|tsx)$/.test(file)) continue
    if (!/\.(ts|tsx|css|html)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const marker of markers) {
      const index = text.indexOf(marker)
      if (index >= 0) offenders.push(`${path.relative(repoRoot, file)}:${index} ${marker}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('[production-bundle-clean] a built bundle, if one is present, carries none of them either', async () => {
  const files = walk(webDist)
  if (files.length === 0) {
    // Nothing is built in this working tree. The source scan above is the
    // standing guard; `pnpm check:assets` is what runs this over a real build.
    return
  }
  const markers = [
    'fixture-owner-a@test',
    'A/2026-27/',
    'erp_migrator',
    'AUTH_SECRET',
    'DATABASE_URL',
    'Fixture-Pass!42',
  ]
  const offenders: string[] = []
  for (const file of files) {
    if (!/\.(js|css|html|map|json)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const marker of markers) {
      const index = text.indexOf(marker)
      if (index >= 0) offenders.push(`${path.relative(repoRoot, file)}:${index} ${marker}`)
    }
  }
  assert.deepEqual(offenders, [])
})

test('[service-unavailable-no-fallback] a read is refused, not answered, when the runtime pool is gone', async () => {
  // The permitted read first, so the failure below is about the outage.
  const before = await ownerClient.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal(before.status, 200)
  const page = await body<{ items: { id: string }[] }>(before)
  assert.ok(page.items.some((item) => item.id === pupilId))

  const detail = await ownerClient.fetch(`/api/schools/${schoolA}/students/${pupilId}`)
  assert.equal(detail.status, 200)

  // The database the decision is made against is taken away mid-session.
  await server.pools.runtime.end()

  for (const path_ of [
    `/api/schools/${schoolA}/students?pageSize=100`,
    `/api/schools/${schoolA}/students/${pupilId}`,
    `/api/schools/${schoolA}/context`,
    `/api/schools/${schoolA}/dashboard`,
  ]) {
    const response = await ownerClient.fetch(path_)
    assert.notEqual(response.status, 200, `${path_} must not answer from a cache`)
    assert.ok(response.status >= 500 || response.status === 403, `${path_} → ${response.status}`)
    const text = await response.text()
    assert.equal(text.includes('Guard Pupil'), false, `${path_} leaked a row`)
    assert.equal(text.includes(pupilId), false, `${path_} leaked an id`)
  }

  // A write is refused the same way: no optimistic commit on a dead pool.
  const write = await ownerClient.fetch(`/api/schools/${schoolA}/students/${pupilId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: 1, firstName: 'Renamed' }),
  })
  assert.notEqual(write.status, 200)
})

test('[service-unavailable-no-fallback] an anonymous caller is still refused during the outage', async () => {
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/students`, {
    headers: { origin: server.origin },
  })
  assert.equal(anonymous.status, 401)
  assert.equal(await codeOf(anonymous), 'AUTHENTICATION_REQUIRED')
})
