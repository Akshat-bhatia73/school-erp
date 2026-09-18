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
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = `lifecycle-owner-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client

interface ErrorBody {
  error: { code: string }
}
interface MemberBody {
  id: string
  status: string
  roleKeys: string[]
  accessVersion: number
}

interface Member {
  membershipId: string
  userId: string
  email: string
}

/** A brand new identity and membership, so a run never disturbs the fixtures. */
async function createMember(
  schoolId: string,
  roleKeys: readonly string[],
  options: { userId?: string; twoFactor?: boolean } = {},
): Promise<Member> {
  const pool = adminPool()
  const userId = options.userId ?? randomUUID()
  const email = `lifecycle-${randomUUID()}@example.test`
  if (!options.userId) {
    await pool.query(
      `INSERT INTO auth_user (id, name, email, two_factor_enabled) VALUES ($1, $2, $3, $4)`,
      [userId, 'Lifecycle Member', email, options.twoFactor === true],
    )
  }
  const membershipId = randomUUID()
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [membershipId, schoolId, userId],
  )
  await grantRoles(schoolId, membershipId, roleKeys)
  return { membershipId, userId, email }
}

async function grantRoles(
  schoolId: string,
  membershipId: string,
  roleKeys: readonly string[],
): Promise<void> {
  await adminPool().query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [schoolId, membershipId, [...roleKeys]],
  )
}

async function versionOf(membershipId: string): Promise<number> {
  const result = await adminPool().query<{ version: number }>(
    `SELECT version FROM school_memberships WHERE id = $1`,
    [membershipId],
  )
  return Number(result.rows[0]?.version)
}

async function statusOf(membershipId: string): Promise<string> {
  const result = await adminPool().query<{ status: string }>(
    `SELECT status FROM school_memberships WHERE id = $1`,
    [membershipId],
  )
  return result.rows[0]?.status ?? 'missing'
}

async function setOwnerMfaAge(interval: string): Promise<void> {
  await adminPool().query(
    `UPDATE auth_session SET mfa_verified_at = now() - $2::interval
      WHERE user_id = $1 AND mfa_verified_at IS NOT NULL`,
    [ownerUserId, interval],
  )
}

function body(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }
}

function putBody(value: unknown): RequestInit {
  return { ...body(value), method: 'PUT' }
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
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [ownerUserId])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [
    ownerUserId,
  ])
  await server.close()
  await closeAdminPool()
})

test('an owner reviews the roles of a teacher', async () => {
  const member = await createMember(schoolA, ['teacher'])
  const version = await versionOf(member.membershipId)
  const response = await owner.fetch(
    `/api/schools/${schoolA}/members/${member.membershipId}/roles`,
    putBody({
      roleKeys: ['teacher', 'parent'],
      expectedVersion: version,
      reason: 'Also collects a sibling from school',
    }),
  )
  assert.equal(response.status, 200)
  const summary = (await response.json()) as MemberBody
  assert.deepEqual([...summary.roleKeys].sort(), ['parent', 'teacher'])
  assert.equal(summary.accessVersion, 2)

  // The reason a person typed lives in the redactable note table, never in the
  // permanent safe_changes.
  const audit = await adminPool().query<{ safe_changes: Record<string, unknown>; note: string | null }>(
    `SELECT e.safe_changes, n.note
       FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.target_id = $2 AND e.action = 'roles.assign'`,
    [schoolA, member.membershipId],
  )
  assert.equal(audit.rowCount, 1)
  assert.equal('reason' in (audit.rows[0]?.safe_changes ?? {}), false)
  assert.equal(audit.rows[0]?.note, 'Also collects a sibling from school')
})

test('a stale expected version changes nothing', async () => {
  const member = await createMember(schoolA, ['teacher'])
  const response = await owner.fetch(
    `/api/schools/${schoolA}/members/${member.membershipId}/roles`,
    putBody({
      roleKeys: ['parent'],
      expectedVersion: (await versionOf(member.membershipId)) + 5,
      reason: 'Stale client state',
    }),
  )
  assert.equal(response.status, 409)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'VERSION_CONFLICT')
  const roles = await adminPool().query(
    `SELECT r.key FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.membership_id = $1`,
    [member.membershipId],
  )
  assert.deepEqual(roles.rows.map((row) => (row as { key: string }).key), ['teacher'])
})

test('ownership cannot be granted through the roles endpoint', async () => {
  const member = await createMember(schoolA, ['teacher'])
  const response = await owner.fetch(
    `/api/schools/${schoolA}/members/${member.membershipId}/roles`,
    putBody({
      roleKeys: ['owner'],
      expectedVersion: await versionOf(member.membershipId),
      reason: 'Trying to shortcut the transfer workflow',
    }),
  )
  assert.equal(response.status, 400)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
})

test('a principal may only assign what it is allowed to delegate', async () => {
  const principal = await createMember(schoolA, ['principal'])
  await setFixturePassword(server, principal.userId, PASSWORD)
  const principalClient = await signInWithMfa(server, {
    userId: principal.userId,
    email: principal.email,
    password: PASSWORD,
  })

  const teacher = await createMember(schoolA, ['teacher'])
  const notDelegable = await principalClient.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/roles`,
    putBody({
      roleKeys: ['accountant'],
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'Wants to hand over the books',
    }),
  )
  assert.equal(notDelegable.status, 403)
  assert.equal(((await notDelegable.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  const parentOnly = await createMember(schoolA, ['parent'])
  const notManageable = await principalClient.fetch(
    `/api/schools/${schoolA}/members/${parentOnly.membershipId}/roles`,
    putBody({
      roleKeys: ['teacher'],
      expectedVersion: await versionOf(parentOnly.membershipId),
      reason: 'Wants to make a parent a teacher',
    }),
  )
  assert.equal(notManageable.status, 403)
  assert.equal(((await notManageable.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
})

test('granting a privileged role needs a recent second factor', async () => {
  const member = await createMember(schoolA, ['teacher'])
  await setOwnerMfaAge('10 minutes')
  const stale = await owner.fetch(
    `/api/schools/${schoolA}/members/${member.membershipId}/roles`,
    putBody({
      roleKeys: ['accountant'],
      expectedVersion: await versionOf(member.membershipId),
      reason: 'Taking over the fee desk',
    }),
  )
  assert.equal(stale.status, 403)
  assert.equal(
    ((await stale.json()) as ErrorBody).error.code,
    'FRESH_AUTHENTICATION_REQUIRED',
  )

  await setOwnerMfaAge('0 seconds')
  const fresh = await owner.fetch(
    `/api/schools/${schoolA}/members/${member.membershipId}/roles`,
    putBody({
      roleKeys: ['accountant'],
      expectedVersion: await versionOf(member.membershipId),
      reason: 'Taking over the fee desk',
    }),
  )
  assert.equal(fresh.status, 200)
  assert.deepEqual(((await fresh.json()) as MemberBody).roleKeys, ['accountant'])
})

test('a suspended member loses the school on its next request', async () => {
  const teacher = await createMember(schoolA, ['teacher'])
  await setFixturePassword(server, teacher.userId, PASSWORD)
  const teacherClient = await signInWithPassword(server, teacher.email, PASSWORD)
  const before = await teacherClient.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(before.status, 200)

  const response = await owner.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/suspend`,
    body({
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'Under review after a complaint',
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(((await response.json()) as MemberBody).status, 'suspended')

  const after = await teacherClient.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(after.status, 403)
  assert.equal(
    ((await after.json()) as ErrorBody).error.code,
    'SCHOOL_ACCESS_UNAVAILABLE',
  )

  // The same suspension cannot be applied twice.
  const again = await owner.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/suspend`,
    body({
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'Under review after a complaint',
    }),
  )
  assert.equal(again.status, 400)
  assert.equal(((await again.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
})

test('removal ends one school only and keeps the exception history', async () => {
  const member = await createMember(schoolA, ['teacher'])
  await adminPool().query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [randomUUID(), schoolB, member.userId],
  )
  const otherSchool = await adminPool().query<{ id: string }>(
    `SELECT id FROM school_memberships WHERE school_id = $1 AND user_id = $2`,
    [schoolB, member.userId],
  )
  const schoolBMembership = otherSchool.rows[0]?.id as string
  await grantRoles(schoolB, schoolBMembership, ['parent'])

  const ruleId = randomUUID()
  await adminPool().query(
    `INSERT INTO resource_access_rules
       (id, school_id, membership_id, permission, effect, target_type,
        effective_from, expires_at, reason, author_membership_id)
     VALUES ($1, $2, $3, 'students.read_basic', 'allow', 'school',
             '2020-01-01', '2021-01-01', 'expired exception', $4)`,
    [ruleId, schoolA, member.membershipId, ownerMembershipId],
  )

  await setFixturePassword(server, member.userId, PASSWORD)
  const memberClient = await signInWithPassword(server, member.email, PASSWORD)

  const response = await owner.fetch(
    `/api/schools/${schoolA}/members/${member.membershipId}/remove`,
    body({
      expectedVersion: await versionOf(member.membershipId),
      reason: 'Left the school at the end of term',
    }),
  )
  assert.equal(response.status, 200)
  assert.equal(((await response.json()) as MemberBody).status, 'removed')

  const gone = await memberClient.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(gone.status, 403)
  const kept = await memberClient.fetch(`/api/schools/${schoolB}/context`)
  assert.equal(kept.status, 200)

  const rule = await adminPool().query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM resource_access_rules WHERE id = $1`,
    [ruleId],
  )
  assert.notEqual(rule.rows[0]?.revoked_at, null)
  const revokedAt = rule.rows[0]?.revoked_at

  const restore = await owner.fetch(
    `/api/schools/${schoolA}/members/${member.membershipId}/restore`,
    body({
      roleKeys: ['teacher'],
      expectedVersion: await versionOf(member.membershipId),
      reason: 'Rejoined for the new session',
    }),
  )
  assert.equal(restore.status, 200)
  const restored = (await restore.json()) as MemberBody
  assert.equal(restored.status, 'active')
  assert.deepEqual(restored.roleKeys, ['teacher'])

  // A restore reviews roles; a revoked exception stays revoked.
  const after = await adminPool().query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM resource_access_rules WHERE id = $1`,
    [ruleId],
  )
  assert.deepEqual(after.rows[0]?.revoked_at, revokedAt)
  assert.equal(await statusOf(member.membershipId), 'active')
})

test('nobody suspends themselves and no outsider reaches this school', async () => {
  const self = await owner.fetch(
    `/api/schools/${schoolA}/members/${ownerMembershipId}/suspend`,
    body({
      expectedVersion: await versionOf(ownerMembershipId),
      reason: 'Trying to suspend my own access',
    }),
  )
  assert.equal(self.status, 403)
  assert.equal(((await self.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  const target = await createMember(schoolA, ['teacher'])
  // A second owner of the other school, so the fixture owners stay untouched.
  const otherOwner = await createMember(schoolB, ['owner'])
  await setFixturePassword(server, otherOwner.userId, PASSWORD)
  const ownerB = await signInWithMfa(server, {
    userId: otherOwner.userId,
    email: otherOwner.email,
    password: PASSWORD,
  })
  const outsider = await ownerB.fetch(
    `/api/schools/${schoolA}/members/${target.membershipId}/suspend`,
    body({
      expectedVersion: await versionOf(target.membershipId),
      reason: 'Owner of another school trying to interfere',
    }),
  )
  assert.equal(outsider.status, 403)
  assert.equal(
    ((await outsider.json()) as ErrorBody).error.code,
    'SCHOOL_ACCESS_UNAVAILABLE',
  )

  const teacher = await createMember(schoolA, ['teacher'])
  await setFixturePassword(server, teacher.userId, PASSWORD)
  const teacherClient = await signInWithPassword(server, teacher.email, PASSWORD)
  const denied = await teacherClient.fetch(
    `/api/schools/${schoolA}/members/${target.membershipId}/suspend`,
    body({
      expectedVersion: await versionOf(target.membershipId),
      reason: 'A teacher has no lifecycle authority',
    }),
  )
  assert.equal(denied.status, 403)
  assert.equal(((await denied.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
})

test('an owner queues credential recovery for a member only', async () => {
  const teacher = await createMember(schoolA, ['teacher'])
  await setFixturePassword(server, teacher.userId, PASSWORD)
  const before = server.delivery.outbox.length

  const response = await owner.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/recovery`,
    body({
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'Locked out and asked at the front desk',
    }),
  )
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { status: 'queued' })

  const sent = server.delivery.outbox
    .slice(before)
    .find((message) => message.purpose === 'password_reset')
  assert.ok(sent, 'a reset was delivered')
  assert.equal(sent.to, teacher.email)
  assert.equal(sent.channel, 'email')

  const self = await owner.fetch(
    `/api/schools/${schoolA}/members/${ownerMembershipId}/recovery`,
    body({
      expectedVersion: await versionOf(ownerMembershipId),
      reason: 'Trying to reset my own credentials this way',
    }),
  )
  assert.equal(self.status, 403)
  assert.equal(((await self.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  const teacherClient = await signInWithPassword(server, teacher.email, PASSWORD)
  const target = await createMember(schoolA, ['teacher'])
  const denied = await teacherClient.fetch(
    `/api/schools/${schoolA}/members/${target.membershipId}/recovery`,
    body({
      expectedVersion: await versionOf(target.membershipId),
      reason: 'A teacher cannot start a reset for a colleague',
    }),
  )
  assert.equal(denied.status, 403)
  assert.equal(((await denied.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
})
