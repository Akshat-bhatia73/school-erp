import type { FastifyInstance } from 'fastify'
import { Email, MeResponse, Phone, SchoolContextResponse } from '@erp/contracts'
import type { SchoolAuthorizationService } from '@erp/authz'
import { ApiFailure } from '../http/errors.ts'
import { requireMembership, requireSession } from '../auth/guards.ts'
import type { SessionDependencies } from '../auth/session.ts'

export interface IdentityDependencies extends SessionDependencies {
  /** The real policy service; capabilities are its answer, not a role union. */
  readonly authz: SchoolAuthorizationService
}

export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: IdentityDependencies,
): void {
  app.get('/api/me', { preHandler: requireSession(deps) }, async (request) => {
    const verified = request.verified
    if (!verified) throw new ApiFailure('AUTHENTICATION_REQUIRED')
    // Parse before sending: anything not in the contract is dropped.
    return MeResponse.parse({
      user: {
        id: verified.user.id,
        displayName: verified.user.name,
        // A phone-only identity carries a generated, non-deliverable
        // identifier. Only a real, contract-valid address is ever returned.
        ...(Email.safeParse(verified.user.email).success &&
        !verified.user.email.endsWith('.invalid')
          ? { email: verified.user.email }
          : {}),
        ...(Phone.safeParse(verified.user.phoneNumber).success
          ? { phone: verified.user.phoneNumber }
          : {}),
      },
      session: {
        expiresAt: verified.effectiveExpiresAt.toISOString(),
        assurance: verified.assurance,
        mfaVerifiedAt: verified.mfaVerifiedAt,
      },
      memberships: verified.memberships,
    })
  })

  app.get(
    '/api/schools/:schoolId/context',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = request.context
      const verified = request.verified
      if (!context || !verified) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const membership = verified.memberships.find(
        (entry) => entry.id === context.membershipId,
      )
      if (!membership) throw new ApiFailure('SCHOOL_ACCESS_UNAVAILABLE')
      return SchoolContextResponse.parse({
        school: membership.school,
        membershipId: membership.id,
        accessVersion: membership.accessVersion,
        roleKeys: membership.roleKeys,
        capabilities: await deps.authz.capabilities(context),
        studentLoginEnabled: false,
      })
    },
  )
}
