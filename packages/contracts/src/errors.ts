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
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
} as const
export const ErrorCode = z.enum(Object.keys(ERROR_STATUS) as [keyof typeof ERROR_STATUS, ...(keyof typeof ERROR_STATUS)[]])
export type ErrorCode = z.infer<typeof ErrorCode>

/** Do not include database errors, rejected values, records or tokens in this envelope. */
export const ApiError = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string().min(1).max(500),
    requestId: z.string().min(1).max(128),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  }),
})
export type ApiError = z.infer<typeof ApiError>
