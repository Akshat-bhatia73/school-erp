/** Task 5 request and response contracts owned by the students-bulk module. */
import { z } from 'zod'
import { CalendarDate, DisplayName, Email, Id } from './common.ts'

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
})
export type StudentsPromotePreviewQuery = z.infer<typeof StudentsPromotePreviewQuery>
