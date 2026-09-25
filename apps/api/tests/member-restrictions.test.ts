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
const OWNER_EMAIL = `restrict-owner-${randomUUID()}@example.test`
const AADHAAR = '200000007919'

const schoolA = fixtureIds.schoolA as string
const yearA = fixtureIds.yearA as string
const sectionA = fixtureIds.sectionA as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let admin: Member
let adminClient: Client
let principal: Member
let principalClient: Client
let pupil = ''

interface ErrorBody {
  error: { code: string }
}
interface Member {
  membershipId: string
  userId: string
  email: string
}
interface RestrictionBody {
  id: string
  permission: string
  reason: string
  startsAt: string
  expiresAt: string | null
  createdBy: { membershipId: string; displayName: string }
  createdAt: string
  version: number
}
interface ListBody {
  items: RestrictionBody[]
  allowedActions: string[]
}

async function codeOf(response: Response): Promise<string> {
  return ((await response.json()) as ErrorBody).error.code
}

async function createMember(schoolId: string, roleKeys: readonly string[]): Promise<Member> {
  const pool = adminPool()
  const userId = randomUUID()
  const email = `restrict-${randomUUID()}@example.test`
  await pool.query(`INSERT INTO auth_user (id, name, email) VALUES ($1, 'Restricted Member', $2)`, [
    userId,
    email,
  ])
  const membershipId = randomUUID()
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [membershipId, schoolId, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])`,
    [schoolId, membershipId, [...roleKeys]],
  )
  return { membershipId, userId, email }
}

async function signIn(member: Member): Promise<Client> {
  await setFixturePassword(server, member.userId, PASSWORD)
  return signInWithMfa(server, { userId: member.userId, email: member.email, password: PASSWORD })
}

async function accessVersionOf(membershipId: string): Promise<number> {
  const result = await adminPool().query<{ access_version: number }>(
    'SELECT access_version FROM school_memberships WHERE id = $1',
    [membershipId],
  )
  return Number(result.rows[0]?.access_version)
}

async function versionOf(membershipId: string): Promise<number> {
  const result = await adminPool().query<{ version: number }>(
    'SELECT version FROM school_memberships WHERE id = $1',
    [membershipId],
  )
  return Number(result.rows[0]?.version)
}

function post(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }
}

function restrictionsPath(membershipId: string): string {
  return `/api/schools/${schoolA}/members/${membershipId}/restrictions`
}

async function restrict(
  client: Client,
  membershipId: string,
  permission: string,
  extra: { reason?: string; expiresAt?: string; expectedAccessVersion?: number } = {},
): Promise<Response> {
  return client.fetch(
    restrictionsPath(membershipId),
    post({
      permission,
      reason: extra.reason ?? 'Keeps to timetable work only',
      ...(extra.expiresAt === undefined ? {} : { expiresAt: extra.expiresAt }),
      expectedAccessVersion: extra.expectedAccessVersion ?? (await accessVersionOf(membershipId)),
    }),
  )
}

async function lift(
  client: Client,
  membershipId: string,
  restriction: { id: string; version: number },
  reason = 'Back on admissions duty',
): Promise<Response> {
  return client.fetch(
    `${restrictionsPath(membershipId)}/${restriction.id}/lift`,
    post({ expectedVersion: restriction.version, reason }),
  )
}

async function list(client: Client, membershipId: string): Promise<ListBody> {
  const response = await client.fetch(restrictionsPath(membershipId))
  assert.equal(response.status, 200)
  return (await response.json()) as ListBody
}

async function capabilitiesOf(client: Client): Promise<string[]> {
  const response = await client.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(response.status, 200)
  return ((await response.json()) as { capabilities: string[] }).capabilities
}

async function auditRows(targetId: string, action: string) {
  return adminPool().query<{ safe_changes: Record<string, unknown>; note: string | null }>(
    `SELECT e.safe_changes, n.note
       FROM audit_events e
       LEFT JOIN audit_event_notes n ON n.school_id = e.school_id AND n.audit_event_id = e.id
      WHERE e.school_id = $1 AND e.target_id = $2 AND e.action = $3`,
    [schoolA, targetId, action],
  )
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })

  admin = await createMember(schoolA, ['admin'])
  adminClient = await signIn(admin)
  principal = await createMember(schoolA, ['principal'])
  principalClient = await signIn(principal)

  // A pupil of this file's own, in the fixture class, with an Aadhaar number.
  const inserted = await pool.query<{ id: string; version: number }>(
    `INSERT INTO students
       (school_id, admission_number, first_name, last_name, status, date_of_birth, gender, admission_date)
     VALUES ($1, $2, 'Restricted', 'Record', 'active', '2014-06-01', 'female', '2020-04-01')
     RETURNING id, version`,
    [schoolA, `RST-${randomUUID().slice(0, 8)}`],
  )
  pupil = inserted.rows[0]?.id as string
  await pool.query(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     VALUES ($1, $2, $3, $4, current_date)`,
    [schoolA, pupil, yearA, sectionA],
  )
  const sensitive = await owner.fetch(`/api/schools/${schoolA}/students/${pupil}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: Number(inserted.rows[0]?.version), aadhaar: AADHAAR }),
  })
  assert.equal(sensitive.status, 200)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM enrollments WHERE school_id = $1 AND student_id = $2', [schoolA, pupil])
  for (const userId of [ownerUserId, admin.userId, principal.userId]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  await server.close()
  await closeAdminPool()
})

test('an owner restricts an admin from sensitive details, and lifting gives them back', async () => {
  const detailPath = `/api/schools/${schoolA}/students/${pupil}`
  const beforeDetail = (await (await adminClient.fetch(detailPath)).json()) as Record<string, unknown>
  assert.equal('sensitive' in beforeDetail, true)
  assert.equal((await adminClient.fetch(`${detailPath}/aadhaar`)).status, 200)
  assert.equal((await capabilitiesOf(adminClient)).includes('students.read_sensitive'), true)

  const accessBefore = await accessVersionOf(admin.membershipId)
  const response = await restrict(owner, admin.membershipId, 'students.read_sensitive', {
    reason: 'Aadhaar numbers stay with the principal',
  })
  assert.equal(response.status, 201)
  const created = (await response.json()) as RestrictionBody
  assert.equal(created.permission, 'students.read_sensitive')
  assert.equal(created.expiresAt, null)
  assert.equal(created.createdBy.membershipId, ownerMembershipId)
  assert.equal(created.version, 1)
  assert.equal(await accessVersionOf(admin.membershipId), accessBefore + 1)

  // The same person, on their very next request.
  const afterDetail = (await (await adminClient.fetch(detailPath)).json()) as Record<string, unknown>
  assert.equal('sensitive' in afterDetail, false)
  assert.equal('student' in afterDetail, true)
  const reveal = await adminClient.fetch(`${detailPath}/aadhaar`)
  assert.equal(reveal.status, 403)
  assert.equal(await codeOf(reveal), 'ACCESS_DENIED')
  const capabilities = await capabilitiesOf(adminClient)
  assert.equal(capabilities.includes('students.read_sensitive'), false)
  // Only that key goes: the rest of the office work is untouched.
  assert.equal(capabilities.includes('students.read_basic'), true)
  assert.equal(capabilities.includes('students.read_guardians'), true)

  // The access explanation names the deny rule.
  const explained = await owner.fetch(
    `/api/schools/${schoolA}/members/${admin.membershipId}/access-explanation?permission=students.read_sensitive&resourceType=student&resourceId=${pupil}`,
  )
  assert.equal(explained.status, 200)
  const explanation = (await explained.json()) as {
    allowed: boolean
    sources: { kind: string; description: string }[]
  }
  assert.equal(explanation.allowed, false)
  assert.ok(explanation.sources.some((source) => source.kind === 'exception' && /deny/.test(source.description)))
  assert.equal(JSON.stringify(explanation).includes('Aadhaar numbers stay'), false)

  // One audit row; the reason is a redactable note and never structural data.
  const restrictAudit = await auditRows(admin.membershipId, 'access.restrict')
  assert.equal(restrictAudit.rowCount, 1)
  const safe = restrictAudit.rows[0]?.safe_changes ?? {}
  assert.equal(safe.permission, 'students.read_sensitive')
  assert.equal('reason' in safe, false)
  assert.equal(JSON.stringify(safe).includes('Aadhaar numbers stay'), false)
  assert.equal(restrictAudit.rows[0]?.note, 'Aadhaar numbers stay with the principal')

  const listed = await list(owner, admin.membershipId)
  assert.deepEqual(listed.allowedActions, ['access.manage'])
  assert.equal(listed.items.length, 1)
  assert.equal(listed.items[0]?.id, created.id)
  assert.equal(listed.items[0]?.reason, 'Aadhaar numbers stay with the principal')
  assert.equal(listed.items[0]?.createdBy.displayName.length > 0, true)

  // A stale rule version changes nothing.
  const stale = await lift(owner, admin.membershipId, { id: created.id, version: created.version + 1 })
  assert.equal(stale.status, 409)
  assert.equal(await codeOf(stale), 'VERSION_CONFLICT')

  const lifted = await lift(owner, admin.membershipId, created, 'Needed for board registrations')
  assert.equal(lifted.status, 200)
  assert.deepEqual(await lifted.json(), { status: 'lifted' })
  assert.equal(await accessVersionOf(admin.membershipId), accessBefore + 2)
  const rule = await adminPool().query<{ revoked_at: Date | null; version: number }>(
    'SELECT revoked_at, version FROM resource_access_rules WHERE id = $1',
    [created.id],
  )
  assert.notEqual(rule.rows[0]?.revoked_at, null)
  assert.equal(Number(rule.rows[0]?.version), 2)

  const restored = (await (await adminClient.fetch(detailPath)).json()) as Record<string, unknown>
  assert.equal('sensitive' in restored, true)
  assert.equal((await adminClient.fetch(`${detailPath}/aadhaar`)).status, 200)
  assert.equal((await capabilitiesOf(adminClient)).includes('students.read_sensitive'), true)

  const liftAudit = await auditRows(admin.membershipId, 'access.restriction_lift')
  assert.equal(liftAudit.rowCount, 1)
  assert.equal('reason' in (liftAudit.rows[0]?.safe_changes ?? {}), false)
  assert.equal(liftAudit.rows[0]?.note, 'Needed for board registrations')
  assert.equal((await auditRows(admin.membershipId, 'access.restrict')).rowCount, 1)

  assert.equal((await list(owner, admin.membershipId)).items.length, 0)
  // Lifting twice finds nothing to lift.
  const again = await lift(owner, admin.membershipId, { id: created.id, version: 2 })
  assert.equal(again.status, 404)
  assert.equal(await codeOf(again), 'RESOURCE_NOT_FOUND')
})

test('a restriction past its end date no longer applies', async () => {
  const detailPath = `/api/schools/${schoolA}/students/${pupil}`
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  const response = await restrict(owner, admin.membershipId, 'students.read_sensitive', {
    expiresAt: soon,
  })
  assert.equal(response.status, 201)
  const created = (await response.json()) as RestrictionBody
  assert.equal(created.expiresAt, soon)
  assert.equal('sensitive' in ((await (await adminClient.fetch(detailPath)).json()) as object), false)

  await adminPool().query(
    `UPDATE resource_access_rules
        SET effective_from = now() - interval '3 days', expires_at = now() - interval '1 day'
      WHERE id = $1`,
    [created.id],
  )
  assert.equal('sensitive' in ((await (await adminClient.fetch(detailPath)).json()) as object), true)
  assert.equal((await list(owner, admin.membershipId)).items.length, 0)
  // An ended restriction is not in force, so it cannot be lifted and does not
  // block a new one of the same kind.
  const ended = await lift(owner, admin.membershipId, created)
  assert.equal(ended.status, 404)
  const fresh = await restrict(owner, admin.membershipId, 'students.read_sensitive')
  assert.equal(fresh.status, 201)
  const renewed = (await fresh.json()) as RestrictionBody
  assert.equal((await lift(owner, admin.membershipId, renewed)).status, 200)
})

test('the end date must be in the future and within two years', async () => {
  const past = await restrict(owner, admin.membershipId, 'students.read_guardians', {
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })
  assert.equal(past.status, 400)
  assert.equal(await codeOf(past), 'INVALID_REQUEST')
  const tooFar = await restrict(owner, admin.membershipId, 'students.read_guardians', {
    expiresAt: new Date(Date.now() + 3 * 366 * 24 * 60 * 60 * 1000).toISOString(),
  })
  assert.equal(tooFar.status, 400)
  // Only the three restrictable keys are accepted.
  const other = await restrict(owner, admin.membershipId, 'students.read_basic')
  assert.equal(other.status, 400)
  assert.equal(await codeOf(other), 'INVALID_REQUEST')
  // Guardian phone and email go with any guardian record, so they are not restrictable.
  const contact = await restrict(owner, admin.membershipId, 'students.read_guardian_contact')
  assert.equal(contact.status, 400)
  assert.equal(await codeOf(contact), 'INVALID_REQUEST')
  assert.equal((await list(owner, admin.membershipId)).items.length, 0)
})

test('a stale access version and a duplicate are both conflicts', async () => {
  const teacher = await createMember(schoolA, ['teacher'])
  const current = await accessVersionOf(teacher.membershipId)
  const stale = await restrict(owner, teacher.membershipId, 'students.read_medical', {
    expectedAccessVersion: current + 3,
  })
  assert.equal(stale.status, 409)
  assert.equal(await codeOf(stale), 'VERSION_CONFLICT')
  assert.equal(await accessVersionOf(teacher.membershipId), current)

  assert.equal((await restrict(owner, teacher.membershipId, 'students.read_medical')).status, 201)
  const duplicate = await restrict(owner, teacher.membershipId, 'students.read_medical')
  assert.equal(duplicate.status, 409)
  assert.equal(await codeOf(duplicate), 'VERSION_CONFLICT')
  assert.equal((await list(owner, teacher.membershipId)).items.length, 1)
  assert.equal((await auditRows(teacher.membershipId, 'access.restrict')).rowCount, 1)
})

test('a principal restricts an admin, an accountant or a teacher but never an owner, a principal or themselves', async () => {
  const teacher = await createMember(schoolA, ['teacher'])
  const accountant = await createMember(schoolA, ['accountant'])
  const officeAdmin = await createMember(schoolA, ['admin'])
  for (const target of [teacher.membershipId, accountant.membershipId, officeAdmin.membershipId]) {
    const allowed = await restrict(principalClient, target, 'students.read_medical')
    assert.equal(allowed.status, 201, `target ${target}`)
    assert.deepEqual((await list(principalClient, target)).allowedActions, ['access.manage'])
  }
  // The admin holds full guardian records, and a principal may take them away.
  assert.equal((await restrict(principalClient, officeAdmin.membershipId, 'students.read_guardians')).status, 201)

  const otherPrincipal = await createMember(schoolA, ['principal'])
  for (const target of [ownerMembershipId, otherPrincipal.membershipId, principal.membershipId]) {
    const refused = await restrict(principalClient, target, 'students.read_medical')
    assert.equal(refused.status, 403, `target ${target}`)
    assert.equal(await codeOf(refused), 'ACCESS_DENIED')
    // The list still answers, but offers nothing to do.
    assert.deepEqual((await list(principalClient, target)).allowedActions, [])
  }
  assert.equal((await list(principalClient, ownerMembershipId)).items.length, 0)

  // An owner may restrict a principal, and lift it again.
  const byOwner = await restrict(owner, otherPrincipal.membershipId, 'students.read_sensitive')
  assert.equal(byOwner.status, 201)
  assert.deepEqual((await list(owner, otherPrincipal.membershipId)).allowedActions, ['access.manage'])
  assert.equal((await lift(owner, otherPrincipal.membershipId, (await byOwner.json()) as RestrictionBody)).status, 200)

  // Nobody restricts themselves, the owner included.
  const self = await restrict(owner, ownerMembershipId, 'students.read_medical')
  assert.equal(self.status, 403)
  assert.equal(await codeOf(self), 'ACCESS_DENIED')
})

test('parents, pupils and members who are not active cannot be restricted', async () => {
  const parent = await createMember(schoolA, ['parent'])
  const refused = await restrict(owner, parent.membershipId, 'students.read_guardians')
  assert.equal(refused.status, 400)
  assert.equal(await codeOf(refused), 'INVALID_REQUEST')
  assert.deepEqual((await list(owner, parent.membershipId)).allowedActions, [])

  const pupilLogin = await restrict(owner, fixtureIds.studentMember as string, 'students.read_medical')
  assert.equal(pupilLogin.status, 400)

  const suspended = await createMember(schoolA, ['teacher'])
  await adminPool().query(`UPDATE school_memberships SET status = 'suspended' WHERE id = $1`, [
    suspended.membershipId,
  ])
  const notActive = await restrict(owner, suspended.membershipId, 'students.read_guardians')
  assert.equal(notActive.status, 400)
  assert.equal(await codeOf(notActive), 'INVALID_REQUEST')

  const rows = await adminPool().query(
    'SELECT 1 FROM resource_access_rules WHERE membership_id = ANY($1::uuid[])',
    [[parent.membershipId, suspended.membershipId, fixtureIds.studentMember as string]],
  )
  assert.equal(rows.rowCount, 0)
})

test('the list shows only restrictions in force, newest first', async () => {
  const teacher = await createMember(schoolA, ['teacher'])
  const first = (await (await restrict(owner, teacher.membershipId, 'students.read_guardians')).json()) as RestrictionBody
  const second = (await (await restrict(owner, teacher.membershipId, 'students.read_medical')).json()) as RestrictionBody
  const lifted = (await (await restrict(owner, teacher.membershipId, 'students.read_sensitive')).json()) as RestrictionBody
  assert.equal((await lift(owner, teacher.membershipId, lifted)).status, 200)
  const pool = adminPool()
  // One that ended yesterday, and an ordinary exception that is no restriction.
  await pool.query(
    `INSERT INTO resource_access_rules
       (school_id, membership_id, permission, effect, target_type, effective_from, expires_at, reason, author_membership_id)
     VALUES ($1, $2, 'students.read_guardians', 'deny', 'school', now() - interval '5 days', now() - interval '1 day', 'Ended', $3),
            ($1, $2, 'students.read_basic', 'allow', 'school', now() - interval '5 days', NULL, 'Ordinary exception', $3)`,
    [schoolA, teacher.membershipId, ownerMembershipId],
  )
  await pool.query(
    `UPDATE resource_access_rules SET created_at = created_at - interval '1 minute' WHERE id = $1`,
    [first.id],
  )

  const listed = await list(owner, teacher.membershipId)
  assert.deepEqual(
    listed.items.map((item) => item.id),
    [second.id, first.id],
  )
})

test('removal ends restrictions and restore does not bring them back', async () => {
  const teacher = await createMember(schoolA, ['teacher'])
  const created = (await (await restrict(owner, teacher.membershipId, 'students.read_medical')).json()) as RestrictionBody

  const removed = await owner.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/remove`,
    post({ expectedVersion: await versionOf(teacher.membershipId), reason: 'Left the school' }),
  )
  assert.equal(removed.status, 200)
  const rule = await adminPool().query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM resource_access_rules WHERE id = $1',
    [created.id],
  )
  assert.notEqual(rule.rows[0]?.revoked_at, null)

  const restored = await owner.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/restore`,
    post({
      expectedVersion: await versionOf(teacher.membershipId),
      roleKeys: ['teacher'],
      reason: 'Rejoined after leave',
    }),
  )
  assert.equal(restored.status, 200)
  assert.equal((await list(owner, teacher.membershipId)).items.length, 0)
})
