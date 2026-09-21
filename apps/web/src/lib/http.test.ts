import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ApiRequestError, bumpGeneration, onSessionLost, request } from '@/lib/http'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init })
}

function envelope(code: string, message = 'Nope', extra: Record<string, unknown> = {}) {
  return { error: { code, message, requestId: 'req-1', ...extra } }
}

describe('request', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('returns the parsed body on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }))
    await expect(request('/api/thing')).resolves.toEqual({ ok: true })
  })

  it('treats 204 and empty bodies as undefined', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    await expect(request('/api/thing')).resolves.toBeUndefined()
  })

  it('turns the error envelope into an ApiRequestError', async () => {
    fetchMock.mockResolvedValue(jsonResponse(envelope('ACCESS_DENIED'), { status: 403 }))
    const error = await request('/api/thing').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as ApiRequestError).code).toBe('ACCESS_DENIED')
    expect((error as ApiRequestError).requestId).toBe('req-1')
  })

  it('keeps the reason the server named, so the refusal can be explained in its own words', async () => {
    fetchMock.mockResolvedValue(jsonResponse(
      envelope('INVALID_REQUEST', 'This class still has sections. Remove them first.', { reason: 'grade_has_sections' }),
      { status: 400 },
    ))
    const error = await request('/api/thing').catch((e: unknown) => e)
    expect((error as ApiRequestError).reason).toBe('grade_has_sections')
    const { describeError } = await import('@/lib/api-errors')
    expect(describeError(error)).toBe('This class still has sections. Remove them first.')
  })

  it('falls back to the Retry-After header when the envelope has no retryAfterSeconds', async () => {
    fetchMock.mockResolvedValue(jsonResponse(envelope('RATE_LIMITED'), { status: 429, headers: { 'Retry-After': '42' } }))
    const error = await request('/api/thing').catch((e: unknown) => e)
    expect((error as ApiRequestError).retryAfterSeconds).toBe(42)
  })

  it('prefers the envelope retryAfterSeconds', async () => {
    fetchMock.mockResolvedValue(jsonResponse(envelope('RATE_LIMITED', 'Slow down', { retryAfterSeconds: 7 }), { status: 429, headers: { 'Retry-After': '42' } }))
    const error = await request('/api/thing').catch((e: unknown) => e)
    expect((error as ApiRequestError).retryAfterSeconds).toBe(7)
  })

  it('rejects an unrecognised error body as UNEXPECTED_RESPONSE', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ oops: true }, { status: 500 }))
    const error = await request('/api/thing').catch((e: unknown) => e)
    expect((error as ApiRequestError).code).toBe('UNEXPECTED_RESPONSE')
  })

  it('never returns partial data when the schema does not match', async () => {
    const { z } = await import('zod')
    fetchMock.mockResolvedValue(jsonResponse({ name: 1 }))
    const error = await request('/api/thing', { schema: z.object({ name: z.string() }) }).catch((e: unknown) => e)
    expect((error as ApiRequestError).code).toBe('UNEXPECTED_RESPONSE')
  })

  it('reports a failed fetch as NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    const error = await request('/api/thing').catch((e: unknown) => e)
    expect((error as ApiRequestError).code).toBe('NETWORK_ERROR')
  })

  it('discards an answer whose generation changed while it was in flight', async () => {
    let release!: (value: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve }))
    const pending = request('/api/thing')
    bumpGeneration()
    release(jsonResponse({ secret: 'other school' }))
    const error = await pending.catch((e: unknown) => e)
    expect((error as ApiRequestError).code).toBe('STALE_RESPONSE')
  })

  it('announces a lost session', async () => {
    const listener = vi.fn()
    const stop = onSessionLost(listener)
    fetchMock.mockResolvedValue(jsonResponse(envelope('SESSION_EXPIRED'), { status: 401 }))
    await request('/api/thing').catch(() => {})
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
  })

  it('stays quiet for requests that expect to be anonymous', async () => {
    const listener = vi.fn()
    const stop = onSessionLost(listener)
    fetchMock.mockResolvedValue(jsonResponse(envelope('AUTHENTICATION_REQUIRED'), { status: 401 }))
    await request('/api/me', { expectAnonymous: true }).catch(() => {})
    expect(listener).not.toHaveBeenCalled()
    stop()
  })
})
