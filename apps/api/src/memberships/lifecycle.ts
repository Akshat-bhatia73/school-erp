import type { Pool } from 'pg'
import {
  checkMembershipLifecycle,
  checkRoleAssignment,
  commitAccessChange,
  lockMembershipForAccessChange,
  type AuthzConnection,
} from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import {
  MEMBERSHIP_TRANSITIONS,
  MemberSummary,
  MembershipActionRequest,
  ROLE_TEMPLATES,
  RestoreMembershipRequest,
  type RoleKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { z } from 'zod'
import type { ApiPools } from '../db.ts'
import { ApiFailure } from '../http/errors.ts'
import { isFreshMfa } from '../auth/assurance.ts'
import { assertSchoolKeepsOwner, lockSchool, recordAuditEvent } from './audit.ts'
import { authorizeOnMembership, authorizeSchoolAction } from './authorize.ts'
import { loadMemberRow, resolveDisplayNames, toMemberSummary } from './directory.ts'
import type { MemberRow } from './directory.ts'

export interface LifecycleDependencies {
  readonly pools: ApiPools
}

/**
 * Bodies arrive as the raw string Better Auth needs, so every route parses
 * twice: once as JSON, once through the contract. Neither failure says why.
 */
export function parseBody<T>(raw: unknown, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): T {
  if (typeof raw !== 'string') throw new ApiFailure('INVALID_REQUEST')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new ApiFailure('INVALID_REQUEST')
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  return parsed.data
}

export function requiredParam(params: unknown, name: string): string {
  const value = (params as Record<string, unknown> | undefined)?.[name]
  if (typeof value !== 'string' || value.length === 0) throw new ApiFailure('INVALID_REQUEST')
  return value
}

/** The state machine is a contract; authority to move through it is separate. */
export function nextStatus(
  from: 'active' | 'suspended' | 'removed',
  event: 'suspend' | 'remove' | 'restore',
): 'active' | 'suspended' | 'removed' {
  const transition = MEMBERSHIP_TRANSITIONS.find(
    (entry) => entry.from === from && entry.event === event,
  )
  if (!transition) throw new ApiFailure('INVALID_REQUEST')
  return transition.to
}

/**
 * Handing someone a privileged role is the moment an account becomes worth
 * stealing, so the actor proves the second factor again. Roles the target
 * already holds are not re-granted and do not ask for a new proof.
 */
export function assertFreshMfaForAddedRoles(
  context: RequestContext,
  currentRoleKeys: readonly RoleKey[],
  proposedRoleKeys: readonly RoleKey[],
): void {
  const added = proposedRoleKeys.filter((role) => !currentRoleKeys.includes(role))
  if (!added.some((role) => ROLE_TEMPLATES[role].requiredMfa)) return
  if (!isFreshMfa(context.mfaVerifiedAt)) throw new ApiFailure('FRESH_AUTHENTICATION_REQUIRED')
}

/**
 * Replace the role set of one membership. Role ids are looked up by key in
 * this school only; an unknown key fails the request rather than falling back
 * to some other role. Teaching assignments are deliberately untouched.
 */
export async function replaceRoles(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
  actorMembershipId: string,
  proposedRoleKeys: readonly RoleKey[],
): Promise<void> {
  const wanted = [...new Set(proposedRoleKeys)]
  const found = await conn.client.query<{ id: string; key: string }>(
    `SELECT id, key FROM roles WHERE school_id = $1 AND key = ANY($2::text[])`,
    [schoolId, wanted],
  )
  if (found.rows.length !== wanted.length) throw new ApiFailure('INVALID_REQUEST')
  const roleIds = found.rows.map((row) => row.id)

  await conn.client.query(
    `DELETE FROM membership_roles
      WHERE school_id = $1 AND membership_id = $2 AND role_id <> ALL($3::uuid[])`,
    [schoolId, membershipId, roleIds],
  )
  for (const roleId of roleIds) {
    await conn.client.query(
      `INSERT INTO membership_roles (school_id, membership_id, role_id, assigned_by_membership_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (school_id, membership_id, role_id) DO NOTHING`,
      [schoolId, membershipId, roleId, actorMembershipId],
    )
  }
}

export async function loadTarget(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
): Promise<MemberRow> {
  const row = await loadMemberRow(conn, schoolId, membershipId)
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

/** The answer a caller sees is always re-read after the change committed. */
export async function freshSummary(
  conn: AuthzConnection,
  authPool: Pool,
  schoolId: string,
  membershipId: string,
): Promise<z.infer<typeof MemberSummary>> {
  const row = await loadTarget(conn, schoolId, membershipId)
  const names = await resolveDisplayNames(conn, authPool, schoolId, [row])
  return MemberSummary.parse(toMemberSummary(row, names.get(row.id) ?? 'Unnamed member'))
}

type LifecycleEvent = 'suspend' | 'remove' | 'restore'

const EVENT_PERMISSION = {
  suspend: 'members.suspend',
  remove: 'members.remove',
  restore: 'members.restore',
} as const

/**
 * Suspend, remove or restore one membership. Removal never deletes the
 * membership row, its staff link or its audit history: the record of who had
 * access has to survive the person leaving.
 */
export async function changeMembershipStatus(
  deps: LifecycleDependencies,
  context: RequestContext,
  membershipId: string,
  event: LifecycleEvent,
  rawBody: unknown,
): Promise<z.infer<typeof MemberSummary>> {
  // Restore is the only one that also states the reviewed role set.
  const restoreBody =
    event === 'restore' ? parseBody(rawBody, RestoreMembershipRequest) : null
  const body = restoreBody ?? parseBody(rawBody, MembershipActionRequest)
  const roleKeys: readonly RoleKey[] | undefined = restoreBody?.roleKeys

  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    // Serialise every access change in this school against the owner check.
    await lockSchool(conn, context.schoolId)
    await authorizeOnMembership(conn, context, EVENT_PERMISSION[event], membershipId)
    // Restoring also hands out roles, so it needs that authority as well.
    if (roleKeys) await authorizeSchoolAction(conn, context, 'roles.assign')

    const target = await loadTarget(conn, context.schoolId, membershipId)
    const lifecycle = checkMembershipLifecycle({
      actorMembershipId: context.membershipId,
      actorRoleKeys: context.roleKeys,
      targetMembershipId: target.id,
      targetRoleKeys: target.roleKeys,
    })
    if (!lifecycle.ok) throw new ApiFailure('ACCESS_DENIED')

    if (roleKeys) {
      const assignment = checkRoleAssignment({
        actorMembershipId: context.membershipId,
        actorRoleKeys: context.roleKeys,
        targetMembershipId: target.id,
        targetCurrentRoleKeys: target.roleKeys,
        proposedRoleKeys: roleKeys,
      })
      if (!assignment.ok) throw new ApiFailure('ACCESS_DENIED')
      assertFreshMfaForAddedRoles(context, target.roleKeys, roleKeys)
    }

    const to = nextStatus(target.status, event)
    const locked = await lockMembershipForAccessChange(
      conn,
      context.schoolId,
      membershipId,
      body.expectedVersion,
    )

    await conn.client.query(
      `UPDATE school_memberships SET status = $3 WHERE school_id = $1 AND id = $2`,
      [context.schoolId, membershipId, to],
    )

    let rulesRevoked = 0
    if (event === 'remove') {
      // An exception is a grant on top of a membership, so it ends with it.
      const revoked = await conn.client.query(
        `UPDATE resource_access_rules
            SET revoked_at = now(), version = version + 1, updated_at = now()
          WHERE school_id = $1 AND membership_id = $2 AND revoked_at IS NULL`,
        [context.schoolId, membershipId],
      )
      rulesRevoked = revoked.rowCount ?? 0
    }
    // Restore deliberately leaves expired or revoked exceptions alone: a
    // reviewed return of access is the role set, not the old exceptions.
    if (roleKeys) {
      await replaceRoles(conn, context.schoolId, membershipId, context.membershipId, roleKeys)
    }

    await assertSchoolKeepsOwner(conn, context.schoolId)
    await commitAccessChange(conn, context.schoolId, membershipId, locked.version)

    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: EVENT_PERMISSION[event],
      targetType: 'membership',
      targetId: membershipId,
      result: 'allowed',
      summary: `Membership status changed to ${to}.`,
      safeChanges: {
        status: { from: target.status, to },
        reason: body.reason,
        ...(roleKeys ? { roleKeys } : {}),
        ...(event === 'remove' ? { rulesRevoked } : {}),
      },
      requestId: context.requestId,
    })

    return freshSummary(conn, deps.pools.auth, context.schoolId, membershipId)
  })
}
