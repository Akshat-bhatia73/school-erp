/**
 * The photograph routes, which take and give raw image bytes rather than JSON.
 *
 * `request()` sends and parses JSON, so these three calls repeat its rules by hand: same-origin
 * credentials, and an ApiError envelope turned into the ApiRequestError every screen already
 * knows how to describe. The version the caller believes it is replacing travels in the query
 * string, because the body is the picture itself.
 */
import { ApiRequestError } from '@/lib/http'
import { withQuery } from './shared'

/** An answer that is not 204 carries the usual failure envelope. */
async function failureOf(response: Response): Promise<ApiRequestError> {
  let code: ApiRequestError['code'] = 'UNEXPECTED_RESPONSE'
  let message = 'Something went wrong. Please try again.'
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string } }
    if (payload.error?.code) {
      code = payload.error.code as ApiRequestError['code']
      message = payload.error.message ?? message
    }
  } catch {
    // A failure with no envelope is still a failure; the default message stands.
  }
  return new ApiRequestError({ code, status: response.status, message })
}

async function call(path: string, init: RequestInit): Promise<void> {
  let response: Response
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin' })
  } catch {
    throw new ApiRequestError({ code: 'NETWORK_ERROR', status: 0, message: 'We could not reach the server. Check your connection and try again.' })
  }
  if (!response.ok) throw await failureOf(response)
}

/** Replaces the picture on one record. The type is the one the browser produced. */
export function putPhoto(path: string, file: Blob, expectedVersion: number): Promise<void> {
  return call(withQuery(path, { expectedVersion }), {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  })
}

export function deletePhoto(path: string, expectedVersion: number): Promise<void> {
  return call(withQuery(path, { expectedVersion }), { method: 'DELETE' })
}

/**
 * The address an `<img>` can use. The session cookie authenticates it and the server decides the
 * record again for every request, so nothing about the picture is public. The moment the record
 * was last changed is the cache buster, so a replaced photo is never the old one on screen.
 */
export function photoSrc(path: string, photoUpdatedAt?: string): string {
  return withQuery(path, { v: photoUpdatedAt })
}
