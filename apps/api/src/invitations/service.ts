import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { withTenantTransaction } from '@erp/db'
import {
  assignableRolesFor,
  loadMembershipStateById,
  loadRoleKeys,
  type AuthzConnection,
} from '@erp/authz'
import {
  InvitationSummary,
  MemberSummary,
  ROLE_TEMPLATES,
  type ContactIdentifier,
  type ErrorCode,
  type InviteMemberRequest,
  type RoleKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { z } from 'zod'
import { ApiFailure } from '../http/errors.ts'
import { isFreshMfa } from '../auth/assurance.ts'
import { createRequestContext } from '../auth/request-context.ts'
import type { VerifiedSession } from '../auth/session.ts'
import type { DeliveryChannel } from '../delivery/types.ts'
import {
  provisionEmailIdentity,
  provisionPhoneIdentity,
} from '../identity/provision.ts'
import {
  assertSchoolKeepsOwner,
  lockSchool,
  recordAuditEvent,
} from '../memberships/audit.ts'
import { authorizeSchoolAction } from '../memberships/authorize.ts'
import {
  loadMemberRow,
  resolveDisplayNames,
  toMemberSummary,
} from '../memberships/directory.ts'
import type { AccessDependencies } from '../memberships/routes.ts'
import {
  createInvitationToken,
  INVITATION_TTL_HOURS,
  maskDestination,
  parseInvitationToken,
} from './tokens.ts'

type Summary = z.infer<typeof InvitationSummary>
type Member = z.infer<typeof MemberSummary>
type DeliveryState = 'queued' | 'sent' | 'failed'

interface InvitationRow {
  id: string
  school_id: string
  display_name: string
  identifier_type: 'email' | 'phone'
  identifier_normalized: string
  destination_masked: string
  proposed_role_keys: string[]
  staff_id: string | null
  inviter_membership_id: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expires_at: Date
  version: number
}

const INVITATION_COLUMNS = `id, school_id, display_name, identifier_type, identifier_normalized,
  destination_masked, proposed_role_keys, staff_id, inviter_membership_id, status, expires_at, version`

/** The same columns, qualified for the list query's join. */
const ALIASED_INVITATION_COLUMNS = INVITATION_COLUMNS.split(',')
  .map((column) => `i.${column.trim()}`)
  .join(', ')

function channelFor(kind: 'email' | 'phone'): DeliveryChannel {
  return kind === 'email' ? 'email' : 'sms'
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  )
}

function asRoleKeys(values: readonly string[]): RoleKey[] {
  // The database constraint already limits these to known assignable keys.
  return [...values] as RoleKey[]
}

function toSummary(row: InvitationRow, deliveryStatus: DeliveryState): Summary {
  // A pending row past its expiry is reported as expired without writing: the
  // write happens when somebody actually tries to use it.
  const expired =
    row.status === 'pending' && new Date(row.expires_at).getTime() <= Date.now()
  return InvitationSummary.parse({
    id: row.id,
    schoolId: row.school_id,
    displayName: row.display_name,
    maskedDestination: row.destination_masked,
    roleKeys: asRoleKeys(row.proposed_role_keys),
    status: expired ? 'expired' : row.status,
    deliveryStatus,
    expiresAt: new Date(row.expires_at).toISOString(),
    version: Number(row.version),
  })
}

/**
 * The school's invitations, newest first. A pending row past its expiry reads
 * as expired in both the filter and the response without being written, so a
 * read never changes a row. No audit row: this is a read.
 */
export async function listInvitations(
  deps: AccessDependencies,
  context: RequestContext,
  query: { status: Summary['status']; page: number; pageSize: number },
): Promise<{ items: Summary[]; total: number }> {
  // One expression decides the reported status, so WHERE and SELECT agree.
  const effective = `CASE WHEN i.status = 'pending' AND i.expires_at <= now()
                          THEN 'expired' ELSE i.status::text END`
  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await authorizeSchoolAction(conn, context, 'members.invite')
    const total = await conn.client.query<{ total: string }>(
      `SELECT count(*)::text AS total FROM school_invitations i
        WHERE i.school_id = $1 AND ${effective} = $2::text`,
      [context.schoolId, query.status],
    )
    const result = await conn.client.query<InvitationRow & { delivery_status: string | null }>(
      `SELECT ${ALIASED_INVITATION_COLUMNS},
              d.status AS delivery_status
         FROM school_invitations i
         LEFT JOIN LATERAL (
           SELECT o.status FROM delivery_outbox o
            WHERE o.school_id = i.school_id AND o.event_type = 'invitation'
              AND o.payload->>'invitationId' = i.id::text
            ORDER BY o.created_at DESC LIMIT 1
         ) d ON true
        WHERE i.school_id = $1 AND ${effective} = $2::text
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT $3 OFFSET $4`,
      [context.schoolId, query.status, query.pageSize, (query.page - 1) * query.pageSize],
    )
    const items = result.rows.map((row) => {
      const state: DeliveryState =
        row.delivery_status === 'sent' || row.delivery_status === 'failed'
          ? row.delivery_status
          : 'queued'
      return toSummary(row, state)
    })
    return { items, total: Number(total.rows[0]?.total ?? '0') }
  })
}

/** The actor may only hand out roles the delegation policy lets them hand out. */
function assertDelegable(
  actorRoleKeys: readonly RoleKey[],
  proposed: readonly RoleKey[],
): void {
  const assignable = assignableRolesFor(actorRoleKeys)
  if (proposed.some((role) => !assignable.includes(role))) {
    throw new ApiFailure('ACCESS_DENIED')
  }
}

/**
 * Granting a privileged role needs proof that the same person is still at the
 * keyboard, not just that they signed in with a second factor hours ago.
 */
function assertFreshMfaForRoles(
  context: RequestContext,
  proposed: readonly RoleKey[],
): void {
  const privileged = proposed.some((role) => ROLE_TEMPLATES[role].requiredMfa)
  if (privileged && !isFreshMfa(context.mfaVerifiedAt)) {
    throw new ApiFailure('FRESH_AUTHENTICATION_REQUIRED')
  }
}

async function assertStaffAvailable(
  client: PoolClient,
  schoolId: string,
  staffId: string | undefined,
): Promise<void> {
  if (!staffId) return
  const staff = await client.query<{ id: string }>(
    `SELECT id FROM staff WHERE school_id = $1 AND id = $2`,
    [schoolId, staffId],
  )
  if (staff.rows.length === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const linked = await client.query<{ membership_id: string }>(
    `SELECT membership_id FROM membership_staff_links WHERE school_id = $1 AND staff_id = $2`,
    [schoolId, staffId],
  )
  if (linked.rows.length > 0) throw new ApiFailure('IDENTITY_LINK_CONFLICT')
}

/** Rejoining is a restore decision about an existing row, not a new invitation. */
async function assertNoMembership(
  client: PoolClient,
  schoolId: string,
  userId: string,
): Promise<void> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM school_memberships WHERE school_id = $1 AND user_id = $2`,
    [schoolId, userId],
  )
  if (existing.rows.length > 0) throw new ApiFailure('IDENTITY_LINK_CONFLICT')
}

async function assertNoPendingInvitation(
  client: PoolClient,
  schoolId: string,
  identifier: ContactIdentifier,
): Promise<void> {
  const pending = await client.query<{ id: string }>(
    `SELECT id FROM school_invitations
      WHERE school_id = $1 AND identifier_type = $2 AND identifier_normalized = $3
        AND status = 'pending'`,
    [schoolId, identifier.kind, identifier.value],
  )
  if (pending.rows.length > 0) throw new ApiFailure('INVITATION_UNAVAILABLE')
}

/**
 * Finds the login this invitation is addressed to, creating one when the
 * person has never signed in here. An email identity gets a random password
 * nobody knows: the person proves control of the mailbox through the ordinary
 * password reset flow. If the tenant transaction below then fails, a login
 * without any membership is left behind. It can enter no school, so it is
 * harmless, and the next invitation reuses it.
 */
async function findOrProvisionUser(
  deps: AccessDependencies,
  identifier: ContactIdentifier,
  displayName: string,
): Promise<string> {
  const existing =
    identifier.kind === 'email'
      ? await deps.pools.auth.query<{ id: string }>(
          `SELECT id FROM auth_user WHERE lower(email) = $1`,
          [identifier.value],
        )
      : await deps.pools.auth.query<{ id: string }>(
          `SELECT id FROM auth_user WHERE phone_number = $1`,
          [identifier.value],
        )
  const found = existing.rows[0]
  if (found) return found.id

  if (identifier.kind === 'email') {
    const provisioned = await provisionEmailIdentity(deps.auth, {
      name: displayName,
      email: identifier.value,
      password: randomBytes(36).toString('base64url').slice(0, 48),
    })
    return provisioned.userId
  }
  const provisioned = await provisionPhoneIdentity(deps.auth, {
    name: displayName,
    phone: identifier.value,
  })
  return provisioned.userId
}

/**
 * Sends the single-use token and records what happened to the outbox row. The
 * token itself is never stored, logged or returned in the response.
 */
async function deliverAndRecord(
  deps: AccessDependencies,
  context: RequestContext,
  input: { outboxId: string; channel: DeliveryChannel; to: string; token: string },
): Promise<DeliveryState> {
  let state: DeliveryState = 'sent'
  try {
    await deps.delivery.send({
      channel: input.channel,
      to: input.to,
      purpose: 'invitation',
      secret: input.token,
    })
  } catch {
    state = 'failed'
  }
  await withTenantTransaction(deps.pools.runtime, context, async ({ client }) => {
    if (state === 'sent') {
      await client.query(
        `UPDATE delivery_outbox
            SET status = 'sent', delivered_at = now(), attempts = attempts + 1
          WHERE school_id = $1 AND id = $2`,
        [context.schoolId, input.outboxId],
      )
      return
    }
    await client.query(
      `UPDATE delivery_outbox
          SET status = 'failed', last_error = 'delivery failed', attempts = attempts + 1
        WHERE school_id = $1 AND id = $2`,
      [context.schoolId, input.outboxId],
    )
  })
  return state
}

async function queueDelivery(
  client: PoolClient,
  schoolId: string,
  input: { invitationId: string; channel: DeliveryChannel; masked: string },
): Promise<string> {
  const outbox = await client.query<{ id: string }>(
    `INSERT INTO delivery_outbox (school_id, event_type, destination, payload)
     VALUES ($1, 'invitation', $2, $3::jsonb)
     RETURNING id`,
    [
      schoolId,
      input.masked,
      JSON.stringify({ invitationId: input.invitationId, channel: input.channel }),
    ],
  )
  const row = outbox.rows[0]
  if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return row.id
}

/**
 * Everything that can refuse an invitation before a row exists. It runs twice:
 * once before an identity is provisioned, so a caller without the authority
 * can never cause a login to be created, and again inside the write
 * transaction, so nothing changed in between.
 */
async function assertMayInvite(
  conn: AuthzConnection,
  context: RequestContext,
  input: InviteMemberRequest,
  identifier: ContactIdentifier,
): Promise<void> {
  await authorizeSchoolAction(conn, context, 'members.invite')
  await authorizeSchoolAction(conn, context, 'roles.assign')
  assertDelegable(context.roleKeys, input.roleKeys)
  assertFreshMfaForRoles(context, input.roleKeys)
  await assertStaffAvailable(conn.client, context.schoolId, input.staffId)
  await assertNoPendingInvitation(conn.client, context.schoolId, identifier)
}

export async function createInvitation(
  deps: AccessDependencies,
  context: RequestContext,
  input: InviteMemberRequest,
): Promise<Summary> {
  const identifier: ContactIdentifier =
    input.identifier.kind === 'email'
      ? { kind: 'email', value: input.identifier.value.toLowerCase() }
      : { kind: 'phone', value: input.identifier.value }

  // Provisioning an identity is a global side effect (a phone identity becomes
  // eligible for OTP sign-in), so the caller's authority is settled first.
  await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await assertMayInvite(conn, context, input, identifier)
  })
  const userId = await findOrProvisionUser(deps, identifier, input.displayName)

  const prepared = await withTenantTransaction(
    deps.pools.runtime,
    context,
    async (conn) => {
      await assertMayInvite(conn, context, input, identifier)
      await assertNoMembership(conn.client, context.schoolId, userId)
      const token = createInvitationToken(context.schoolId)
      const masked = maskDestination(identifier.kind, identifier.value)
      const inserted = await conn.client
        .query<InvitationRow>(
          `INSERT INTO school_invitations
             (school_id, display_name, identifier_type, identifier_normalized,
              destination_masked, token_digest, proposed_role_keys, staff_id,
              inviter_membership_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9,
                   now() + make_interval(hours => $10))
           RETURNING ${INVITATION_COLUMNS}`,
          [
            context.schoolId,
            input.displayName,
            identifier.kind,
            identifier.value,
            masked,
            token.digest,
            input.roleKeys,
            input.staffId ?? null,
            context.membershipId,
            INVITATION_TTL_HOURS,
          ],
        )
        .catch((error: unknown) => {
          // The partial unique index is the backstop for a racing duplicate.
          if (isUniqueViolation(error)) throw new ApiFailure('INVITATION_UNAVAILABLE')
          throw error
        })
      const row = inserted.rows[0]
      if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')

      const channel = channelFor(identifier.kind)
      const outboxId = await queueDelivery(conn.client, context.schoolId, {
        invitationId: row.id,
        channel,
        masked,
      })
      await recordAuditEvent(conn, {
        schoolId: context.schoolId,
        actorUserId: context.userId,
        actorMembershipId: context.membershipId,
        action: 'members.invite',
        targetType: 'invitation',
        targetId: row.id,
        result: 'allowed',
        summary: 'An invitation was created.',
        safeChanges: {
          roleKeys: input.roleKeys,
          staffId: input.staffId ?? null,
          identifierType: identifier.kind,
        },
        requestId: context.requestId,
      })
      return { row, outboxId, channel, token: token.token, to: identifier.value }
    },
  )

  const state = await deliverAndRecord(deps, context, {
    outboxId: prepared.outboxId,
    channel: prepared.channel,
    to: prepared.to,
    token: prepared.token,
  })
  return toSummary(prepared.row, state)
}

async function lockInvitation(
  client: PoolClient,
  schoolId: string,
  invitationId: string,
  expectedVersion: number,
): Promise<InvitationRow> {
  const result = await client.query<InvitationRow>(
    `SELECT ${INVITATION_COLUMNS} FROM school_invitations
      WHERE school_id = $1 AND id = $2
      FOR UPDATE`,
    [schoolId, invitationId],
  )
  const row = result.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  if (row.status !== 'pending') throw new ApiFailure('INVITATION_UNAVAILABLE')
  if (Number(row.version) !== expectedVersion) throw new ApiFailure('VERSION_CONFLICT')
  return row
}

export async function resendInvitation(
  deps: AccessDependencies,
  context: RequestContext,
  invitationId: string,
  expectedVersion: number,
): Promise<Summary> {
  const prepared = await withTenantTransaction(
    deps.pools.runtime,
    context,
    async (conn) => {
      await authorizeSchoolAction(conn, context, 'members.invite')
      await authorizeSchoolAction(conn, context, 'roles.assign')
      const row = await lockInvitation(
        conn.client,
        context.schoolId,
        invitationId,
        expectedVersion,
      )
      // An inviter who has since lost the authority cannot send it again.
      const roleKeys = asRoleKeys(row.proposed_role_keys)
      assertDelegable(context.roleKeys, roleKeys)
      assertFreshMfaForRoles(context, roleKeys)

      const token = createInvitationToken(context.schoolId)
      // The previous token stops working because the digest changed.
      const updated = await conn.client.query<InvitationRow>(
        `UPDATE school_invitations
            SET token_digest = $3,
                expires_at = now() + make_interval(hours => $4),
                version = version + 1,
                updated_at = now()
          WHERE school_id = $1 AND id = $2
        RETURNING ${INVITATION_COLUMNS}`,
        [context.schoolId, invitationId, token.digest, INVITATION_TTL_HOURS],
      )
      const next = updated.rows[0]
      if (!next) throw new ApiFailure('SERVICE_UNAVAILABLE')

      const channel = channelFor(row.identifier_type)
      const outboxId = await queueDelivery(conn.client, context.schoolId, {
        invitationId: row.id,
        channel,
        masked: row.destination_masked,
      })
      await recordAuditEvent(conn, {
        schoolId: context.schoolId,
        actorUserId: context.userId,
        actorMembershipId: context.membershipId,
        action: 'members.invite.resend',
        targetType: 'invitation',
        targetId: row.id,
        result: 'allowed',
        summary: 'An invitation was sent again with a new token.',
        safeChanges: {
          roleKeys,
          staffId: row.staff_id,
          identifierType: row.identifier_type,
        },
        requestId: context.requestId,
      })
      return {
        row: next,
        outboxId,
        channel,
        token: token.token,
        to: row.identifier_normalized,
      }
    },
  )

  const state = await deliverAndRecord(deps, context, {
    outboxId: prepared.outboxId,
    channel: prepared.channel,
    to: prepared.to,
    token: prepared.token,
  })
  return toSummary(prepared.row, state)
}

export async function revokeInvitation(
  deps: AccessDependencies,
  context: RequestContext,
  invitationId: string,
  expectedVersion: number,
): Promise<Summary> {
  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await authorizeSchoolAction(conn, context, 'members.invite')
    const row = await lockInvitation(
      conn.client,
      context.schoolId,
      invitationId,
      expectedVersion,
    )
    const updated = await conn.client.query<InvitationRow>(
      `UPDATE school_invitations
          SET status = 'revoked', version = version + 1, updated_at = now()
        WHERE school_id = $1 AND id = $2
      RETURNING ${INVITATION_COLUMNS}`,
      [context.schoolId, invitationId],
    )
    const next = updated.rows[0]
    if (!next) throw new ApiFailure('SERVICE_UNAVAILABLE')

    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: 'members.invite.revoke',
      targetType: 'invitation',
      targetId: row.id,
      result: 'allowed',
      summary: 'An invitation was revoked.',
      safeChanges: {
        roleKeys: asRoleKeys(row.proposed_role_keys),
        staffId: row.staff_id,
        identifierType: row.identifier_type,
      },
      requestId: context.requestId,
    })

    const delivery = await conn.client.query<{ status: string }>(
      `SELECT status FROM delivery_outbox
        WHERE school_id = $1 AND event_type = 'invitation'
          AND payload->>'invitationId' = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [context.schoolId, invitationId],
    )
    const status = delivery.rows[0]?.status
    const state: DeliveryState =
      status === 'sent' || status === 'failed' ? status : 'queued'
    return toSummary(next, state)
  })
}

type AcceptOutcome =
  | { ok: true; member: Member }
  | { ok: false; code: ErrorCode }

/**
 * The invitee identifies themselves with their own session; the link alone is
 * never enough. Failures that must be remembered (an expiry, a revocation)
 * are returned as an outcome so the transaction commits, and only then does
 * the request fail.
 */
export async function acceptInvitation(
  deps: AccessDependencies,
  verified: VerifiedSession,
  requestId: string,
  token: string,
): Promise<Member> {
  const parsed = parseInvitationToken(token)
  if (!parsed) throw new ApiFailure('INVITATION_UNAVAILABLE')

  // Read through the auth credential only; it may not touch tenant tables.
  const account = await deps.pools.auth.query<{
    phone_number: string | null
    phone_number_verified: boolean
  }>(
    `SELECT phone_number, phone_number_verified FROM auth_user WHERE id = $1`,
    [verified.user.id],
  )
  const phone = account.rows[0]

  // A placeholder context, only so the tenant transaction can be opened for
  // the school named in the token. It carries no roles and must never be
  // handed to the evaluator.
  const context = createRequestContext({
    requestId,
    userId: verified.user.id,
    sessionId: verified.session.id,
    schoolId: parsed.schoolId,
    membershipId: '',
    membershipKind: 'adult',
    accessVersion: 1,
    roleKeys: [],
    assurance: verified.assurance,
    mfaVerifiedAt: verified.mfaVerifiedAt,
  })

  const outcome = await withTenantTransaction(
    deps.pools.runtime,
    context,
    async (conn): Promise<AcceptOutcome> => {
      await lockSchool(conn, parsed.schoolId)
      const found = await conn.client.query<InvitationRow>(
        `SELECT ${INVITATION_COLUMNS} FROM school_invitations
          WHERE school_id = $1 AND token_digest = $2
          FOR UPDATE`,
        [parsed.schoolId, parsed.digest],
      )
      const row = found.rows[0]
      if (!row || row.status !== 'pending') {
        return { ok: false, code: 'INVITATION_UNAVAILABLE' }
      }
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await conn.client.query(
          `UPDATE school_invitations
              SET status = 'expired', version = version + 1, updated_at = now()
            WHERE school_id = $1 AND id = $2`,
          [parsed.schoolId, row.id],
        )
        return { ok: false, code: 'INVITATION_UNAVAILABLE' }
      }

      // Holding the link is not proof of who you are. The signed-in identity
      // must be the one the invitation was addressed to. The answer never
      // says which half did not match.
      const matches =
        row.identifier_type === 'email'
          ? verified.user.email.toLowerCase() === row.identifier_normalized &&
            !verified.user.email.toLowerCase().endsWith('.invalid')
          : phone?.phone_number === row.identifier_normalized &&
            phone.phone_number_verified === true
      if (!matches) return { ok: false, code: 'INVITATION_UNAVAILABLE' }

      const roleKeys = asRoleKeys(row.proposed_role_keys)
      const inviter = await loadMembershipStateById(
        conn,
        parsed.schoolId,
        row.inviter_membership_id,
      )
      const inviterRoleKeys = inviter
        ? await loadRoleKeys(conn, parsed.schoolId, row.inviter_membership_id)
        : []
      const assignable = assignableRolesFor(inviterRoleKeys)
      if (
        !inviter ||
        inviter.status !== 'active' ||
        roleKeys.some((role) => !assignable.includes(role))
      ) {
        // The authority behind this invitation is gone, so the invitation is.
        await conn.client.query(
          `UPDATE school_invitations
              SET status = 'revoked', version = version + 1, updated_at = now()
            WHERE school_id = $1 AND id = $2`,
          [parsed.schoolId, row.id],
        )
        await recordAuditEvent(conn, {
          schoolId: parsed.schoolId,
          actorUserId: verified.user.id,
          actorMembershipId: null,
          action: 'members.invite.accept',
          targetType: 'invitation',
          targetId: row.id,
          result: 'denied',
          summary: 'An invitation was refused because the inviter lost authority.',
          safeChanges: {
            roleKeys,
            inviterMembershipId: row.inviter_membership_id,
          },
          requestId,
        })
        return { ok: false, code: 'INVITATION_UNAVAILABLE' }
      }

      await assertNoMembership(conn.client, parsed.schoolId, verified.user.id)
      await assertStaffAvailable(conn.client, parsed.schoolId, row.staff_id ?? undefined)

      const created = await conn.client.query<{ id: string }>(
        `INSERT INTO school_memberships (school_id, user_id, kind, status)
         VALUES ($1, $2, 'adult', 'active')
         RETURNING id`,
        [parsed.schoolId, verified.user.id],
      )
      const membershipId = created.rows[0]?.id
      if (!membershipId) throw new ApiFailure('SERVICE_UNAVAILABLE')

      const roles = await conn.client.query<{ id: string; key: string }>(
        `SELECT id, key FROM roles WHERE school_id = $1 AND key = ANY($2::text[])`,
        [parsed.schoolId, roleKeys],
      )
      if (roles.rows.length !== roleKeys.length) {
        throw new ApiFailure('RESOURCE_NOT_FOUND')
      }
      for (const role of roles.rows) {
        await conn.client.query(
          `INSERT INTO membership_roles
             (school_id, membership_id, role_id, assigned_by_membership_id)
           VALUES ($1, $2, $3, $4)`,
          [parsed.schoolId, membershipId, role.id, row.inviter_membership_id],
        )
      }
      if (row.staff_id) {
        await conn.client.query(
          `INSERT INTO membership_staff_links (school_id, membership_id, staff_id)
           VALUES ($1, $2, $3)`,
          [parsed.schoolId, membershipId, row.staff_id],
        )
      }
      await conn.client.query(
        `UPDATE school_invitations
            SET status = 'accepted', accepted_at = now(), version = version + 1,
                updated_at = now()
          WHERE school_id = $1 AND id = $2`,
        [parsed.schoolId, row.id],
      )
      await assertSchoolKeepsOwner(conn, parsed.schoolId)
      await recordAuditEvent(conn, {
        schoolId: parsed.schoolId,
        actorUserId: verified.user.id,
        actorMembershipId: membershipId,
        action: 'members.invite.accept',
        targetType: 'invitation',
        targetId: row.id,
        result: 'allowed',
        summary: 'An invitation was accepted and a membership was created.',
        safeChanges: {
          roleKeys,
          staffId: row.staff_id,
          inviterMembershipId: row.inviter_membership_id,
        },
        requestId,
      })

      const member = await loadMemberRow(conn, parsed.schoolId, membershipId)
      if (!member) throw new ApiFailure('SERVICE_UNAVAILABLE')
      const names = await resolveDisplayNames(
        conn,
        deps.pools.auth,
        parsed.schoolId,
        [member],
      )
      return {
        ok: true,
        member: toMemberSummary(member, names.get(member.id) ?? 'Unnamed member'),
      }
    },
  ).catch((error: unknown) => {
    // A racing accept loses the (school_id, user_id) uniqueness check.
    if (isUniqueViolation(error)) throw new ApiFailure('IDENTITY_LINK_CONFLICT')
    throw error
  })

  if (!outcome.ok) throw new ApiFailure(outcome.code)
  return outcome.member
}
