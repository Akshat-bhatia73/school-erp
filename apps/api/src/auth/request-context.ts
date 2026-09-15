import type { RequestContext } from '@erp/contracts/server'
import type { RoleKey } from '@erp/contracts'

/**
 * The sole producer of RequestContext. Nothing else in the API may create one:
 * the branded type exists so that an unverified object cannot reach the policy
 * service. Only call this after the session, membership and roles have been
 * read from the database within this request.
 */
export interface VerifiedContextInput {
  requestId: string
  userId: string
  sessionId: string
  schoolId: string
  membershipId: string
  membershipKind: 'adult' | 'student'
  accessVersion: number
  roleKeys: readonly RoleKey[]
  assurance: 'single_factor' | 'mfa'
  mfaVerifiedAt: string | null
  now?: string
}

export function createRequestContext(
  input: VerifiedContextInput,
): RequestContext {
  const context = {
    requestId: input.requestId,
    userId: input.userId,
    sessionId: input.sessionId,
    schoolId: input.schoolId,
    membershipId: input.membershipId,
    membershipKind: input.membershipKind,
    accessVersion: input.accessVersion,
    roleKeys: Object.freeze([...input.roleKeys]),
    assurance: input.assurance,
    mfaVerifiedAt: input.mfaVerifiedAt,
    now: input.now ?? new Date().toISOString(),
  }
  // The brand is a compile-time marker; verification happened above the call.
  return Object.freeze(context) as unknown as RequestContext
}
