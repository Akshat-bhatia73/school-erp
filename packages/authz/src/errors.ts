import type { ErrorCode } from '@erp/contracts'

/**
 * Authorization failures that must reach the HTTP boundary as a known error code.
 * Messages are plain English and never carry ids of other people or rule reasons.
 */
export class AuthorizationError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message?: string) {
    super(message ?? defaultMessage(code))
    this.name = 'AuthorizationError'
    this.code = code
  }
}

function defaultMessage(code: ErrorCode): string {
  switch (code) {
    case 'ACCESS_DENIED':
      return 'You do not have access to do this.'
    case 'MFA_REQUIRED':
      return 'Two-step verification is required for this action.'
    case 'RESOURCE_NOT_FOUND':
      return 'That record was not found.'
    case 'FEATURE_DISABLED':
      return 'This feature is not available for your account.'
    case 'VERSION_CONFLICT':
      return 'Someone else changed this record. Try again.'
    default:
      return 'The request could not be completed.'
  }
}
