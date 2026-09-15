import { ERROR_STATUS, type ErrorCode } from '@erp/contracts'
import type { ApiError } from '@erp/contracts'

/** Safe, non-specific text. Never mention identifiers, tokens or database state. */
const MESSAGES: Record<ErrorCode, string> = {
  AUTHENTICATION_REQUIRED: 'Please sign in to continue.',
  SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
  MFA_REQUIRED: 'Complete two-step verification to continue.',
  FRESH_AUTHENTICATION_REQUIRED: 'Please confirm your identity again.',
  SCHOOL_ACCESS_UNAVAILABLE: 'This school is not available for your account.',
  ACCESS_DENIED: 'You do not have access to this.',
  FEATURE_DISABLED: 'This feature is not available.',
  RESOURCE_NOT_FOUND: 'That record was not found.',
  INVALID_REQUEST: 'Some details are missing or invalid.',
  INVITATION_UNAVAILABLE: 'This invitation cannot be used.',
  VERSION_CONFLICT: 'Someone else changed this first. Reload and try again.',
  LAST_OWNER_PROTECTED: 'A school must always keep one owner.',
  IDENTITY_LINK_CONFLICT: 'This login is already linked to someone else.',
  RATE_LIMITED: 'Too many attempts. Please wait and try again.',
  SERVICE_UNAVAILABLE: 'The service is busy. Please try again shortly.',
}

export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(code)
  }
}

export function apiError(
  code: ErrorCode,
  requestId: string,
  retryAfterSeconds?: number,
): { status: number; body: ApiError } {
  return {
    status: ERROR_STATUS[code],
    body: {
      error: {
        code,
        message: MESSAGES[code],
        requestId,
        ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
      },
    },
  }
}
