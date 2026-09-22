/** Named response families used by OPERATION_COVERAGE.md. All are safe projections. */
import { z } from 'zod'
import { Id, Timestamp, pageOf } from './common.ts'
import { SchoolContextResponse, SchoolSummary } from './identity.ts'
import { InvitationSummary, MemberSummary } from './memberships.ts'
import { RoleKey } from './role-templates.ts'
import { DashboardResponse } from './module-dashboard.ts'
import {
  AllowedActions, AuditListResponse, DocumentSummary, EnrollmentSummary,
  GuardianPrivate, NamedReference, StaffDetailResponse, StaffDirectory, StaffListResponse,
  StudentBasic, StudentDetailResponse, StudentListResponse, SubstitutionSummary,
  TeachingAssignmentSummary, TimetableCell, TimetableResponse,
  ExportFileFormat, ExportJobSummary,
} from './responses.ts'

export const AuthenticatedContext = SchoolContextResponse
export const DashboardByAudience = DashboardResponse
export const AuditEventPage = AuditListResponse
export const MembershipDirectory = pageOf(MemberSummary)
export const MembershipDetail = MemberSummary
export const InvitationCreated = InvitationSummary
export const FixedRoleSummaryList = z.array(z.strictObject({
  key: RoleKey, name: z.string().max(160), enabled: z.boolean(), requiredMfa: z.boolean(),
}))
export const StaffDirectoryPage = StaffListResponse
// The office never types the employee code, so the create response carries the
// assigned one: the screen shows it without a second read.
export const StaffEmploymentCreated = StaffDirectory.extend({
  employeeCode: z.string().max(100),
})
export const StaffDetailByAudience = StaffDetailResponse
export const StudentRosterPage = StudentListResponse
export const StudentCreated = StudentBasic
export const StudentDetailByAudience = StudentDetailResponse
export const StudentBasicDetail = StudentBasic
export const GuardianDetail = GuardianPrivate
export const GuardianDetailList = z.array(GuardianPrivate)
export const AuthorizedSiblingList = z.array(StudentBasic)
export const StudentDocumentMetadataList = z.array(DocumentSummary)
export const EnrollmentSummaryList = z.array(EnrollmentSummary)
export const TeachingAssignmentList = z.array(TeachingAssignmentSummary)
export const SectionTeachingAssignmentList = TeachingAssignmentList
export const SectionTimetable = TimetableResponse
export const StaffTimetable = TimetableResponse
export const TimetableEntry = TimetableCell
export const Substitution = SubstitutionSummary
export const SubstitutionDay = z.strictObject({ substitutions: z.array(SubstitutionSummary), allowedActions: AllowedActions })
export const AbsentTeacherPeriodList = z.array(TimetableCell)
export const EmptySuccess = z.null()
export const BulkCommitResult = z.strictObject({ created: z.number().int().nonnegative() })
export const PromotionResult = z.strictObject({ promoted: z.number().int().nonnegative(), detained: z.number().int().nonnegative() })
export const PromotionPreview = z.strictObject({
  students: z.array(StudentBasic).max(100), targetSection: NamedReference,
  // Every student of the cohort the caller may read, across all pages.
  total: z.number().int().nonnegative(), page: z.number().int().min(1), pageSize: z.number().int().min(1).max(100),
})
/** One row that passed. A missing admissionNumber is assigned at commit. */
export const StudentImportPreviewRow = z.strictObject({
  rowNumber: z.number().int().positive(),
  firstName: z.string().max(160),
  lastName: z.string().max(160).optional(),
  admissionNumber: z.string().max(100).optional(),
})
export const StudentImportPreview = z.strictObject({
  id: Id, version: z.number().int().positive(), expiresAt: Timestamp,
  totalRows: z.number().int().nonnegative(), validRows: z.number().int().nonnegative(),
  rows: z.array(StudentImportPreviewRow),
  errors: z.array(z.strictObject({ row: z.number().int().positive(), field: z.string().max(100), message: z.string().max(500) })),
})
export const AuthorizedCount = z.strictObject({ count: z.number().int().nonnegative() })
export const DepartmentSuggestionList = z.array(z.string().max(160)).max(100)
export const StudentSearchResults = z.array(StudentBasic).max(100)
export const StaffSearchResults = z.array(StaffDirectory).max(100)
/**
 * A job that is ready also says what the file is called and which of the two
 * formats it is, so the screen can name the download without a second read.
 * Both fields are absent while the job is queued and on every terminal state
 * that produced nothing, which is why they stay optional.
 */
// Defined in responses.ts so a module contract can name them without importing
// this file, which sits at the end of the import graph.
export { ExportFileFormat, ExportJobSummary }
export const StudentExportJob = ExportJobSummary
export const StaffExportJob = ExportJobSummary
export const AuditExportJob = ExportJobSummary
export const TimetableGenerationResult = z.strictObject({ placed: z.number().int().nonnegative(), unplaced: z.number().int().nonnegative() })
export const NotificationMarkResult = z.strictObject({ queued: z.number().int().nonnegative() })
export const TimetableConflictList = z.array(z.strictObject({
  kind: z.enum(['teacher_busy', 'section_busy', 'teacher_not_assigned']),
  dayOfWeek: z.number().int().min(1).max(6), periodIndex: z.number().int().nonnegative(),
  section: NamedReference, teacher: NamedReference.optional(),
}))
export const TeacherLoadList = z.array(z.strictObject({
  teacher: NamedReference, periodsPerWeek: z.number().int().nonnegative(),
  sectionsCount: z.number().int().nonnegative(), subjectsCount: z.number().int().nonnegative(),
}))
export const AvailableTeacherSuggestionList = z.array(z.strictObject({
  teacher: NamedReference, teachesSubject: z.boolean(), periodsPerWeek: z.number().int().nonnegative(),
})).max(100)
/** These two families are for separate operator tooling, never ordinary HTTP school APIs. */
export const OperatorSchoolList = z.array(SchoolSummary)
export const OperatorSchoolCreated = SchoolSummary
