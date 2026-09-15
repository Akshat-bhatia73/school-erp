/** Task 5 request and response contracts owned by the staff module. */
import { z } from 'zod'
import { CalendarDate, DisplayName, Email, IdList, Phone, Version } from './common.ts'

/** The employment states a staff record may be in. Mirrors the database check. */
export const StaffStatus = z.enum(['active', 'on_leave', 'resigned', 'retired'])
export const StaffType = z.enum(['teaching', 'non_teaching', 'admin', 'support'])
export const StaffEmploymentType = z.enum(['permanent', 'contract', 'part_time', 'probation'])
export const StaffGender = z.enum(['male', 'female', 'other'])

/**
 * Creating a staff record never creates a login, never sets pay and never sets
 * bank or identity numbers, so those keys are simply not part of the request.
 * A strict object turns an attempt to send them into INVALID_REQUEST.
 */
export const StaffCreateRequest = z.strictObject({
  employeeCode: z.string().trim().min(1).max(100),
  firstName: DisplayName,
  lastName: DisplayName.optional(),
  staffType: StaffType,
  designation: z.string().trim().min(1).max(160),
  department: z.string().trim().min(1).max(160).optional(),
  employmentType: StaffEmploymentType,
  joiningDate: CalendarDate,
  phone: Phone,
  email: Email.optional(),
  gender: StaffGender.optional(),
  dateOfBirth: CalendarDate.optional(),
  qualification: z.string().trim().min(1).max(500).optional(),
})
export type StaffCreateRequest = z.infer<typeof StaffCreateRequest>

/** Employment fields only: nothing here touches pay, private contact or roles. */
export const StaffUpdateEmploymentRequest = z
  .strictObject({
    expectedVersion: Version,
    designation: z.string().trim().min(1).max(160).optional(),
    department: z.string().trim().min(1).max(160).nullable().optional(),
    employmentType: StaffEmploymentType.optional(),
    status: StaffStatus.optional(),
    staffType: StaffType.optional(),
    joiningDate: CalendarDate.optional(),
    leavingDate: CalendarDate.nullable().optional(),
    qualification: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedVersion'),
    'Supply at least one editable field',
  )
export type StaffUpdateEmploymentRequest = z.infer<typeof StaffUpdateEmploymentRequest>

/** Free text search over directory fields only; never over pay or private data. */
export const StaffSearchRequest = z.strictObject({
  q: z.string().trim().min(1).max(100),
})

export const StaffExportRequest = z.strictObject({ staffIds: IdList })

