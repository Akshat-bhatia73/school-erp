import type { FastifyInstance } from 'fastify'
import { withTenantTransaction } from '@erp/db'
import type { SchoolAuthorizationService } from '@erp/authz'
import {
  AccessExplanation,
  AccessExplanationQuery,
  MemberListRequest,
  MemberSummary,
  pageOf,
} from '@erp/contracts'
import { ApiFailure } from '../http/errors.ts'
import { requireMembership } from '../auth/guards.ts'
import type { SessionDependencies } from '../auth/session.ts'
import type { DeliveryAdapter } from '../delivery/index.ts'
import { authorizeSchoolAction } from './authorize.ts'
import { loadMemberRows, resolveDisplayNames, toMemberSummary } from './directory.ts'
import { changeMembershipStatus, requiredParam } from './lifecycle.ts'
import { changeRoles } from './roles.ts'
import { transferOwnership } from './ownership.ts'
import { startRecovery } from './recovery.ts'

export interface AccessDependencies extends SessionDependencies {
  /** The real policy service; a route never decides access on its own. */
  readonly authz: SchoolAuthorizationService
  readonly delivery: DeliveryAdapter
}

const MemberPage = pageOf(MemberSummary)

/** Query values arrive as strings; only decimal digits become a number. */
function asNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return Number.NaN
  return Number(value)
}

export function registerMembershipRoutes(
  app: FastifyInstance,
  deps: AccessDependencies,
): void {
  app.get(
    '/api/schools/:schoolId/members',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const raw = request.query as Record<string, unknown>
      // Only the two numbers arrive as digits; the filters are already the
      // strings the schema wants, and an unknown key is a bad request.
      const query = MemberListRequest.safeParse({
        ...raw,
        ...(raw.page === undefined ? {} : { page: asNumber(raw.page) }),
        ...(raw.pageSize === undefined ? {} : { pageSize: asNumber(raw.pageSize) }),
      })
      if (!query.success) throw new ApiFailure('INVALID_REQUEST')
      const { page, pageSize, ...filters } = query.data

      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'members.read')
        const { rows, total } = await loadMemberRows(
          conn,
          deps.pools.auth,
          context.schoolId,
          { page, pageSize },
          filters,
        )
        const names = await resolveDisplayNames(conn, deps.pools.auth, context.schoolId, rows)
        return MemberPage.parse({
          items: rows.map((row) => toMemberSummary(row, names.get(row.id) ?? 'Unnamed member')),
          total,
          page,
          pageSize,
        })
      })
    },
  )

  app.get(
    '/api/schools/:schoolId/members/:membershipId/access-explanation',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const params = request.params as { membershipId?: string }
      const membershipId = params.membershipId
      if (!membershipId) throw new ApiFailure('INVALID_REQUEST')
      const query = AccessExplanationQuery.safeParse(request.query)
      if (!query.success) throw new ApiFailure('INVALID_REQUEST')

      // The policy service checks access.explain itself; a second check here
      // would be a second copy of the rule.
      const result = await deps.authz.explainAccess(
        context,
        membershipId,
        query.data.permission,
        {
          schoolId: context.schoolId,
          resourceType: query.data.resourceType,
          id: query.data.resourceId,
        },
      )
      return AccessExplanation.parse(result)
    },
  )

  app.put(
    '/api/schools/:schoolId/members/:membershipId/roles',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const membershipId = requiredParam(request.params, 'membershipId')
      return changeRoles(deps, context, membershipId, request.body)
    },
  )

  for (const event of ['suspend', 'remove', 'restore'] as const) {
    app.post(
      `/api/schools/:schoolId/members/:membershipId/${event}`,
      { preHandler: requireMembership(deps) },
      async (request) => {
        const context = request.context
        if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
        const membershipId = requiredParam(request.params, 'membershipId')
        return changeMembershipStatus(deps, context, membershipId, event, request.body)
      },
    )
  }

  app.post(
    '/api/schools/:schoolId/members/:membershipId/recovery',
    { preHandler: requireMembership(deps) },
    async (request, reply) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const membershipId = requiredParam(request.params, 'membershipId')
      await startRecovery(deps, context, membershipId, request.body)
      // Nothing about the delivery is returned, only that it was accepted.
      return reply.status(202).send({ status: 'queued' })
    },
  )

  app.post(
    '/api/schools/:schoolId/ownership/transfer',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      return transferOwnership(deps, context, request.body)
    },
  )
}
