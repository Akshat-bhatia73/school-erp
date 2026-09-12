import { z } from 'zod'

/** ISO date string, e.g. "2026-04-01" */
export const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
/** ISO datetime string */
export const ISODateTime = z.string()

export const Id = z.string().min(1)

export const IndianPhone = z
  .string()
  .regex(/^[6-9]\d{9}$/, 'Enter a 10-digit mobile number')

export const Gender = z.enum(['male', 'female', 'other'])
export type Gender = z.infer<typeof Gender>

export const BloodGroup = z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown'])
export type BloodGroup = z.infer<typeof BloodGroup>

/** Social category as used in Indian school records */
export const SocialCategory = z.enum(['general', 'obc', 'sc', 'st', 'ews', 'other'])
export type SocialCategory = z.infer<typeof SocialCategory>

export const Address = z.object({
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  district: z.string().optional(),
  state: z.string(),
  pincode: z.string().regex(/^\d{6}$/, 'Enter a 6-digit PIN code'),
})
export type Address = z.infer<typeof Address>

/** Fields every stored record has */
export const BaseRecord = z.object({
  id: Id,
  createdAt: ISODateTime,
  updatedAt: ISODateTime,
})

/** Fields every school-scoped record has */
export const TenantRecord = BaseRecord.extend({
  schoolId: Id,
})

export interface Paginated<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}
