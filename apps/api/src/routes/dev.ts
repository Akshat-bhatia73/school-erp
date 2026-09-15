import type { FastifyInstance } from 'fastify'
import type { ApiConfig } from '../config.ts'
import type { DeliveryAdapter } from '../delivery/index.ts'

/** Never hand back more than this, however long the process has been running. */
const MAX_MESSAGES = 50

export interface DevRouteDependencies {
  config: ApiConfig
  delivery: DeliveryAdapter
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
