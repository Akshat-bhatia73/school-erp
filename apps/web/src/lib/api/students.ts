/** The student roster, one student's record, and bulk admission, promotion and export.
 *  Mirrors apps/api/src/modules/students and apps/api/src/modules/students-bulk. */
import {
  AnonymiseRequest,
  AuthorizedCount,
  AuthorizedSiblingList,
  BulkCommitResult,
  CommitStudentImportRequest,
  ConsentList,
  ConsentRecord,
  EndEnrollmentRequest,
  EnrollmentSummaryList,
  ExportStudentsRequest,
  GuardianDetail,
  GuardianDetailList,
  MoveStudentRequest,
  PromoteStudentsRequest,
  PromotionPreview,
  PromotionResult,
  RecordConsentRequest,
  StudentApaarReveal,
  StudentBasicDetail,
  StudentCreated,
  StudentDetailByAudience,
  StudentDetailResponse,
  StudentDocumentMetadataList,
  StudentExportJob,
  StudentImportPreview,
  StudentListRequest,
  StudentRosterPage,
  StudentSearchResults,
  StudentsAddGuardianRequest,
  StudentsAdmitRequest,
  StudentsImportPreviewRequest,
  StudentsUpdateGuardianRequest,
  StudentsUpdateSensitiveRequest,
  UnlinkGuardianRequest,
  UpdateStudentBasicRequest,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type StudentListParams = z.input<typeof StudentListRequest>
export type StudentCountParams = {
  search?: string
  sectionId?: string
  academicYearId?: string
  status?: 'active' | 'left' | 'alumni' | 'suspended'
}
export type StudentRoster = z.infer<typeof StudentRosterPage>
export type StudentDetail = z.infer<typeof StudentDetailByAudience>
export type StudentSummary = z.infer<typeof StudentBasicDetail>
export type Guardian = z.infer<typeof GuardianDetail>
export type StudentDocument = z.infer<typeof StudentDocumentMetadataList>[number]
export type Enrollment = z.infer<typeof EnrollmentSummaryList>[number]
export type AdmitStudentInput = z.input<typeof StudentsAdmitRequest>
export type UpdateStudentBasicInput = z.input<typeof UpdateStudentBasicRequest>
export type UpdateStudentSensitiveInput = z.input<typeof StudentsUpdateSensitiveRequest>
export type MoveStudentInput = z.input<typeof MoveStudentRequest>
export type LeaveStudentInput = z.input<typeof EndEnrollmentRequest>
export type AddGuardianInput = z.input<typeof StudentsAddGuardianRequest>
export type UpdateGuardianInput = z.input<typeof StudentsUpdateGuardianRequest>
export type ImportPreviewInput = z.input<typeof StudentsImportPreviewRequest>
export type ImportPreview = z.infer<typeof StudentImportPreview>
export type ImportCommitInput = z.input<typeof CommitStudentImportRequest>
export type PromotePreviewParams = {
  fromAcademicYearId: string
  toAcademicYearId: string
  fromSectionId: string
  toSectionId: string
}
export type PromoteInput = z.input<typeof PromoteStudentsRequest>
export type ExportStudentsInput = z.input<typeof ExportStudentsRequest>
export type ConsentRecordEntry = z.infer<typeof ConsentRecord>
export type Consents = z.infer<typeof ConsentList>
export type RecordConsentInput = z.input<typeof RecordConsentRequest>
export type AnonymiseInput = z.input<typeof AnonymiseRequest>
export type UnlinkGuardianInput = z.input<typeof UnlinkGuardianRequest>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/students${suffix}`)

export function list(schoolId: string, params: StudentListParams = {}) {
  return request(withQuery(base(schoolId), { ...params }), { schema: StudentRosterPage })
}

export function count(schoolId: string, params: StudentCountParams = {}) {
  return request(withQuery(base(schoolId, '/count'), { ...params }), { schema: AuthorizedCount })
}

export function search(schoolId: string, q: string) {
  return request(withQuery(base(schoolId, '/search'), { q }), { schema: StudentSearchResults })
}

export function get(schoolId: string, studentId: string) {
  return request(base(schoolId, `/${seg(studentId)}`), { schema: StudentDetailByAudience })
}

export function guardians(schoolId: string, studentId: string) {
  return request(base(schoolId, `/${seg(studentId)}/guardians`), { schema: GuardianDetailList })
}

export function siblings(schoolId: string, studentId: string) {
  return request(base(schoolId, `/${seg(studentId)}/siblings`), { schema: AuthorizedSiblingList })
}

export function documents(schoolId: string, studentId: string) {
  return request(base(schoolId, `/${seg(studentId)}/documents`), { schema: StudentDocumentMetadataList })
}

export function enrollments(schoolId: string, studentId: string) {
  return request(base(schoolId, `/${seg(studentId)}/enrollments`), { schema: EnrollmentSummaryList })
}

/** The newest consent event per guardian and purpose, with what this person may do with them. */
export function consents(schoolId: string, studentId: string) {
  return request(base(schoolId, `/${seg(studentId)}/consents`), { schema: ConsentList })
}

// ---------- writes ----------

export function create(schoolId: string, body: AdmitStudentInput) {
  return request(base(schoolId), { method: 'POST', body, schema: StudentCreated })
}

export function updateBasic(schoolId: string, studentId: string, body: UpdateStudentBasicInput) {
  return request(base(schoolId, `/${seg(studentId)}`), { method: 'PUT', body, schema: StudentBasicDetail })
}

export function updateSensitive(schoolId: string, studentId: string, body: UpdateStudentSensitiveInput) {
  return request(base(schoolId, `/${seg(studentId)}/sensitive`), { method: 'PUT', body, schema: StudentBasicDetail })
}

export async function move(schoolId: string, studentId: string, body: MoveStudentInput): Promise<void> {
  await request(base(schoolId, `/${seg(studentId)}/move`), { method: 'POST', body })
}

export async function leave(schoolId: string, studentId: string, body: LeaveStudentInput): Promise<void> {
  await request(base(schoolId, `/${seg(studentId)}/leave`), { method: 'POST', body })
}

export function addGuardian(schoolId: string, studentId: string, body: AddGuardianInput) {
  return request(base(schoolId, `/${seg(studentId)}/guardians`), { method: 'POST', body, schema: GuardianDetail })
}

export function updateGuardian(schoolId: string, studentId: string, guardianId: string, body: UpdateGuardianInput) {
  return request(base(schoolId, `/${seg(studentId)}/guardians/${seg(guardianId)}`), { method: 'PUT', body, schema: GuardianDetail })
}

export function recordConsent(schoolId: string, studentId: string, body: RecordConsentInput) {
  return request(base(schoolId, `/${seg(studentId)}/consents`), { method: 'POST', body, schema: ConsentList })
}

/**
 * The full APAAR id, on demand and audited. Never cache this answer: the screen shows it once and
 * forgets it when the record is closed.
 */
export function revealApaar(schoolId: string, studentId: string) {
  return request(base(schoolId, `/${seg(studentId)}/apaar`), { schema: StudentApaarReveal })
}

export function anonymise(schoolId: string, studentId: string, body: AnonymiseInput) {
  return request(base(schoolId, `/${seg(studentId)}/anonymise`), { method: 'POST', body, schema: StudentDetailResponse })
}

export function unlinkGuardian(schoolId: string, studentId: string, guardianId: string, body: UnlinkGuardianInput) {
  return request(base(schoolId, `/${seg(studentId)}/guardians/${seg(guardianId)}/unlink`), { method: 'POST', body, schema: StudentDetailResponse })
}

// ---------- bulk ----------

/** Checks an uploaded sheet and stores the rows the server itself validated. */
export function importPreview(schoolId: string, body: ImportPreviewInput) {
  return request(base(schoolId, '/import/preview'), { method: 'POST', body, schema: StudentImportPreview })
}

export function importCommit(schoolId: string, body: ImportCommitInput) {
  return request(base(schoolId, '/import/commit'), { method: 'POST', body, schema: BulkCommitResult })
}

export function promotePreview(schoolId: string, params: PromotePreviewParams) {
  return request(withQuery(base(schoolId, '/promote/preview'), { ...params }), { schema: PromotionPreview })
}

export function promote(schoolId: string, body: PromoteInput) {
  return request(base(schoolId, '/promote'), { method: 'POST', body, schema: PromotionResult })
}

/** Queues an export and returns the job to poll through api.files.exportJob. */
export function exportStudents(schoolId: string, body: ExportStudentsInput) {
  return request(base(schoolId, '/export'), { method: 'POST', body, schema: StudentExportJob })
}
