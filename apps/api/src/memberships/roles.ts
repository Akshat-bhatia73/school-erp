import { withTenantTransaction } from '@erp/db'
import { checkRoleAssignment } from '@erp/authz'
import { ChangeRolesRequest, MemberSummary } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { z } from 'zod'
import { ApiFailure } from '../http/errors.ts'
import { assertSchoolKeepsOwner, lockSchool, recordAuditEvent } from './audit.ts'
import { authorizeOnMembership } from './authorize.ts'
import {
  assertFreshMfaForAddedRoles,
  freshSummary,
  loadTarget,
  parseBody,
  replaceRoles,
  type LifecycleDependencies,
} from './lifecycle.ts'
import { commitAccessChange, lockMembershipForAccessChange } from '@erp/authz'

/**
 * Change the roles of one membership. Ownership is not reachable here: the
 * contract's assignable role list excludes it and the delegation rules refuse
 * a target that holds it.
 */
export async function changeRoles(
  deps: LifecycleDependencies,
  context: RequestContext,
  membershipId: string,
  rawBody: unknown,
): Promise<z.infer<typeof MemberSummary>> {
  const body = parseBody(rawBody, ChangeRolesRequest)

  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    // Serialise every access change in this school against the owner check.
    await lockSchool(conn, context.schoolId)
    await authorizeOnMembership(conn, context, 'roles.assign', membershipId)

    const target = await loadTarget(conn, context.schoolId, membershipId)
    // Roles are only reviewed on a live membership; a suspended or removed
    // one is restored first, which is its own reviewed decision.
    if (target.status !== 'active') throw new ApiFailure('INVALID_REQUEST')

    const delegation = checkRoleAssignment({
      actorMembershipId: context.membershipId,
      actorRoleKeys: context.roleKeys,
      targetMembershipId: target.id,
      targetCurrentRoleKeys: target.roleKeys,
      proposedRoleKeys: body.roleKeys,
    })
    if (!delegation.ok) throw new ApiFailure('ACCESS_DENIED')
    assertFreshMfaForAddedRoles(context, target.roleKeys, body.roleKeys)

    const locked = await lockMembershipForAccessChange(
      conn,
      context.schoolId,
      membershipId,
      body.expectedVersion,
    )
    await replaceRoles(conn, context.schoolId, membershipId, context.membershipId, body.roleKeys)
    await assertSchoolKeepsOwner(conn, context.schoolId)
    await commitAccessChange(conn, context.schoolId, membershipId, locked.version)

    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: 'roles.assign',
      targetType: 'membership',
      targetId: membershipId,
      result: 'allowed',
      summary: 'Roles changed for a school membership.',
      safeChanges: {
        roleKeys: { from: target.roleKeys, to: body.roleKeys },
        reason: body.reason,
      },
      requestId: context.requestId,
    })

    return freshSummary(conn, deps.pools.auth, context.schoolId, membershipId)
  })
}
