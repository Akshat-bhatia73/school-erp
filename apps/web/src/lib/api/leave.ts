/** Leave the office records ahead of time, for pupils and for staff.
 *  Mirrors apps/api/src/modules/attendance (the leave routes). A write answers with the record. */
import {
  LeaveCancelRequest,
  LeaveListRequest,
  StaffLeaveCreateRequest,
  StaffLeaveListResponse,
  StaffLeaveRecord,
  StudentLeaveCreateRequest,
  StudentLeaveListResponse,
  StudentLeaveRecord,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type LeaveListParams = z.input<typeof LeaveListRequest>
export type StudentLeaveList = z.infer<typeof StudentLeaveListResponse>
export type StaffLeaveList = z.infer<typeof StaffLeaveListResponse>
export type StudentLeave = z.infer<typeof StudentLeaveRecord>
export type StaffLeave = z.infer<typeof StaffLeaveRecord>
export type StudentLeaveInput = z.input<typeof StudentLeaveCreateRequest>
export type StaffLeaveInput = z.input<typeof StaffLeaveCreateRequest>
export type LeaveCancelInput = z.input<typeof LeaveCancelRequest>

const pupils = (schoolId: string, suffix = '') => schoolPath(schoolId, `/attendance/leave${suffix}`)
const staffBase = (schoolId: string, suffix = '') => schoolPath(schoolId, `/staff-attendance/leave${suffix}`)

// ---------- pupils ----------

export function listStudents(schoolId: string, params: LeaveListParams = {}) {
  return request(withQuery(pupils(schoolId), { ...params }), { schema: StudentLeaveListResponse })
}

export function createStudent(schoolId: string, body: StudentLeaveInput) {
  return request(pupils(schoolId), { method: 'POST', body, schema: StudentLeaveRecord })
}

/** Cancelling keeps the record; nothing is ever deleted. */
export function cancelStudent(schoolId: string, leaveId: string, body: LeaveCancelInput) {
  return request(pupils(schoolId, `/${seg(leaveId)}/cancel`), { method: 'POST', body, schema: StudentLeaveRecord })
}

// ---------- staff ----------

export function listStaff(schoolId: string, params: LeaveListParams = {}) {
  return request(withQuery(staffBase(schoolId), { ...params }), { schema: StaffLeaveListResponse })
}

export function createStaff(schoolId: string, body: StaffLeaveInput) {
  return request(staffBase(schoolId), { method: 'POST', body, schema: StaffLeaveRecord })
}

export function cancelStaff(schoolId: string, leaveId: string, body: LeaveCancelInput) {
  return request(staffBase(schoolId, `/${seg(leaveId)}/cancel`), { method: 'POST', body, schema: StaffLeaveRecord })
}
