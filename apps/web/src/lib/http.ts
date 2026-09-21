/**
 * Same-origin JSON client for the real API.
 *
 * Everything goes through `/api`, which the Vite dev server proxies to the backend without
 * rewriting Origin or Host. The session is an HttpOnly SameSite=Lax cookie: there is no bearer
 * token, nothing about identity is ever stored in the browser, and same-origin is the CSRF
 * protection. Every failure arrives as the @erp/contracts ApiError envelope.
 */
import { ApiError, type ErrorCode, type ErrorReason } from '@erp/contracts'
import type { ZodType } from 'zod'

export type ApiErrorCode = ErrorCode | 'NETWORK_ERROR' | 'STALE_RESPONSE' | 'UNEXPECTED_RESPONSE'

export class ApiRequestError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly requestId?: string
  readonly retryAfterSeconds?: number
  /** Why a refusal happened, when the server named one. Its message is then the one to show. */
  readonly reason?: ErrorReason

  constructor(init: { code: ApiErrorCode; status: number; message: string; requestId?: string; retryAfterSeconds?: number; reason?: ErrorReason }) {
    super(init.message)
    this.name = 'ApiRequestError'
    this.code = init.code
    this.status = init.status
    this.requestId = init.requestId
    this.retryAfterSeconds = init.retryAfterSeconds
    this.reason = init.reason
  }
}

// ---------- context generation ----------
// Every request carries the signal of the generation it was started in. Changing identity or
// active school bumps the generation, which aborts the in-flight requests of the old context and
// turns any response that still arrives into STALE_RESPONSE, so a late answer can never
// repopulate a cache that was cleared for another school.

let generation = 0
let controller = new AbortController()

export function currentGeneration() {
  return generation
}

export function bumpGeneration() {
  controller.abort()
  controller = new AbortController()
  generation += 1
  return generation
}

// ---------- session lost notifications ----------

type SessionLostListener = () => void
const sessionLostListeners = new Set<SessionLostListener>()

/** Fires when any request that expected a session is told the session is gone. */
export function onSessionLost(listener: SessionLostListener) {
  sessionLostListeners.add(listener)
  return () => { sessionLostListeners.delete(listener) }
}

function emitSessionLost() {
  for (const listener of [...sessionLostListeners]) listener()
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  schema?: ZodType<T>
  signal?: AbortSignal
  /** Bootstrap and login calls: a 401 here is a normal answer, not a lost session. */
  expectAnonymous?: boolean
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const withAny = AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }
  if (typeof withAny.any === 'function') return withAny.any(signals)
  const local = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) { local.abort(); break }
    signal.addEventListener('abort', () => local.abort(), { once: true })
  }
  return local.signal
}

function readRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after')
  if (!header) return undefined
  const seconds = Number(header.trim())
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : undefined
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const text = await response.text()
  if (text.trim() === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return Symbol.for('erp.unparsable')
  }
}

const UNPARSABLE = Symbol.for('erp.unparsable')

export async function request<T = undefined>(path: string, options: RequestOptions<T> = {}): Promise<T> {
  const startedAt = generation
  const signals = [controller.signal]
  if (options.signal) signals.push(options.signal)

  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: options.body === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: combineSignals(signals),
    })
  } catch {
    if (generation !== startedAt) throw staleError()
    throw new ApiRequestError({ code: 'NETWORK_ERROR', status: 0, message: 'We could not reach the server. Check your connection and try again.' })
  }

  if (generation !== startedAt) throw staleError()

  const payload = await readBody(response)
  if (generation !== startedAt) throw staleError()

  if (!response.ok) {
    const envelope = ApiError.safeParse(payload)
    if (!envelope.success) {
      throw new ApiRequestError({ code: 'UNEXPECTED_RESPONSE', status: response.status, message: 'The server sent an answer we did not understand.' })
    }
    const { code, message, requestId, reason } = envelope.data.error
    const retryAfterSeconds = envelope.data.error.retryAfterSeconds ?? readRetryAfter(response)
    if (!options.expectAnonymous && (code === 'AUTHENTICATION_REQUIRED' || code === 'SESSION_EXPIRED')) emitSessionLost()
    throw new ApiRequestError({ code, status: response.status, message, requestId, retryAfterSeconds, reason })
  }

  if (payload === UNPARSABLE) {
    throw new ApiRequestError({ code: 'UNEXPECTED_RESPONSE', status: response.status, message: 'The server sent an answer we did not understand.' })
  }
  if (!options.schema) return payload as T
  const parsed = options.schema.safeParse(payload)
  if (!parsed.success) {
    throw new ApiRequestError({ code: 'UNEXPECTED_RESPONSE', status: response.status, message: 'The server sent an answer we did not understand.' })
  }
  return parsed.data
}

function staleError() {
  return new ApiRequestError({ code: 'STALE_RESPONSE', status: 0, message: 'That answer belonged to a different school or sign-in and was discarded.' })
}

/** An aborted fetch is a cancellation, not a failure worth showing anyone. */
export function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
