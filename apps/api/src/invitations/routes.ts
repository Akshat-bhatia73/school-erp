import type { FastifyInstance } from 'fastify'
import {
  AcceptInvitationRequest,
  InvitationActionRequest,
  InvitationListRequest,
  InvitationPage,
  InviteMemberRequest,
} from '@erp/contracts'
import { ApiFailure } from '../http/errors.ts'
import { requireMembership, requireSession } from '../auth/guards.ts'
import type { AccessDependencies } from '../memberships/routes.ts'
import {
  acceptInvitation,
  createInvitation,
  listInvitations,
  resendInvitation,
  revokeInvitation,
} from './service.ts'

/** The raw body is kept as a string, so every route parses it the same way. */
function bodyOf(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    throw new ApiFailure('INVALID_REQUEST')
  }
}

/** Query values arrive as strings; only decimal digits become a number. */
function asNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{1,6}$/.test(value)) return Number.NaN
  return Number(value)
}

function invitationIdOf(params: unknown): string {
  const id = (params as { invitationId?: string }).invitationId
  if (!id) throw new ApiFailure('INVALID_REQUEST')
  return id
}

/**
 * Invitation workflows. The single-use token is hashed before storage and
 * never returned in a response, a log line or a query string.
 */
export function registerInvitationRoutes(
  app: FastifyInstance,
  deps: AccessDependencies,
): void {
  app.get(
    '/api/schools/:schoolId/invitations',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const raw = request.query as Record<string, unknown>
      const query = InvitationListRequest.safeParse({
        ...(raw.status === undefined ? {} : { status: raw.status }),
        ...(raw.page === undefined ? {} : { page: asNumber(raw.page) }),
        ...(raw.pageSize === undefined ? {} : { pageSize: asNumber(raw.pageSize) }),
      })
      if (!query.success) throw new ApiFailure('INVALID_REQUEST')
      const { items, total } = await listInvitations(deps, context, query.data)
      return InvitationPage.parse({
        items,
        total,
        page: query.data.page,
        pageSize: query.data.pageSize,
      })
    },
  )

  app.post(
    '/api/schools/:schoolId/invitations',
    { preHandler: requireMembership(deps) },
    async (request, reply) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const body = InviteMemberRequest.safeParse(bodyOf(request.body))
      if (!body.success) throw new ApiFailure('INVALID_REQUEST')
      const summary = await createInvitation(deps, context, body.data)
      return reply.status(201).send(summary)
    },
  )

  app.post(
    '/api/schools/:schoolId/invitations/:invitationId/resend',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const body = InvitationActionRequest.safeParse(bodyOf(request.body))
      if (!body.success) throw new ApiFailure('INVALID_REQUEST')
      return resendInvitation(
        deps,
        context,
        invitationIdOf(request.params),
        body.data.expectedVersion,
      )
    },
  )

  app.post(
    '/api/schools/:schoolId/invitations/:invitationId/revoke',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = request.context
      if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const body = InvitationActionRequest.safeParse(bodyOf(request.body))
      if (!body.success) throw new ApiFailure('INVALID_REQUEST')
      return revokeInvitation(
        deps,
        context,
        invitationIdOf(request.params),
        body.data.expectedVersion,
      )
    },
  )

  // No school in the path: the invitee has no membership yet, so only a
  // verified session is required and the token names the school.
  app.post(
    '/api/invitations/accept',
    { preHandler: requireSession(deps) },
    async (request) => {
      const verified = request.verified
      if (!verified) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const body = AcceptInvitationRequest.safeParse(bodyOf(request.body))
      if (!body.success) throw new ApiFailure('INVALID_REQUEST')
      return acceptInvitation(deps, verified, request.id, body.data.token)
    },
  )
}
