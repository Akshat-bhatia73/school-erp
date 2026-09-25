/** Task 5 request and response contracts owned by the students-bulk module. */
import { z } from 'zod'
import { CalendarDate, DisplayName, Email, Id } from './common.ts'
import { AadhaarNumber, PanNumber } from './identifiers.ts'

/**
 * One line of the uploaded sheet, as a person typed it. Names of grades and
 * sections arrive as text because a spreadsheet has no identifiers; the server
 * resolves them against this school and this academic year and never trusts a
 * client-supplied identifier or a client-supplied "valid" flag.
 *
 * The phone is the ten digit number people write in India. The server stores
 * the normalised +91 form, so the sheet stays readable and the database stays
 * consistent.
 */
export const StudentsBulkImportRow = z.strictObject({
  rowNumber: z.number().int().positive().max(1000),
  admissionNumber: z.string().trim().min(1).max(100).optional(),
  firstName: DisplayName,
  lastName: DisplayName.optional(),
  dateOfBirth: CalendarDate,
  gender: z.enum(['male', 'female', 'other']),
  grade: z.string().trim().min(1).max(100),
  section: z.string().trim().min(1).max(100),
  rollNumber: z.number().int().positive().max(1000).optional(),
  fatherName: DisplayName.optional(),
  motherName: DisplayName.optional(),
  guardianPhone: z.string().regex(/^[6-9]\d{9}$/),
  guardianEmail: Email.optional(),
  city: z.string().trim().max(160).optional(),
  state: z.string().trim().max(160).optional(),
  pincode: z.string().regex(/^\d{6}$/).optional(),
  category: z.enum(['general', 'obc', 'sc', 'st', 'ews']).optional(),
  admissionType: z.enum(['new', 'transfer', 'readmission']).optional(),
  // September 2026: the numbers the admission form already takes. Each is
  // sealed with the application key the moment the server reads it, in the
  // stored preview as well as in the record, and shown as "ending 1234".
  studentAadhaar: AadhaarNumber.optional(),
  guardianAadhaar: AadhaarNumber.optional(),
  guardianPan: PanNumber.optional(),
  guardianOfficeAddress: z.string().trim().max(1000).optional(),
})
export type StudentsBulkImportRow = z.infer<typeof StudentsBulkImportRow>

export const StudentsImportPreviewRequest = z.strictObject({
  academicYearId: Id,
  rows: z.array(StudentsBulkImportRow).min(1).max(500),
}).refine(
  (value) => new Set(value.rows.map((row) => row.rowNumber)).size === value.rows.length,
  'Every row must carry its own sheet row number',
)
export type StudentsImportPreviewRequest = z.infer<typeof StudentsImportPreviewRequest>

/** The cohort a promotion preview is about. All four belong to this school. */
export const StudentsPromotePreviewQuery = z.strictObject({
  fromAcademicYearId: Id,
  toAcademicYearId: Id,
  fromSectionId: Id,
  toSectionId: Id,
  // The cohort is read a page at a time, so a section of any size can be
  // promoted: the screen reads every page and sends runs of at most 100.
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(100),
})
export type StudentsPromotePreviewQuery = z.infer<typeof StudentsPromotePreviewQuery>
