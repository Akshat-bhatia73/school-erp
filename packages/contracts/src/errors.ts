import { z } from 'zod'

export const ERROR_STATUS = {
  AUTHENTICATION_REQUIRED: 401,
  SESSION_EXPIRED: 401,
  MFA_REQUIRED: 403,
  FRESH_AUTHENTICATION_REQUIRED: 403,
  SCHOOL_ACCESS_UNAVAILABLE: 403,
  ACCESS_DENIED: 403,
  FEATURE_DISABLED: 403,
  RESOURCE_NOT_FOUND: 404,
  INVALID_REQUEST: 400,
  INVITATION_UNAVAILABLE: 400,
  VERSION_CONFLICT: 409,
  LAST_OWNER_PROTECTED: 409,
  IDENTITY_LINK_CONFLICT: 409,
  NOT_ALLOWED_YET: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
} as const
export const ErrorCode = z.enum(Object.keys(ERROR_STATUS) as [keyof typeof ERROR_STATUS, ...(keyof typeof ERROR_STATUS)[]])
export type ErrorCode = z.infer<typeof ErrorCode>

/**
 * Why a request the caller was allowed to make was still refused, for the few
 * refusals a person can act on. The list is closed: a reason names a kind of
 * blocker ("this class still has sections"), never a record, a count or a name.
 */
export const ErrorReason = z.enum([
  'grade_has_sections',
  'grade_has_subjects',
  'grade_has_bell_schedule',
  'section_has_students',
  'section_has_teachers',
  'section_has_timetable',
  'section_has_substitutions',
  'section_has_access_rules',
  'subject_has_classes',
  'subject_has_teachers',
  'subject_has_timetable',
  'subject_has_substitutions',
])
export type ErrorReason = z.infer<typeof ErrorReason>

/** Do not include database errors, rejected values, records or tokens in this envelope. */
export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    reason: ErrorReason.optional(),
    message: z.string().min(1).max(500),
    requestId: z.string().min(1).max(128),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  }),
})
export type ApiError = z.infer<typeof ApiError>
