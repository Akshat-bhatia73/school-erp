import type { FastifyInstance } from 'fastify'
import { ApiFailure } from '../http/errors.ts'
import { requireSession } from '../auth/guards.ts'
import type { SessionDependencies } from '../auth/session.ts'

interface SessionRow {
  id: string
  token: string
  created_at: Date
  updated_at: Date
  expires_at: Date
  mfa_verified_at: Date | null
  shared_device: boolean
}

/**
 * The account security screen lists and ends devices. The provider's own
 * list-sessions and revoke-session routes are not published, because they take
 * and return raw session tokens; these use opaque session ids instead.
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  deps: SessionDependencies,
): void {
  app.get(
    '/api/sessions',
    { preHandler: requireSession(deps) },
    async (request) => {
      const verified = request.verified
      if (!verified) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const rows = await deps.pools.auth.query<SessionRow>(
        `SELECT id, token, created_at, updated_at, expires_at, mfa_verified_at, shared_device
           FROM auth_session
          WHERE user_id = $1
          ORDER BY created_at DESC`,
        [verified.user.id],
      )
      return {
        sessions: rows.rows.map((row) => ({
          id: row.id,
          current: row.token === verified.session.token,
          createdAt: row.created_at.toISOString(),
          lastActiveAt: row.updated_at.toISOString(),
          expiresAt: row.expires_at.toISOString(),
          assurance: row.mfa_verified_at ? 'mfa' : 'single_factor',
          sharedDevice: row.shared_device,
        })),
      }
    },
  )

  app.post(
    '/api/sessions/:sessionId/revoke',
    { preHandler: requireSession(deps) },
    async (request, reply) => {
      const verified = request.verified
      if (!verified) throw new ApiFailure('AUTHENTICATION_REQUIRED')
      const { sessionId } = request.params as { sessionId: string }
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          sessionId,
        )
      )
        throw new ApiFailure('RESOURCE_NOT_FOUND')
      // Scoped to the signed-in identity: one person can never end another
      // person's device, and an unknown id is simply not found.
      const rows = await deps.pools.auth.query<{ token: string }>(
        'SELECT token FROM auth_session WHERE id = $1 AND user_id = $2',
        [sessionId, verified.user.id],
      )
      const token = rows.rows[0]?.token
      if (!token) throw new ApiFailure('RESOURCE_NOT_FOUND')
      const context = await deps.auth.$context
      await context.internalAdapter.deleteSession(token)
      return reply.status(200).send({ revoked: true })
    },
  )
}
