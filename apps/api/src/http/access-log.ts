import { createHmac } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Pool } from 'pg'
import type { ApiConfig } from '../config.ts'
import type { ErrorCode } from '@erp/contracts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the error handler with the code it sent, read by the hook. */
    sentErrorCode?: ErrorCode
    /** Monotonic start, so the duration does not depend on the wall clock. */
    accessLogStart?: bigint
  }
}

/**
 * The address is evidence during an incident and a person's location the rest
 * of the time. A keyed hash lets two rows be compared without the log ever
 * holding the address itself.
 */
export function hashAddress(address: string, secret: string): string {
  return createHmac('sha256', secret).update(address).digest('hex').slice(0, 32)
}

function ids(request: FastifyRequest): {
  userId: string | null
  membershipId: string | null
  schoolId: string | null
} {
  const context = request.context
  if (context)
    return {
      userId: context.userId,
      membershipId: context.membershipId,
      schoolId: context.schoolId,
    }
  return {
    userId: request.verified?.user.id ?? null,
    membershipId: null,
    schoolId: null,
  }
}

/**
 * One row per /api request in our own database. Vercel Hobby has no log drain
 * and Sentry must never hold request data, so this table is the only request
 * record we control. It holds the route pattern, never the URL, the query
 * string, the body, a cookie or a user agent.
 */
export function registerAccessLog(
  app: FastifyInstance,
  deps: { config: ApiConfig; pool: Pool },
): void {
  app.addHook('onRequest', async (request) => {
    request.accessLogStart = process.hrtime.bigint()
  })

  app.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith('/api')) return
    // The health route is called by the platform, not by a person.
    if (request.routeOptions.url === '/api/health') return
    const started = request.accessLogStart
    const durationMs =
      started === undefined
        ? Math.round(reply.elapsedTime)
        : Number((process.hrtime.bigint() - started) / 1000n) / 1000
    const { userId, membershipId, schoolId } = ids(request)
    // Fire and forget: the client is already answered, and an unwritable log
    // must not become a failed request.
    void deps.pool
      .query(
        `INSERT INTO access_log
           (method, route, status, code, user_id, membership_id, school_id,
            ip_hash, duration_ms, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          request.method,
          // The pattern, so a row never carries a record id or a query string.
          request.routeOptions.url ?? 'unmatched',
          reply.statusCode,
          request.sentErrorCode ?? null,
          userId,
          membershipId,
          schoolId,
          request.ip ? hashAddress(request.ip, deps.config.AUTH_SECRET) : null,
          Math.round(durationMs),
          request.id,
        ],
      )
      .catch((error: unknown) =>
        request.log.error({ requestId: request.id, err: error }, 'access log insert failed'),
      )
  })
}

