import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Request ids. Every request gets a fresh random UUID, and a client header
 * never chooses one. The one exception is a write the API sends to itself
 * (a confirmed assistant proposal): it reserves the id beforehand, so the
 * proposal knows which audit row to look for if the process stops before it
 * hears back. The reservation is a random ticket held in this process only,
 * used once, so nobody outside can name an id either.
 */

export const OPERATION_HEADER = 'x-erp-operation'

const reserved = new Map<string, string>()

/** Reserve `id` for the next in-process request carrying the returned ticket. */
export function reserveRequestId(id: string): string {
  const ticket = randomBytes(32).toString('base64url')
  reserved.set(ticket, id)
  return ticket
}

/** Drop a ticket that was never used. */
export function releaseRequestId(ticket: string): void {
  reserved.delete(ticket)
}

/** Fastify's genReqId: a reserved id when the request brings its ticket, else a new UUID. */
export function requestIdFor(raw: IncomingMessage): string {
  const ticket = raw.headers[OPERATION_HEADER]
  if (typeof ticket === 'string') {
    const id = reserved.get(ticket)
    if (id !== undefined) {
      reserved.delete(ticket)
      return id
    }
  }
  return randomUUID()
}
