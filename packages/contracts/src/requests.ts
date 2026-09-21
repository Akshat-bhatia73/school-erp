import { z } from 'zod'
import { CalendarDate, DisplayName, Id, IdList, PageRequest, Phone, Reason, Version } from './common.ts'

export const StudentListRequest = PageRequest.extend({
  search: z.string().trim().max(100).optional(),
  sectionId: Id.optional(), academicYearId: Id.optional(),
  status: z.enum(['active', 'left', 'alumni', 'suspended']).optional(),
  sort: z.enum(['name', 'admission', 'roll']).default('name'),
})
export const StaffListRequest = PageRequest.extend({
  search: z.string().trim().max(100).optional(),
  department: z.string().trim().max(100).optional(),
  sort: z.enum(['name', 'employee_code']).default('name'),
})
export const UpdateStudentBasicRequest = z.strictObject({
  expectedVersion: Version, firstName: DisplayName.optional(), lastName: DisplayName.optional(),
}).refine((value) => value.firstName !== undefined || value.lastName !== undefined, 'Supply at least one editable field')
export const UpdateStaffPrivateRequest = z.strictObject({
  expectedVersion: Version, phone: Phone.optional(), address: z.string().trim().max(1000).optional(),
}).refine((value) => value.phone !== undefined || value.address !== undefined, 'Supply at least one editable field')
export const UpdateStaffPayRequest = z.strictObject({
  expectedVersion: Version, monthlySalary: z.number().nonnegative(), reason: Reason,
})
export const MoveStudentRequest = z.strictObject({
  expectedVersion: Version, sectionId: Id, rollNumber: z.number().int().positive().optional(), reason: Reason,
})
export const EndEnrollmentRequest = z.strictObject({ expectedVersion: Version, leftOn: CalendarDate, reason: Reason })
export const TeachingAssignmentRequest = z.strictObject({
  expectedVersion: Version, staffId: Id, sectionId: Id, subjectId: Id,
  academicYearId: Id, validFrom: CalendarDate, validUntil: CalendarDate.nullable(), reason: Reason,
}).refine((value) => value.validUntil === null || value.validUntil >= value.validFrom, 'Assignment end precedes start')
export const PromoteStudentsRequest = z.strictObject({
  fromAcademicYearId: Id, toAcademicYearId: Id, fromSectionId: Id, toSectionId: Id,
  // A student of the section may be in neither list: the office can leave
  // somebody out of this run and decide later. Either list may therefore be
  // empty, but a request that names nobody at all does nothing and is refused.
  studentIds: z.array(Id).max(100), detainedStudentIds: z.array(Id).max(100), reason: Reason,
}).superRefine((value, ctx) => {
  if (value.fromAcademicYearId === value.toAcademicYearId) ctx.addIssue({ code: 'custom', message: 'Promotion needs a different academic year' })
  if (value.studentIds.length + value.detainedStudentIds.length === 0) ctx.addIssue({ code: 'custom', message: 'Choose at least one student to promote or detain' })
  if (new Set(value.studentIds).size !== value.studentIds.length) ctx.addIssue({ code: 'custom', message: 'Promoted and detained sets must be unique and disjoint' })
  if (new Set(value.detainedStudentIds).size !== value.detainedStudentIds.length || value.detainedStudentIds.some((id) => value.studentIds.includes(id))) {
    ctx.addIssue({ code: 'custom', message: 'Promoted and detained sets must be unique and disjoint' })
  }
})
/** The server stores/revalidates preview rows; do not trust client-submitted "valid" rows. */
export const CommitStudentImportRequest = z.strictObject({ previewId: Id, expectedVersion: Version })
export const ExportStudentsRequest = z.strictObject({ studentIds: IdList })

export type StudentListRequest = z.infer<typeof StudentListRequest>
export type TeachingAssignmentRequest = z.infer<typeof TeachingAssignmentRequest>
