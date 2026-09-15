/** The staff directory, one person's record and teaching assignments.
 *  Mirrors apps/api/src/modules/staff/routes.ts. */
import {
  AuthorizedCount,
  DepartmentSuggestionList,
  SectionTeachingAssignmentList,
  StaffCreateRequest,
  StaffDetailByAudience,
  StaffDirectoryPage,
  StaffEmploymentCreated,
  StaffExportJob,
  StaffExportRequest,
  StaffListRequest,
  StaffSearchResults,
  StaffUpdateEmploymentRequest,
  TeachingAssignmentList,
  TeachingAssignmentRequest,
  UpdateStaffPayRequest,
  UpdateStaffPrivateRequest,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type StaffListParams = z.input<typeof StaffListRequest>
export type StaffPage = z.infer<typeof StaffDirectoryPage>
export type StaffDetail = z.infer<typeof StaffDetailByAudience>
export type StaffSummary = z.infer<typeof StaffEmploymentCreated>
export type TeachingAssignment = z.infer<typeof TeachingAssignmentList>[number]
export type CreateStaffInput = z.input<typeof StaffCreateRequest>
export type UpdateEmploymentInput = z.input<typeof StaffUpdateEmploymentRequest>
export type UpdatePrivateInput = z.input<typeof UpdateStaffPrivateRequest>
export type UpdatePayInput = z.input<typeof UpdateStaffPayRequest>
export type AssignTeachingInput = z.input<typeof TeachingAssignmentRequest>
export type ExportStaffInput = z.input<typeof StaffExportRequest>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/staff${suffix}`)

export function list(schoolId: string, params: StaffListParams = {}) {
  return request(withQuery(base(schoolId), { ...params }), { schema: StaffDirectoryPage })
}

export function count(schoolId: string) {
  return request(base(schoolId, '/count'), { schema: AuthorizedCount })
}

export function search(schoolId: string, q: string) {
  return request(withQuery(base(schoolId, '/search'), { q }), { schema: StaffSearchResults })
}

/** The department names already in use, for a suggestion list. */
export function departments(schoolId: string) {
  return request(base(schoolId, '/departments'), { schema: DepartmentSuggestionList })
}

export function get(schoolId: string, staffId: string) {
  return request(base(schoolId, `/${seg(staffId)}`), { schema: StaffDetailByAudience })
}

export function assignments(schoolId: string, staffId: string) {
  return request(base(schoolId, `/${seg(staffId)}/assignments`), { schema: TeachingAssignmentList })
}

export function sectionAssignments(schoolId: string, sectionId: string) {
  return request(schoolPath(schoolId, `/sections/${seg(sectionId)}/assignments`), { schema: SectionTeachingAssignmentList })
}

// ---------- writes ----------

export function create(schoolId: string, body: CreateStaffInput) {
  return request(base(schoolId), { method: 'POST', body, schema: StaffEmploymentCreated })
}

export function updateEmployment(schoolId: string, staffId: string, body: UpdateEmploymentInput) {
  return request(base(schoolId, `/${seg(staffId)}/employment`), { method: 'PUT', body, schema: StaffDetailByAudience })
}

export function updatePrivate(schoolId: string, staffId: string, body: UpdatePrivateInput) {
  return request(base(schoolId, `/${seg(staffId)}/private`), { method: 'PUT', body, schema: StaffDetailByAudience })
}

export function updatePay(schoolId: string, staffId: string, body: UpdatePayInput) {
  return request(base(schoolId, `/${seg(staffId)}/pay`), { method: 'PUT', body, schema: StaffDetailByAudience })
}

export function assign(schoolId: string, staffId: string, body: AssignTeachingInput) {
  return request(base(schoolId, `/${seg(staffId)}/assignments`), { method: 'PUT', body, schema: TeachingAssignmentList })
}

export async function unassign(schoolId: string, staffId: string, assignmentId: string): Promise<void> {
  await request(base(schoolId, `/${seg(staffId)}/assignments/${seg(assignmentId)}`), { method: 'DELETE' })
}

export function exportStaff(schoolId: string, body: ExportStaffInput) {
  return request(base(schoolId, '/export'), { method: 'POST', body, schema: StaffExportJob })
}
