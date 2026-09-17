/** Maps a refusal from the API onto the one screen that explains it in plain English. */
import { isApiError } from '@/lib/api-errors'
import type { ApiErrorCode } from '@/lib/http'

export const ACCESS_REASONS = ['no_membership', 'suspended', 'school', 'student', 'disabled', 'forbidden', 'not_found'] as const
export type AccessReason = (typeof ACCESS_REASONS)[number]

const BY_CODE: Partial<Record<ApiErrorCode, AccessReason>> = {
  ACCESS_DENIED: 'forbidden',
  RESOURCE_NOT_FOUND: 'not_found',
  SCHOOL_ACCESS_UNAVAILABLE: 'school',
  FEATURE_DISABLED: 'student',
}

export function isAccessReason(value: unknown): value is AccessReason {
  return typeof value === 'string' && (ACCESS_REASONS as readonly string[]).includes(value)
}

/** Returns null when the error is something else entirely and the screen should handle it itself. */
export function accessReasonForError(error: unknown): AccessReason | null {
  if (!isApiError(error)) return null
  return BY_CODE[error.code] ?? null
}
