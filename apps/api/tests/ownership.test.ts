import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = `ownership-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client

interface ErrorBody {
  error: { code: string }
}
interface MemberBody {
  id: string
  status: string
  roleKeys: string[]
}
interface Candidate {
  membershipId: string
  userId: string
  email: string
}

async function createCandidate(twoFactor: boolean): Promise<Candidate> {
  const pool = adminPool()
  const userId = randomUUID()
  const email = `ownership-${randomUUID()}@example.test`
  await pool.query(
    `INSERT INTO auth_user (id, name, email, two_factor_enabled) VALUES ($1, $2, $3, $4)`,
    [userId, 'Ownership Candidate', email, twoFactor],
  )
  const membershipId = randomUUID()
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = 'principal'`,
    [schoolA, membershipId],
  )
  return { membershipId, userId, email }
}

async function schoolAccessVersion(): Promise<number> {
  const result = await adminPool().query<{ access_version: number }>(
    `SELECT access_version FROM schools WHERE id = $1`,
    [schoolA],
  )
  return Number(result.rows[0]?.access_version)
}

async function roleKeysOf(membershipId: string): Promise<string[]> {
  const result = await adminPool().query<{ key: string }>(
    `SELECT r.key FROM membership_roles mr
       JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
      WHERE mr.school_id = $1 AND mr.membership_id = $2`,
    [schoolA, membershipId],
  )
  return result.rows.map((row) => row.key).sort()
}

async function activeOwnerIds(): Promise<string[]> {
  const result = await adminPool().query<{ id: string }>(
    `SELECT sm.id FROM school_memberships sm
       JOIN membership_roles mr ON mr.school_id = sm.school_id AND mr.membership_id = sm.id
       JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
      WHERE sm.school_id = $1 AND sm.status = 'active' AND r.key = 'owner'`,
    [schoolA],
  )
  return result.rows.map((row) => row.id)
}

/** Put the fixture owner back, so the other test files see what they expect. */
async function restoreFixtureOwnership(): Promise<void> {
  const pool = adminPool()
  await pool.query(
    `DELETE FROM membership_roles
      WHERE school_id = $1 AND membership_id <> $2
        AND role_id IN (SELECT id FROM roles WHERE school_id = $1 AND key = 'owner')`,
    [schoolA, ownerMembershipId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = 'owner'
     ON CONFLICT DO NOTHING`,
    [schoolA, ownerMembershipId],
  )
  await pool.query(
    `DELETE FROM membership_roles
      WHERE school_id = $1 AND membership_id = $2
        AND role_id IN (SELECT id FROM roles WHERE school_id = $1 AND key = 'principal')`,
    [schoolA, ownerMembershipId],
  )
}

async function setOwnerMfaAge(interval: string): Promise<void> {
  await adminPool().query(
    `UPDATE auth_session SET mfa_verified_at = now() - $2::interval
      WHERE user_id = $1 AND mfa_verified_at IS NOT NULL`,
    [ownerUserId, interval],
  )
}

function transferBody(targetMembershipId: string, version: number): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetMembershipId,
      expectedSchoolAccessVersion: version,
      reason: 'Handing the school over to the new owner',
    }),
  }
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  await adminPool().query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    ownerUserId,
    OWNER_EMAIL,
  ])
  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
})

after(async () => {
  const pool = adminPool()
  await restoreFixtureOwnership()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [
    ownerUserId,
  ])
  await server.close()
  await closeAdminPool()
})

test('a transfer states the school access version it read', async () => {
  const candidate = await createCandidate(true)
  const response = await owner.fetch(
    `/api/schools/${schoolA}/ownership/transfer`,
    transferBody(candidate.membershipId, (await schoolAccessVersion()) + 7),
  )
  assert.equal(response.status, 409)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'VERSION_CONFLICT')
  assert.deepEqual(await activeOwnerIds(), [ownerMembershipId])
})

test('an owner is always an identity with a second factor', async () => {
  const candidate = await createCandidate(false)
  const response = await owner.fetch(
    `/api/schools/${schoolA}/ownership/transfer`,
    transferBody(candidate.membershipId, await schoolAccessVersion()),
  )
  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
  assert.deepEqual(await activeOwnerIds(), [ownerMembershipId])
})

test('a transfer asks for the second factor again', async () => {
  const candidate = await createCandidate(true)
  await setOwnerMfaAge('10 minutes')
  const response = await owner.fetch(
    `/api/schools/${schoolA}/ownership/transfer`,
    transferBody(candidate.membershipId, await schoolAccessVersion()),
  )
  assert.equal(response.status, 403)
  assert.equal(
    ((await response.json()) as ErrorBody).error.code,
    'FRESH_AUTHENTICATION_REQUIRED',
  )
  await setOwnerMfaAge('0 seconds')
  assert.deepEqual(await activeOwnerIds(), [ownerMembershipId])
})

test('only an owner may transfer ownership', async () => {
  const principal = await createCandidate(true)
  await setFixturePassword(server, principal.userId, PASSWORD)
  const principalClient = await signInWithMfa(server, {
    userId: principal.userId,
    email: principal.email,
    password: PASSWORD,
  })
  const target = await createCandidate(true)
  const response = await principalClient.fetch(
    `/api/schools/${schoolA}/ownership/transfer`,
    transferBody(target.membershipId, await schoolAccessVersion()),
  )
  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
  assert.deepEqual(await activeOwnerIds(), [ownerMembershipId])
})

test('two transfers from the same version leave exactly one owner', async () => {
  const first = await createCandidate(true)
  const second = await createCandidate(true)
  const version = await schoolAccessVersion()
  const responses = await Promise.all([
    owner.fetch(
      `/api/schools/${schoolA}/ownership/transfer`,
      transferBody(first.membershipId, version),
    ),
    owner.fetch(
      `/api/schools/${schoolA}/ownership/transfer`,
      transferBody(second.membershipId, version),
    ),
  ])
  const statuses = responses.map((response) => response.status).sort()
  assert.deepEqual(statuses, [200, 409])
  assert.equal((await activeOwnerIds()).length, 1)
  await restoreFixtureOwnership()
})

test('an owner hands the school to a verified candidate', async () => {
  const candidate = await createCandidate(true)
  const before = await schoolAccessVersion()
  const response = await owner.fetch(
    `/api/schools/${schoolA}/ownership/transfer`,
    transferBody(candidate.membershipId, before),
  )
  assert.equal(response.status, 200)
  const summary = (await response.json()) as MemberBody
  assert.equal(summary.id, candidate.membershipId)
  assert.ok(summary.roleKeys.includes('owner'))
  assert.equal(summary.status, 'active')

  assert.equal(await schoolAccessVersion(), before + 1)
  assert.deepEqual(await activeOwnerIds(), [candidate.membershipId])
  // The outgoing owner keeps a working membership rather than an empty one.
  assert.deepEqual(await roleKeysOf(ownerMembershipId), ['principal'])

  const audit = await adminPool().query<{
    safe_changes: { fromMembershipId: string; toMembershipId: string }
  }>(
    `SELECT safe_changes FROM audit_events
      WHERE school_id = $1 AND action = 'ownership.transfer' AND target_id = $1
      ORDER BY created_at DESC LIMIT 1`,
    [schoolA],
  )
  assert.equal(audit.rows[0]?.safe_changes.toMembershipId, candidate.membershipId)
  assert.equal(audit.rows[0]?.safe_changes.fromMembershipId, ownerMembershipId)

  await restoreFixtureOwnership()
})
