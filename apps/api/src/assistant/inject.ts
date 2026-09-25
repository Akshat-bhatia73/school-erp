import type { FastifyRequest } from 'fastify'
import { ApiError } from '@erp/contracts'
import { CLIENT_IP_HEADER } from '../app.ts'
import type { RouteAnswer, ToolCallContext } from './tools/types.ts'

/**
 * A path under /api/schools/:schoolId: slash-separated segments of letters,
 * digits and - _ . ~ %, never "." or ".." on their own. Anything else is not
 * a route a tool may name.
 */
const SEGMENT = /^[A-Za-z0-9._~%-]+$/

function safePath(path: string): boolean {
  if (!path.startsWith('/') || path.length > 500) return false
  return path
    .slice(1)
    .split('/')
    .every((segment) => SEGMENT.test(segment) && segment !== '.' && segment !== '..')
}

/**
 * GET one of our own protected routes as the person asking, in-process. The
 * inner request carries the caller's own cookie and address and nothing else,
 * so it passes through the whole route pipeline exactly as a screen's request
 * would: session, membership, permission gate, plan scope, response contract,
 * read audit and access log. No header the model chose is ever sent.
 */
export function routeGetter(request: FastifyRequest, schoolId: string): ToolCallContext['get'] {
  const cookie = request.headers.cookie
  const address = request.ip
  return async (path, query) => {
    if (!safePath(path)) return { ok: false, status: 400, code: 'INVALID_REQUEST' }
    const search = new URLSearchParams()
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value !== undefined) search.set(name, String(value))
    }
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    const response = await request.server.inject({
      method: 'GET',
      url: `/api/schools/${encodeURIComponent(schoolId)}${path}${suffix}`,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        [CLIENT_IP_HEADER]: address,
      },
      remoteAddress: address,
    })
    return answerOf(response.statusCode, response.body)
  }
}

function answerOf(status: number, text: string): RouteAnswer {
  let body: unknown = null
  try {
    body = text.length > 0 ? JSON.parse(text) : null
  } catch {
    return { ok: false, status, code: 'SERVICE_UNAVAILABLE' }
  }
  if (status >= 200 && status < 300) return { ok: true, status, body }
  const parsed = ApiError.safeParse(body)
  return { ok: false, status, code: parsed.success ? parsed.data.error.code : 'SERVICE_UNAVAILABLE' }
}
