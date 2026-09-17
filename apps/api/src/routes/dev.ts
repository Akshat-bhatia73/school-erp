import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import type { ApiConfig } from '../config.ts'
import type { DeliveryAdapter } from '../delivery/index.ts'
import { readHeldSms } from '../delivery/held-sms.ts'
import { ApiFailure } from '../http/errors.ts'

/** Never hand back more than this, however long the process has been running. */
const MAX_MESSAGES = 50

export interface DevRouteDependencies {
  config: ApiConfig
  delivery: DeliveryAdapter
  authPool: Pool
}

/**
 * Development-only view of the sandbox outbox, so the login screens can be
 * exercised locally without an email or SMS provider. It publishes one-time
 * codes and reset tokens in clear, so it exists only when a developer asked
 * for it explicitly: DEV_SANDBOX_OUTBOX=true, sandbox delivery and a
 * non-production NODE_ENV. Otherwise the route is simply absent and the
 * shared not-found handler answers.
 */
export function registerDevRoutes(
  app: FastifyInstance,
  deps: DevRouteDependencies,
): void {
  const { config, delivery } = deps
  if (!config.DEV_SANDBOX_OUTBOX) return
  if (config.NODE_ENV === 'production') return
  if (delivery.mode !== 'sandbox') return

  app.get('/api/dev/outbox', async () => ({
    messages: delivery.outbox
      .slice(-MAX_MESSAGES)
      .reverse()
      .map((message) => ({
        channel: message.channel,
        to: message.to,
        purpose: message.purpose,
        secret: message.secret,
        createdAt: message.sentAt,
      })),
  }))
}

/** Compared as digests so the lengths match and the time taken says nothing. */
function sameToken(presented: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(presented), digest(expected))
}

/**
 * Hosted test builds only. There is no SMS provider yet, so a text message is
 * held for ten minutes and a tester holding HELD_SMS_TOKEN reads it here. The
 * route exists only when that token is configured, and answers exactly like a
 * missing route to anyone without it. A real school never sets the token.
 */
export function registerHeldSmsRoute(
  app: FastifyInstance,
  deps: DevRouteDependencies,
): void {
  const token = deps.config.HELD_SMS_TOKEN
  if (!token) return

  app.get('/api/held-codes', async (request) => {
    const header = request.headers.authorization ?? ''
    const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!sameToken(presented, token)) throw new ApiFailure('RESOURCE_NOT_FOUND')
    return { messages: await readHeldSms(deps.authPool) }
  })
}
