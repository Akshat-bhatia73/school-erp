/** Plain-English sentences for API failures. Never show a raw code to a person. */
import { ApiRequestError, type ApiErrorCode } from '@/lib/http'

export function isApiError(error: unknown, code?: ApiErrorCode): error is ApiRequestError {
  if (!(error instanceof ApiRequestError)) return false
  return code === undefined || error.code === code
}

const MESSAGES: Record<ApiErrorCode, string> = {
  AUTHENTICATION_REQUIRED: 'Please sign in to continue.',
  SESSION_EXPIRED: 'Your session ended. Please sign in again.',
  MFA_REQUIRED: 'This school needs a second step before you can open it.',
  FRESH_AUTHENTICATION_REQUIRED: 'Please confirm your second step again before making this change.',
  SCHOOL_ACCESS_UNAVAILABLE: 'You do not have access to this school right now.',
  ACCESS_DENIED: 'You do not have permission to do this.',
  FEATURE_DISABLED: 'This way of signing in is turned off.',
  RESOURCE_NOT_FOUND: 'We could not find that.',
  INVALID_REQUEST: 'Some details were not right. Check them and try again.',
  INVITATION_UNAVAILABLE: 'This invitation link cannot be used. Ask your school for a new one.',
  VERSION_CONFLICT: 'Someone else changed this while you were working. Reload and try again.',
  LAST_OWNER_PROTECTED: 'A school must always keep one owner.',
  IDENTITY_LINK_CONFLICT: 'This invitation belongs to a different account.',
  NOT_ALLOWED_YET: 'This cannot be done yet.',
  RATE_LIMITED: 'Too many tries. Please wait a moment and try again.',
  SERVICE_UNAVAILABLE: 'The service is busy right now. Please try again shortly.',
  NETWORK_ERROR: 'We could not reach the server. Check your connection and try again.',
  STALE_RESPONSE: 'That answer was out of date and was discarded. Please try again.',
  UNEXPECTED_RESPONSE: 'Something went wrong. Please try again.',
}

/** A wait a person can read: seconds for a short one, whole minutes for anything longer. */
export function describeWait(seconds: number): string {
  if (seconds <= 0) return 'Try again now.'
  if (seconds <= 90) return `Try again in ${seconds} seconds.`
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
}

export function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === 'RATE_LIMITED' && error.retryAfterSeconds) {
      return `Too many tries. ${describeWait(error.retryAfterSeconds)}`
    }
    // A named reason comes with the server's own sentence, which says what is in the way.
    if (error.reason) return error.message
    return MESSAGES[error.code] ?? MESSAGES.UNEXPECTED_RESPONSE
  }
  return MESSAGES.UNEXPECTED_RESPONSE
}
