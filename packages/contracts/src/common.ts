import { z } from 'zod'

/** Opaque identifier, never evidence of ownership. Supports migration of existing IDs. */
export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
export const Version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const Timestamp = z.iso.datetime({ offset: true })
export const CalendarDate = z.iso.date()
export const DisplayName = z.string().trim().min(1).max(160)
export const Reason = z.string().trim().min(3).max(1000)
export const Phone = z.string().regex(/^\+[1-9]\d{6,14}$/)
export const Email = z.email().max(254)

export const SchoolParams = z.strictObject({ schoolId: Id })
export const MemberParams = z.strictObject({ schoolId: Id, membershipId: Id })

export const IdList = z.array(Id).min(1).max(100).refine(
  (ids) => new Set(ids).size === ids.length,
  'Duplicate identifiers are not allowed',
)

/** Parsed query values, after the HTTP adapter converts validated decimal query strings. */
export const PageRequest = z.strictObject({
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
})

export const ContactIdentifier = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('email'), value: Email }),
  z.strictObject({ kind: z.literal('phone'), value: Phone }),
])
export type ContactIdentifier = z.infer<typeof ContactIdentifier>

export function pageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item).max(100),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().min(1).max(100),
  })
}
