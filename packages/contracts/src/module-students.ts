/** Task 5 request and response contracts owned by the students module. */
import { z } from 'zod'
import { CalendarDate, DisplayName, Id, Phone, Version } from './common.ts'

/** The relationship vocabulary a guardian link may use. Mirrors GuardianContact. */
export const StudentsGuardianRelation = z.enum([
  'father',
  'mother',
  'guardian',
  'grandparent',
  'sibling',
  'other',
])

/** A guardian the caller wants created. No income, no photo, no free identifiers. */
export const StudentsNewGuardian = z.strictObject({
  firstName: DisplayName,
  lastName: DisplayName.optional(),
  phone: Phone,
  occupation: z.string().trim().max(200).optional(),
  address: z.string().trim().max(1000).optional(),
})

/**
 * Admission names either an existing guardian of this school or a new one,
 * never both, so a request can not quietly overwrite somebody else's record.
 */
export const StudentsAdmitGuardian = z
  .strictObject({
    guardianId: Id.optional(),
    guardian: StudentsNewGuardian.optional(),
    relation: StudentsGuardianRelation,
    isPrimary: z.boolean().default(false),
    receivesNotifications: z.boolean().default(true),
  })
  .refine(
    (value) => (value.guardianId === undefined) !== (value.guardian === undefined),
    'Name exactly one of an existing guardian or a new guardian',
  )

/**
 * Everything admission may set. Fields the permission does not cover (school,
 * status, version, medical notes) are absent on purpose: a strict object turns
 * an attempt to send them into a rejected request rather than a silent write.
 */
export const StudentsAdmitRequest = z.strictObject({
  firstName: DisplayName,
  lastName: DisplayName.optional(),
  admissionNumber: z.string().trim().min(1).max(100),
  dateOfBirth: CalendarDate,
  gender: z.enum(['male', 'female', 'other']),
  category: z.string().trim().max(50).optional(),
  admissionType: z.string().trim().max(50).optional(),
  admissionDate: CalendarDate,
  address: z.string().trim().max(1000).optional(),
  sectionId: Id,
  rollNumber: z.number().int().positive().optional(),
  guardians: z.array(StudentsAdmitGuardian).min(1).max(5),
})

/** The restricted demographic fields, behind students.update_sensitive. */
export const StudentsUpdateSensitiveRequest = z
  .strictObject({
    expectedVersion: Version,
    dateOfBirth: CalendarDate.optional(),
    gender: z.enum(['male', 'female', 'other']).optional(),
    category: z.string().trim().max(50).optional(),
    admissionType: z.string().trim().max(50).optional(),
    address: z.string().trim().max(1000).optional(),
    aadhaarLast4: z.string().regex(/^\d{4}$/).optional(),
    apaarId: z.string().trim().max(100).optional(),
    bloodGroup: z.string().trim().max(20).optional(),
    medicalNotes: z.string().trim().max(4000).optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 1,
    'Supply at least one editable field',
  )

/** Link a guardian to a student, creating the guardian record when needed. */
export const StudentsAddGuardianRequest = StudentsAdmitGuardian

/** Edit one guardian record and the link that joins it to this student. */
export const StudentsUpdateGuardianRequest = z
  .strictObject({
    expectedVersion: Version,
    firstName: DisplayName.optional(),
    lastName: DisplayName.optional(),
    phone: Phone.optional(),
    occupation: z.string().trim().max(200).optional(),
    address: z.string().trim().max(1000).optional(),
    relation: StudentsGuardianRelation.optional(),
    isPrimary: z.boolean().optional(),
    receivesNotifications: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 1,
    'Supply at least one editable field',
  )

/** The roster filters again, without paging, for the authorized count. */
export const StudentsCountRequest = z.strictObject({
  search: z.string().trim().max(100).optional(),
  sectionId: Id.optional(),
  academicYearId: Id.optional(),
  status: z.enum(['active', 'left', 'alumni', 'suspended']).optional(),
})

/** Type-ahead over the same authorized rows the roster would return. */
export const StudentsSearchRequest = z.strictObject({
  q: z.string().trim().min(1).max(100),
})

export type StudentsAdmitRequest = z.infer<typeof StudentsAdmitRequest>
export type StudentsAdmitGuardian = z.infer<typeof StudentsAdmitGuardian>
export type StudentsUpdateSensitiveRequest = z.infer<typeof StudentsUpdateSensitiveRequest>
export type StudentsUpdateGuardianRequest = z.infer<typeof StudentsUpdateGuardianRequest>
export type StudentsCountRequest = z.infer<typeof StudentsCountRequest>
export type StudentsSearchRequest = z.infer<typeof StudentsSearchRequest>
