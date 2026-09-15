import type { FastifyInstance } from 'fastify'
import {
  Email,
  MeResponse,
  Phone,
  ROLE_TEMPLATES,
  SchoolContextResponse,
  type PermissionKey,
  type RoleKey,
} from '@erp/contracts'
import { ApiFailure } from '../http/errors.ts'
import { requireMembership, requireSession } from '../auth/guards.ts'
import type { SessionDependencies } from '../auth/session.ts'

export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: SessionDependencies,
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
        capabilities: capabilitiesFor(membership.roleKeys),
        studentLoginEnabled: false,
      })
    },
  )
}

/**
 * Navigation hint only. Task 3 replaces this with the real policy service,
 * including denies, exceptions and relationship scope.
 */
function capabilitiesFor(roleKeys: readonly RoleKey[]): PermissionKey[] {
  const keys = new Set<PermissionKey>()
  for (const role of roleKeys)
    for (const grant of ROLE_TEMPLATES[role].grants) keys.add(grant.permission)
  return [...keys]
}
