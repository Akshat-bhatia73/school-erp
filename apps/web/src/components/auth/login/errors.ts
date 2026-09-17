import { describeError, isApiError } from '@/lib/api-errors'
import { ApiRequestError } from '@/lib/http'

/**
 * Sign-in failures are deliberately vague: we never say whether an account exists or which field
 * was wrong. Everything else falls back to the shared plain-English sentences.
 */
export function describeSignInError(error: unknown): string {
  if (isApiError(error, 'AUTHENTICATION_REQUIRED') || isApiError(error, 'INVALID_REQUEST')) {
    return 'We could not sign you in with those details.'
  }
  if (isApiError(error, 'SERVICE_UNAVAILABLE') || isApiError(error, 'NETWORK_ERROR')) {
    return 'The school server is not reachable. Check your connection and try again.'
  }
  return describeError(error)
}

/** Failures while checking a one-time code. The person still has attempts left; say so plainly. */
export function describeCodeError(error: unknown): string {
  if (isApiError(error, 'AUTHENTICATION_REQUIRED') || isApiError(error, 'INVALID_REQUEST')) {
    return 'That code did not work. You have limited attempts.'
  }
  if (isApiError(error, 'SERVICE_UNAVAILABLE') || isApiError(error, 'NETWORK_ERROR')) {
    return 'The school server is not reachable. Check your connection and try again.'
  }
  return describeError(error)
}

/** Seconds to wait when the server throttled us, or 0 when it did not. */
export function throttleSeconds(error: unknown): number {
  if (error instanceof ApiRequestError && error.code === 'RATE_LIMITED') {
    return error.retryAfterSeconds && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60
  }
  return 0
}
