import { withTenantTransaction } from '@erp/db'
import { checkMembershipLifecycle } from '@erp/authz'
import { MembershipActionRequest } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { AuthInstance } from '../auth/better-auth.ts'
import type { ApiPools } from '../db.ts'
import { ApiFailure } from '../http/errors.ts'
import { recordAuditEvent } from './audit.ts'
import { authorizeOnMembership } from './authorize.ts'
import { loadTarget, parseBody } from './lifecycle.ts'

export interface RecoveryDependencies {
  readonly pools: ApiPools
  readonly auth: AuthInstance
}

/** A generated address nobody owns must never receive a reset token. */
const PLACEHOLDER_EMAIL_SUFFIX = '.invalid'

interface Plan {
  readonly channel: 'email' | 'sms'
  readonly email?: string
  readonly phoneNumber?: string
}

/**
 * Start credential recovery for another member. The recovery always goes to
 * the target's own address or number, never to the caller, and nothing about
 * the delivery is returned: an administrator can start a reset but cannot see
 * or use it.
 */
export async function startRecovery(
  deps: RecoveryDependencies,
  context: RequestContext,
  membershipId: string,
  rawBody: unknown,
): Promise<void> {
  const body = parseBody(rawBody, MembershipActionRequest)

  const plan = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await authorizeOnMembership(conn, context, 'members.manage_credentials', membershipId)
    const target = await loadTarget(conn, context.schoolId, membershipId)
    const lifecycle = checkMembershipLifecycle({
      actorMembershipId: context.membershipId,
      actorRoleKeys: context.roleKeys,
      targetMembershipId: target.id,
      targetRoleKeys: target.roleKeys,
    })
    if (!lifecycle.ok) throw new ApiFailure('ACCESS_DENIED')
    if (target.status !== 'active') throw new ApiFailure('INVALID_REQUEST')
    // Recovery changes no grant, so the version is only checked, never bumped.
    if (target.version !== body.expectedVersion) throw new ApiFailure('VERSION_CONFLICT')

    // auth_user is read through the auth credential, the only one allowed to
    // see it. The address itself never leaves this function.
    const identity = await deps.pools.auth.query<{
      email: string | null
      phone_number: string | null
    }>(`SELECT email, phone_number FROM auth_user WHERE id = $1`, [target.userId])
    const row = identity.rows[0]
    if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')

    const email =
      row.email && !row.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX) ? row.email : null
    const chosen: Plan | null = email
      ? { channel: 'email', email }
      : row.phone_number
        ? { channel: 'sms', phoneNumber: row.phone_number }
        : null
    if (!chosen) throw new ApiFailure('FEATURE_DISABLED')

    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: 'members.recovery',
      targetType: 'membership',
      targetId: membershipId,
      result: 'allowed',
      summary: 'Credential recovery was started for a school membership.',
      safeChanges: { reason: body.reason, channel: chosen.channel },
      requestId: context.requestId,
    })
    return chosen
  })

  try {
    if (plan.channel === 'email' && plan.email) {
      await deps.auth.api.requestPasswordReset({
        body: { email: plan.email, redirectTo: '/reset-password' },
      })
    } else if (plan.phoneNumber) {
      await deps.auth.api.requestPasswordResetPhoneNumber({
        body: { phoneNumber: plan.phoneNumber },
      })
    }
  } catch {
    // The decision already committed, so the failure is recorded rather than
    // silently dropped. No provider text is kept.
    await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
      await recordAuditEvent(conn, {
        schoolId: context.schoolId,
        actorUserId: context.userId,
        actorMembershipId: context.membershipId,
        action: 'members.recovery',
        targetType: 'membership',
        targetId: membershipId,
        result: 'failed',
        summary: 'Credential recovery delivery could not be started.',
        safeChanges: { reason: body.reason, channel: plan.channel },
        requestId: context.requestId,
      })
    })
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
}
