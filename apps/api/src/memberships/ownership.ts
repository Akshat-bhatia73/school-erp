import { withTenantTransaction } from '@erp/db'
import {
  commitAccessChange,
  lockMembershipForAccessChange,
  mayTransferOwnership,
  type AuthzConnection,
} from '@erp/authz'
import { MemberSummary, TransferOwnershipRequest } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { z } from 'zod'
import { ApiFailure } from '../http/errors.ts'
import { isFreshMfa } from '../auth/assurance.ts'
import { assertSchoolKeepsOwner, lockSchool, recordAuditEvent } from './audit.ts'
import { authorizeSchoolAction } from './authorize.ts'
import {
  freshSummary,
  loadTarget,
  parseBody,
  type LifecycleDependencies,
} from './lifecycle.ts'

/** The role the outgoing owner keeps when the transfer leaves them with none. */
const FALLBACK_ROLE = 'principal'

async function roleIdFor(
  conn: AuthzConnection,
  schoolId: string,
  key: string,
): Promise<string> {
  const result = await conn.client.query<{ id: string }>(
    `SELECT id FROM roles WHERE school_id = $1 AND key = $2`,
    [schoolId, key],
  )
  const id = result.rows[0]?.id
  if (!id) throw new ApiFailure('INVALID_REQUEST')
  return id
}

/**
 * Hand ownership of a school to another active adult membership.
 *
 * The school row carries its own access version so this whole workflow is one
 * optimistic unit: the caller states the version it read and a second transfer
 * that started from the same version loses.
 */
export async function transferOwnership(
  deps: LifecycleDependencies,
  context: RequestContext,
  rawBody: unknown,
): Promise<z.infer<typeof MemberSummary>> {
  const body = parseBody(rawBody, TransferOwnershipRequest)
  if (body.targetMembershipId === context.membershipId) {
    throw new ApiFailure('INVALID_REQUEST')
  }
  // Giving away a school is the most sensitive action there is, so the second
  // factor has to have been proven in the last few minutes.
  if (!isFreshMfa(context.mfaVerifiedAt)) {
    throw new ApiFailure('FRESH_AUTHENTICATION_REQUIRED')
  }

  // The candidate's identity is read through the auth credential, which is the
  // only connection allowed to see auth_user, and before the tenant
  // transaction opens.
  const targetUserId = await withTenantTransaction(
    deps.pools.runtime,
    context,
    async (conn) => {
      await authorizeSchoolAction(conn, context, 'ownership.transfer')
      if (!mayTransferOwnership(context.roleKeys)) throw new ApiFailure('ACCESS_DENIED')
      const target = await loadTarget(conn, context.schoolId, body.targetMembershipId)
      return target.userId
    },
  )
  const identity = await deps.pools.auth.query<{ two_factor_enabled: boolean }>(
    `SELECT two_factor_enabled FROM auth_user WHERE id = $1`,
    [targetUserId],
  )
  // An owner is always an MFA identity, so a candidate without a second factor
  // can never become one.
  if (identity.rows[0]?.two_factor_enabled !== true) throw new ApiFailure('ACCESS_DENIED')

  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    const school = await lockSchool(conn, context.schoolId)
    if (school.accessVersion !== body.expectedSchoolAccessVersion) {
      throw new ApiFailure('VERSION_CONFLICT')
    }
    await authorizeSchoolAction(conn, context, 'ownership.transfer')
    if (!mayTransferOwnership(context.roleKeys)) throw new ApiFailure('ACCESS_DENIED')

    const target = await loadTarget(conn, context.schoolId, body.targetMembershipId)
    if (target.userId !== targetUserId) throw new ApiFailure('VERSION_CONFLICT')
    if (target.status !== 'active' || target.kind !== 'adult') throw new ApiFailure('ACCESS_DENIED')
    if (target.roleKeys.includes('owner')) throw new ApiFailure('ACCESS_DENIED')

    const actor = await loadTarget(conn, context.schoolId, context.membershipId)

    // Both rows are locked in ascending id order, so two transfers in one
    // school can never deadlock against each other.
    const ordered = [actor, target].sort((left, right) => (left.id < right.id ? -1 : 1))
    for (const row of ordered) {
      await lockMembershipForAccessChange(conn, context.schoolId, row.id, row.version)
    }

    const ownerRoleId = await roleIdFor(conn, context.schoolId, 'owner')
    await conn.client.query(
      `INSERT INTO membership_roles (school_id, membership_id, role_id, assigned_by_membership_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (school_id, membership_id, role_id) DO NOTHING`,
      [context.schoolId, target.id, ownerRoleId, context.membershipId],
    )
    await conn.client.query(
      `DELETE FROM membership_roles
        WHERE school_id = $1 AND membership_id = $2 AND role_id = $3`,
      [context.schoolId, actor.id, ownerRoleId],
    )
    // The outgoing owner stays in the school. A membership with no role grants
    // nothing and would disappear from the directory, so when ownership was
    // their only role they are demoted to principal rather than left blank.
    const remaining = actor.roleKeys.filter((role) => role !== 'owner')
    if (remaining.length === 0) {
      const fallbackRoleId = await roleIdFor(conn, context.schoolId, FALLBACK_ROLE)
      await conn.client.query(
        `INSERT INTO membership_roles (school_id, membership_id, role_id, assigned_by_membership_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (school_id, membership_id, role_id) DO NOTHING`,
        [context.schoolId, actor.id, fallbackRoleId, context.membershipId],
      )
    }

    await conn.client.query(
      `UPDATE schools SET access_version = access_version + 1 WHERE id = $1`,
      [context.schoolId],
    )
    for (const row of ordered) {
      await commitAccessChange(conn, context.schoolId, row.id, row.version)
    }
    await assertSchoolKeepsOwner(conn, context.schoolId)

    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: 'ownership.transfer',
      targetType: 'school_ownership',
      targetId: context.schoolId,
      result: 'allowed',
      summary: 'School ownership was transferred to another membership.',
      safeChanges: {
        fromMembershipId: actor.id,
        toMembershipId: target.id,
        reason: body.reason,
      },
      requestId: context.requestId,
    })

    return freshSummary(conn, deps.pools.auth, context.schoolId, target.id)
  })
}
