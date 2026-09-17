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
// Unique per run: other test files rewrite the same fixture identities.
const OWNER_EMAIL = `invite-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `invite-parent-${randomUUID()}@example.test`
const PRINCIPAL_EMAIL = `invite-principal-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const ownerMembershipId = fixtureIds.ownerA as string
const parentUserId = fixtureIds.parentA2User as string
const linkedStaffId = fixtureIds.staffA as string

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let parent: Client
let principalUserId: string

interface ErrorBody {
  error: { code: string }
}
interface Invitation {
  id: string
  schoolId: string
  displayName: string
  maskedDestination: string
  roleKeys: string[]
  status: string
  deliveryStatus: string
  expiresAt: string
  version: number
}
interface Member {
  id: string
  roleKeys: string[]
  staffId?: string
  status: string
}

function uniqueInviteEmail(): string {
  return `invitee-${randomUUID()}@example.test`
}

// Every staff row this file inserts, so the after hook can remove them: the
// suite shares one database between runs, and a free-teacher list is capped.
const createdStaff: string[] = []
// Logins and memberships this file creates, removed by the after hook.
const createdUsers: string[] = []
const createdMemberships: string[] = []

async function createStaff(schoolId: string): Promise<string> {
  const id = randomUUID()
  createdStaff.push(id)
  await adminPool().query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, last_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Invited', 'Teacher', 'teaching', 'Teacher', 'active')`,
    [id, schoolId, `INV-${randomUUID().slice(0, 8)}`],
  )
  return id
}

async function roleId(schoolId: string, key: string): Promise<string> {
  const result = await adminPool().query<{ id: string }>(
    'SELECT id FROM roles WHERE school_id = $1 AND key = $2',
    [schoolId, key],
  )
  const id = result.rows[0]?.id
  assert.ok(id, `role ${key} is missing`)
  return id
}

async function post(
  client: Client,
  path: string,
  body: unknown,
): Promise<Response> {
  return client.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function latestToken(): string {
  const messages = server.delivery.outbox.filter(
    (message) => message.purpose === 'invitation',
  )
  const message = messages[messages.length - 1]
  assert.ok(message, 'no invitation was delivered')
  return message.secret
}

async function userIdByEmail(email: string): Promise<string> {
  const result = await adminPool().query<{ id: string }>(
    'SELECT id FROM auth_user WHERE lower(email) = $1',
    [email.toLowerCase()],
  )
  const id = result.rows[0]?.id
  assert.ok(id, 'the invited identity was not provisioned')
  return id
}

/** Invite a brand new teacher and return everything the invitee needs. */
async function inviteTeacher(): Promise<{
  invitation: Invitation
  token: string
  email: string
  staffId: string
}> {
  const email = uniqueInviteEmail()
  const staffId = await createStaff(schoolA)
  const response = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'New Teacher',
    identifier: { kind: 'email', value: email },
    roleKeys: ['teacher'],
    staffId,
  })
  assert.equal(response.status, 201)
  return {
    invitation: (await response.json()) as Invitation,
    token: latestToken(),
    email,
    staffId,
  }
}

async function signInInvitee(email: string): Promise<Client> {
  const userId = await userIdByEmail(email)
  await setFixturePassword(server, userId, PASSWORD)
  return signInWithPassword(server, email, PASSWORD)
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    ownerUserId,
    OWNER_EMAIL,
  ])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    parentUserId,
    PARENT_EMAIL,
  ])
  await setFixturePassword(server, parentUserId, PASSWORD)

  principalUserId = randomUUID()
  await pool.query(
    `INSERT INTO auth_user (id, name, email) VALUES ($1, 'Invite Principal', $2)`,
    [principalUserId, PRINCIPAL_EMAIL],
  )
  const principalMembershipId = randomUUID()
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [principalMembershipId, schoolA, principalUserId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [schoolA, principalMembershipId, await roleId(schoolA, 'principal')],
  )

  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    [ownerUserId, principalUserId],
  ])
  await pool.query(
    'UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])',
    [[ownerUserId, principalUserId]],
  )
  await pool.query('DELETE FROM school_invitations WHERE staff_id = ANY($1::uuid[])', [createdStaff])
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [createdUsers])
  await pool.query('DELETE FROM membership_roles WHERE membership_id = ANY($1::uuid[])', [createdMemberships])
  await pool.query('DELETE FROM school_memberships WHERE id = ANY($1::uuid[])', [createdMemberships])
  await pool.query('DELETE FROM auth_user WHERE id = ANY($1::uuid[])', [createdUsers])
  await pool.query('DELETE FROM membership_staff_links WHERE staff_id = ANY($1::uuid[])', [createdStaff])
  await pool.query('DELETE FROM staff WHERE id = ANY($1::uuid[])', [createdStaff])
  await server.close()
  await closeAdminPool()
})

test('an owner invites a new teacher by email', async () => {
  const email = uniqueInviteEmail()
  const staffId = await createStaff(schoolA)
  const before = server.delivery.outbox.length

  const response = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'New Teacher',
    identifier: { kind: 'email', value: email },
    roleKeys: ['teacher'],
    staffId,
  })
  assert.equal(response.status, 201)
  const body = (await response.json()) as Invitation
  assert.equal(body.status, 'pending')
  assert.equal(body.deliveryStatus, 'sent')
  assert.deepEqual(body.roleKeys, ['teacher'])
  assert.ok(!body.maskedDestination.includes(email.split('@')[0] as string))
  assert.ok(body.maskedDestination.endsWith('@example.test'))

  const messages = server.delivery.outbox.slice(before)
  assert.equal(messages.length, 1)
  const message = messages[0]
  assert.ok(message)
  assert.equal(message.purpose, 'invitation')
  assert.equal(message.channel, 'email')
  assert.equal(message.to, email)
  assert.ok(message.secret.startsWith(`${schoolA}.`))

  const pool = adminPool()
  const stored = await pool.query<{ token_digest: string; status: string }>(
    'SELECT token_digest, status FROM school_invitations WHERE id = $1',
    [body.id],
  )
  const row = stored.rows[0]
  assert.ok(row)
  assert.equal(row.status, 'pending')
  assert.ok(!message.secret.includes(row.token_digest))
  assert.ok(!row.token_digest.includes(message.secret.split('.')[1] as string))

  const outbox = await pool.query<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM delivery_outbox
      WHERE school_id = $1 AND payload->>'invitationId' = $2`,
    [schoolA, body.id],
  )
  assert.equal(outbox.rows[0]?.status, 'sent')

  const audit = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = 'members.invite'`,
    [schoolA, body.id],
  )
  assert.equal(audit.rows[0]?.count, '1')

  const identity = await pool.query<{ id: string }>(
    'SELECT id FROM auth_user WHERE lower(email) = $1',
    [email],
  )
  assert.equal(identity.rows.length, 1)
})

test('the invitee accepts once and becomes a member', async () => {
  const invited = await inviteTeacher()
  const invitee = await signInInvitee(invited.email)

  const accepted = await post(invitee, '/api/invitations/accept', {
    token: invited.token,
  })
  assert.equal(accepted.status, 200)
  const member = (await accepted.json()) as Member
  assert.deepEqual(member.roleKeys, ['teacher'])
  assert.equal(member.staffId, invited.staffId)
  assert.equal(member.status, 'active')

  const context = await invitee.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(context.status, 200)
  const contextBody = (await context.json()) as { roleKeys: string[] }
  assert.deepEqual(contextBody.roleKeys, ['teacher'])

  const link = await adminPool().query<{ membership_id: string }>(
    'SELECT membership_id FROM membership_staff_links WHERE school_id = $1 AND staff_id = $2',
    [schoolA, invited.staffId],
  )
  assert.equal(link.rows[0]?.membership_id, member.id)

  const again = await post(invitee, '/api/invitations/accept', {
    token: invited.token,
  })
  assert.equal(again.status, 400)
  assert.equal(((await again.json()) as ErrorBody).error.code, 'INVITATION_UNAVAILABLE')
})

test('two concurrent accepts create exactly one membership', async () => {
  const invited = await inviteTeacher()
  const invitee = await signInInvitee(invited.email)
  const userId = await userIdByEmail(invited.email)

  const [first, second] = await Promise.all([
    post(invitee, '/api/invitations/accept', { token: invited.token }),
    post(invitee, '/api/invitations/accept', { token: invited.token }),
  ])
  const statuses = [first.status, second.status].sort()
  assert.deepEqual(statuses, [200, 400])

  const memberships = await adminPool().query<{ count: string }>(
    'SELECT count(*)::text AS count FROM school_memberships WHERE school_id = $1 AND user_id = $2',
    [schoolA, userId],
  )
  assert.equal(memberships.rows[0]?.count, '1')
})

test('a different signed-in person cannot use the token', async () => {
  const invited = await inviteTeacher()
  const response = await post(parent, '/api/invitations/accept', {
    token: invited.token,
  })
  assert.equal(response.status, 400)
  assert.equal(
    ((await response.json()) as ErrorBody).error.code,
    'INVITATION_UNAVAILABLE',
  )
  const invitee = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM school_memberships sm
       JOIN auth_user u ON u.id = sm.user_id
      WHERE sm.school_id = $1 AND lower(u.email) = $2`,
    [schoolA, invited.email],
  )
  assert.equal(invitee.rows[0]?.count, '0')
})

test('a revoked invitation cannot be accepted', async () => {
  const invited = await inviteTeacher()
  const revoked = await post(
    owner,
    `/api/schools/${schoolA}/invitations/${invited.invitation.id}/revoke`,
    { expectedVersion: invited.invitation.version },
  )
  assert.equal(revoked.status, 200)
  const summary = (await revoked.json()) as Invitation
  assert.equal(summary.status, 'revoked')
  assert.equal(summary.version, 2)

  const invitee = await signInInvitee(invited.email)
  const response = await post(invitee, '/api/invitations/accept', {
    token: invited.token,
  })
  assert.equal(response.status, 400)
})

test('an expired invitation is marked expired when it is used', async () => {
  const invited = await inviteTeacher()
  await adminPool().query(
    `UPDATE school_invitations
        SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
      WHERE id = $1`,
    [invited.invitation.id],
  )
  const invitee = await signInInvitee(invited.email)
  const response = await post(invitee, '/api/invitations/accept', {
    token: invited.token,
  })
  assert.equal(response.status, 400)
  const stored = await adminPool().query<{ status: string }>(
    'SELECT status FROM school_invitations WHERE id = $1',
    [invited.invitation.id],
  )
  assert.equal(stored.rows[0]?.status, 'expired')
})

test('resending replaces the token', async () => {
  const invited = await inviteTeacher()
  const before = server.delivery.outbox.length
  const response = await post(
    owner,
    `/api/schools/${schoolA}/invitations/${invited.invitation.id}/resend`,
    { expectedVersion: invited.invitation.version },
  )
  assert.equal(response.status, 200)
  const summary = (await response.json()) as Invitation
  assert.equal(summary.version, 2)
  assert.equal(summary.status, 'pending')
  assert.equal(summary.deliveryStatus, 'sent')
  assert.equal(server.delivery.outbox.length, before + 1)

  const fresh = latestToken()
  assert.notEqual(fresh, invited.token)

  const invitee = await signInInvitee(invited.email)
  const stale = await post(invitee, '/api/invitations/accept', {
    token: invited.token,
  })
  assert.equal(stale.status, 400)
  const accepted = await post(invitee, '/api/invitations/accept', { token: fresh })
  assert.equal(accepted.status, 200)
})

test('an invitation dies with the authority behind it', async () => {
  const email = uniqueInviteEmail()
  const staffId = await createStaff(schoolA)
  const response = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'New Accountant',
    identifier: { kind: 'email', value: email },
    roleKeys: ['accountant'],
    staffId,
  })
  assert.equal(response.status, 201)
  const invitation = (await response.json()) as Invitation
  const token = latestToken()

  const pool = adminPool()
  try {
    await pool.query(
      'DELETE FROM membership_roles WHERE school_id = $1 AND membership_id = $2',
      [schoolA, ownerMembershipId],
    )
    await pool.query(
      'INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)',
      [schoolA, ownerMembershipId, await roleId(schoolA, 'teacher')],
    )
    const invitee = await signInInvitee(email)
    const accepted = await post(invitee, '/api/invitations/accept', { token })
    assert.equal(accepted.status, 400)
    const stored = await pool.query<{ status: string }>(
      'SELECT status FROM school_invitations WHERE id = $1',
      [invitation.id],
    )
    assert.equal(stored.rows[0]?.status, 'revoked')
  } finally {
    await pool.query(
      'DELETE FROM membership_roles WHERE school_id = $1 AND membership_id = $2',
      [schoolA, ownerMembershipId],
    )
    await pool.query(
      'INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)',
      [schoolA, ownerMembershipId, await roleId(schoolA, 'owner')],
    )
  }
})

test('a principal cannot invite an accountant', async () => {
  const principal = await signInWithMfa(server, {
    userId: principalUserId,
    email: PRINCIPAL_EMAIL,
    password: PASSWORD,
  })
  const response = await post(principal, `/api/schools/${schoolA}/invitations`, {
    displayName: 'Money Person',
    identifier: { kind: 'email', value: uniqueInviteEmail() },
    roleKeys: ['accountant'],
    staffId: await createStaff(schoolA),
  })
  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
})

test('a stale second factor cannot grant a privileged role', async () => {
  const pool = adminPool()
  await pool.query(
    `UPDATE auth_session SET mfa_verified_at = now() - interval '1 hour' WHERE user_id = $1`,
    [ownerUserId],
  )
  try {
    const response = await post(owner, `/api/schools/${schoolA}/invitations`, {
      displayName: 'New Admin',
      identifier: { kind: 'email', value: uniqueInviteEmail() },
      roleKeys: ['admin'],
      staffId: await createStaff(schoolA),
    })
    assert.equal(response.status, 403)
    assert.equal(
      ((await response.json()) as ErrorBody).error.code,
      'FRESH_AUTHENTICATION_REQUIRED',
    )
  } finally {
    await pool.query(
      'UPDATE auth_session SET mfa_verified_at = now() WHERE user_id = $1',
      [ownerUserId],
    )
  }
})

test('an invitation is refused when the details do not add up', async () => {
  const missingStaff = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'No Profile',
    identifier: { kind: 'email', value: uniqueInviteEmail() },
    roleKeys: ['teacher'],
  })
  assert.equal(missingStaff.status, 400)
  assert.equal(
    ((await missingStaff.json()) as ErrorBody).error.code,
    'INVALID_REQUEST',
  )

  const foreign = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'Wrong School',
    identifier: { kind: 'email', value: uniqueInviteEmail() },
    roleKeys: ['teacher'],
    staffId: await createStaff(schoolB),
  })
  assert.equal(foreign.status, 404)

  const linked = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'Already Linked',
    identifier: { kind: 'email', value: uniqueInviteEmail() },
    roleKeys: ['teacher'],
    staffId: linkedStaffId,
  })
  assert.equal(linked.status, 409)
  assert.equal(
    ((await linked.json()) as ErrorBody).error.code,
    'IDENTITY_LINK_CONFLICT',
  )

  const duplicateEmail = uniqueInviteEmail()
  const first = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'First Try',
    identifier: { kind: 'email', value: duplicateEmail },
    roleKeys: ['teacher'],
    staffId: await createStaff(schoolA),
  })
  assert.equal(first.status, 201)
  const second = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'Second Try',
    identifier: { kind: 'email', value: duplicateEmail },
    roleKeys: ['teacher'],
    staffId: await createStaff(schoolA),
  })
  assert.equal(second.status, 400)
  assert.equal(
    ((await second.json()) as ErrorBody).error.code,
    'INVITATION_UNAVAILABLE',
  )

  const alreadyMember = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'Owner Again',
    identifier: { kind: 'email', value: OWNER_EMAIL },
    roleKeys: ['teacher'],
    staffId: await createStaff(schoolA),
  })
  assert.equal(alreadyMember.status, 409)
})

test('a member without invite authority cannot create a login', async () => {
  // The fixture adult is a teacher in school A. Give it a fresh address so
  // this file does not fight the other files over the same identity.
  const teacherEmail = `invite-teacher-${randomUUID()}@example.test`
  await adminPool().query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    fixtureIds.adultUser,
    teacherEmail,
  ])
  await setFixturePassword(server, fixtureIds.adultUser as string, PASSWORD)
  const teacher = await signInWithPassword(server, teacherEmail, PASSWORD)

  const phone = `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const response = await post(teacher, `/api/schools/${schoolA}/invitations`, {
    displayName: 'Should Not Exist',
    identifier: { kind: 'phone', value: phone },
    roleKeys: ['parent'],
  })
  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
  // The refusal happened before any identity was provisioned, so this number
  // did not become eligible for OTP sign-in.
  const identity = await adminPool().query(
    'SELECT id FROM auth_user WHERE phone_number = $1',
    [phone],
  )
  assert.equal(identity.rows.length, 0)
})

test('a parent is invited by phone', async () => {
  const phone = `+9198${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`
  const before = server.delivery.outbox.length
  const response = await post(owner, `/api/schools/${schoolA}/invitations`, {
    displayName: 'New Parent',
    identifier: { kind: 'phone', value: phone },
    roleKeys: ['parent'],
  })
  assert.equal(response.status, 201)
  const body = (await response.json()) as Invitation
  assert.equal(body.deliveryStatus, 'sent')
  assert.ok(body.maskedDestination.includes('******'))
  assert.ok(!body.maskedDestination.includes(phone.slice(3, 8)))

  const message = server.delivery.outbox.slice(before)[0]
  assert.ok(message)
  assert.equal(message.channel, 'sms')
  assert.equal(message.to, phone)

  const identity = await adminPool().query<{ phone_number_verified: boolean }>(
    'SELECT phone_number_verified FROM auth_user WHERE phone_number = $1',
    [phone],
  )
  assert.equal(identity.rows[0]?.phone_number_verified, true)
})

test('an anonymous caller cannot accept an invitation', async () => {
  const response = await fetch(`${server.origin}/api/invitations/accept`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ token: `${schoolA}.${'a'.repeat(43)}` }),
  })
  assert.equal(response.status, 401)
})

interface InvitationList {
  items: Invitation[]
  total: number
  page: number
  pageSize: number
}

/** A second member of any school, so the fixture identities stay untouched. */
async function createRoleMember(
  schoolId: string,
  key: string,
  /**
   * A member that writes (invites) leaves an audit row behind, and audit
   * history is append-only, so its identity cannot be cleaned up afterwards.
   */
  retain = false,
): Promise<{ email: string; userId: string }> {
  const userId = randomUUID()
  const membershipId = randomUUID()
  const email = `invite-${key}-${randomUUID()}@example.test`
  if (!retain) {
    createdUsers.push(userId)
    createdMemberships.push(membershipId)
  }
  const pool = adminPool()
  await pool.query(
    `INSERT INTO auth_user (id, name, email) VALUES ($1, 'List Member', $2)`,
    [userId, email],
  )
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [membershipId, schoolId, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [schoolId, membershipId, await roleId(schoolId, key)],
  )
  await setFixturePassword(server, userId, PASSWORD)
  return { email, userId }
}

async function listInvitations(
  client: Client,
  schoolId: string,
  query = '',
): Promise<{ response: Response; text: string; body: InvitationList }> {
  const response = await client.fetch(`/api/schools/${schoolId}/invitations${query}`)
  const text = await response.text()
  return { response, text, body: JSON.parse(text) as InvitationList }
}

test('the invitation list shows pending invitations and never a token', async () => {
  const invited = await inviteTeacher()
  const listed = await listInvitations(owner, schoolA, '?pageSize=100')
  assert.equal(listed.response.status, 200)
  assert.equal(listed.body.page, 1)
  assert.equal(listed.body.pageSize, 100)
  assert.ok(listed.body.total >= 1)
  assert.ok(listed.body.items.length <= listed.body.total)

  const row = listed.body.items.find((item) => item.id === invited.invitation.id)
  assert.ok(row, 'the new invitation is missing from the default list')
  assert.equal(row.status, 'pending')
  assert.deepEqual(row.roleKeys, ['teacher'])
  assert.equal(row.maskedDestination, invited.invitation.maskedDestination)
  assert.ok(!listed.text.includes(invited.token))
  const digest = await adminPool().query<{ token_digest: string }>(
    'SELECT token_digest FROM school_invitations WHERE id = $1',
    [invited.invitation.id],
  )
  const stored = digest.rows[0]?.token_digest
  assert.ok(stored)
  assert.ok(!listed.text.includes(stored))
  assert.ok(!listed.text.includes('digest'))
})

test('a page of invitations agrees with its total', async () => {
  await inviteTeacher()
  await inviteTeacher()
  const first = await listInvitations(owner, schoolA, '?page=1&pageSize=1')
  assert.equal(first.body.items.length, 1)
  assert.equal(first.body.pageSize, 1)
  assert.ok(first.body.total >= 2)
  const second = await listInvitations(owner, schoolA, '?page=2&pageSize=1')
  assert.equal(second.body.items.length, 1)
  assert.equal(second.body.total, first.body.total)
  assert.notEqual(second.body.items[0]?.id, first.body.items[0]?.id)
})

test('an expired pending row leaves the pending list without being written', async () => {
  const invited = await inviteTeacher()
  await adminPool().query(
    `UPDATE school_invitations
        SET created_at = now() - interval '3 hours', expires_at = now() - interval '1 hour'
      WHERE id = $1`,
    [invited.invitation.id],
  )
  const pending = await listInvitations(owner, schoolA, '?pageSize=100')
  assert.equal(
    pending.body.items.some((item) => item.id === invited.invitation.id),
    false,
  )
  const expired = await listInvitations(owner, schoolA, '?status=expired&pageSize=100')
  const row = expired.body.items.find((item) => item.id === invited.invitation.id)
  assert.ok(row, 'the expired invitation is missing from the expired list')
  assert.equal(row.status, 'expired')
  // Reading reports the expiry; it does not write it.
  const stored = await adminPool().query<{ status: string }>(
    'SELECT status FROM school_invitations WHERE id = $1',
    [invited.invitation.id],
  )
  assert.equal(stored.rows[0]?.status, 'pending')
})

test('a revoked invitation appears only under the revoked status', async () => {
  const invited = await inviteTeacher()
  const revoked = await post(
    owner,
    `/api/schools/${schoolA}/invitations/${invited.invitation.id}/revoke`,
    { expectedVersion: invited.invitation.version },
  )
  assert.equal(revoked.status, 200)
  const pending = await listInvitations(owner, schoolA, '?pageSize=100')
  assert.equal(
    pending.body.items.some((item) => item.id === invited.invitation.id),
    false,
  )
  const list = await listInvitations(owner, schoolA, '?status=revoked&pageSize=100')
  const row = list.body.items.find((item) => item.id === invited.invitation.id)
  assert.ok(row)
  assert.equal(row.status, 'revoked')
})

test('the invitation list is refused without invite authority or the right school', async () => {
  const invited = await inviteTeacher()
  const teacher = await createRoleMember(schoolA, 'teacher')
  const teacherClient = await signInWithPassword(server, teacher.email, PASSWORD)
  const refused = await teacherClient.fetch(`/api/schools/${schoolA}/invitations`)
  assert.equal(refused.status, 403)
  assert.equal(((await refused.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  const principalB = await createRoleMember(schoolB, 'principal', true)
  const clientB = await signInWithMfa(server, {
    userId: principalB.userId,
    email: principalB.email,
    password: PASSWORD,
  })
  const crossSchool = await clientB.fetch(`/api/schools/${schoolA}/invitations`)
  assert.equal(crossSchool.status, 403)

  // A real pending row in school B, so the school filter is tested in both
  // directions: school B sees its own row and never school A's.
  const createdInB = await post(clientB, `/api/schools/${schoolB}/invitations`, {
    displayName: 'Other School Teacher',
    identifier: { kind: 'email', value: uniqueInviteEmail() },
    roleKeys: ['teacher'],
    staffId: await createStaff(schoolB),
  })
  assert.equal(createdInB.status, 201)
  const invitationB = (await createdInB.json()) as Invitation

  const own = await listInvitations(clientB, schoolB, '?pageSize=100')
  assert.equal(own.response.status, 200)
  assert.ok(
    own.body.items.some((item) => item.id === invitationB.id),
    "school B's own invitation is missing from its list",
  )
  assert.equal(
    own.body.items.some((item) => item.id === invited.invitation.id),
    false,
  )
  assert.ok(own.body.items.every((item) => item.schoolId === schoolB))

  const pendingInB = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM school_invitations
      WHERE school_id = $1 AND status = 'pending' AND expires_at > now()`,
    [schoolB],
  )
  assert.equal(own.body.total, Number(pendingInB.rows[0]?.count))
  assert.equal(own.body.items.length, own.body.total)
})
