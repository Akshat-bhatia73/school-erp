import type { FastifyRequest } from 'fastify'
import { ApiError } from '@erp/contracts'
import { CLIENT_IP_HEADER } from '../app.ts'
import type { RouteAnswer, ToolCallContext } from './tools/types.ts'
import type { WriteRequest } from './proposals/types.ts'

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

/**
 * GET a route named with its query in one string, as a proposal keeps it
 * ("/exams/papers/…/marks?component=written"). The path goes through the same
 * check as any tool's; the query is split into names and values.
 */
export function getByPath(get: ToolCallContext['get'], pathWithQuery: string): Promise<RouteAnswer> {
  const at = pathWithQuery.indexOf('?')
  if (at < 0) return get(pathWithQuery)
  const query: Record<string, string> = {}
  for (const [name, value] of new URLSearchParams(pathWithQuery.slice(at + 1))) query[name] = value
  return get(pathWithQuery.slice(0, at), query)
}

/** What a write route answered, with the request id its audit row carries. */
export type WriteAnswer =
  | { readonly ok: true; readonly status: number; readonly requestId: string | null }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string | null }

/**
 * Send one write to our own protected route as the person, in-process: the
 * same cookie and address as the GETs above, a JSON body, and nothing else.
 * The route does all its own work (lock, decision, write, audit row). Only a
 * change tool's `write` names the method, path and body, from a preview the
 * person confirmed; no header ever comes from the model.
 */
export function routeWriter(
  request: FastifyRequest,
  schoolId: string,
): (write: WriteRequest) => Promise<WriteAnswer> {
  const cookie = request.headers.cookie
  const address = request.ip
  return async (write) => {
    if (!safePath(write.path) || !['POST', 'PUT', 'PATCH'].includes(write.method)) {
      return { ok: false, status: 400, code: 'INVALID_REQUEST', message: null }
    }
    const response = await request.server.inject({
      method: write.method,
      url: `/api/schools/${encodeURIComponent(schoolId)}${write.path}`,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        [CLIENT_IP_HEADER]: address,
        'content-type': 'application/json',
      },
      payload: JSON.stringify(write.body ?? {}),
      remoteAddress: address,
    })
    const header = response.headers['x-request-id']
    const requestId = typeof header === 'string' && header.length > 0 ? header : null
    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { ok: true, status: response.statusCode, requestId }
    }
    let body: unknown = null
    try {
      body = response.body.length > 0 ? JSON.parse(response.body) : null
    } catch {
      body = null
    }
    const parsed = ApiError.safeParse(body)
    return parsed.success
      ? { ok: false, status: response.statusCode, code: parsed.data.error.code, message: parsed.data.error.message }
      : { ok: false, status: response.statusCode, code: 'SERVICE_UNAVAILABLE', message: null }
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
