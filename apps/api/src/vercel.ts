import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apiError } from './http/errors.ts'
import { createRuntime, type Runtime } from './runtime.ts'

/**
 * The API as one Vercel Function. The site and the API share a project, so
 * /api is same-origin and the session cookie never crosses a host. An
 * instance serves many requests; the app and its pools are built once and a
 * failed start is retried on the next request instead of being remembered.
 */
let starting: Promise<Runtime> | undefined

async function runtime(): Promise<Runtime> {
  starting ??= createRuntime().then(async (created) => {
    await created.app.ready()
    return created
  })
  try {
    return await starting
  } catch (error) {
    starting = undefined
    throw error
  }
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const { app } = await runtime()
    app.server.emit('request', request, response)
  } catch {
    // Never the reason: a configuration error names settings, not for callers.
    console.error('api failed to start')
    const { status, body } = apiError('SERVICE_UNAVAILABLE', randomUUID())
    response.statusCode = status
    response.setHeader('content-type', 'application/json')
    response.setHeader('cache-control', 'no-store')
    response.end(JSON.stringify(body))
  }
}
