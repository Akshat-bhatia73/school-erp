import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../http/errors.ts'
import { createRequestContext } from './request-context.ts'
import { membershipRequiresMfa } from './assurance.ts'
import { resolveSession, type SessionDependencies, type VerifiedSession } from './session.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireSession(); never trust it without a guard. */
    verified?: VerifiedSession
    /** Set by requireMembership() only, for the school in the route. */
    context?: RequestContext
  }
}

export function requireSession(
  deps: SessionDependencies,
): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest) => {
    request.verified = await resolveSession(deps, request)
  }
}

/**
 * School selection is explicit in the path. The membership is re-read from the
 * database on every request, so a suspension denies the next one.
 */
export function requireMembership(
  deps: SessionDependencies,
): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest) => {
    const verified = request.verified ?? (await resolveSession(deps, request))
    request.verified = verified

    const params = request.params as { schoolId?: string }
    const schoolId = params?.schoolId
    const membership = verified.memberships.find(
      (entry) => entry.school.id === schoolId,
    )
    if (!membership) throw new ApiFailure('SCHOOL_ACCESS_UNAVAILABLE')

    if (
      membershipRequiresMfa(membership.roleKeys) &&
      verified.assurance !== 'mfa'
    ) {
      throw new ApiFailure('MFA_REQUIRED')
    }

    request.context = createRequestContext({
      requestId: request.id,
      userId: verified.user.id,
      sessionId: verified.session.id,
      schoolId: membership.school.id,
      membershipId: membership.id,
      membershipKind: membership.kind,
      accessVersion: membership.accessVersion,
      roleKeys: membership.roleKeys,
      assurance: verified.assurance,
      mfaVerifiedAt: verified.mfaVerifiedAt,
    })
  }
}
