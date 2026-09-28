/** Leave the office records ahead of time, for pupils and for staff.
 *  Mirrors apps/api/src/modules/attendance (the leave routes). A write answers with the record. */
import {
  LeaveApplicationDecideRequest,
  LeaveApplicationListRequest,
  LeaveApplicationWithdrawRequest,
  LeaveCancelRequest,
  StaffLeaveApplication,
  StaffLeaveApplicationList,
  StaffLeaveApplyRequest,
  LeaveListRequest,
  StaffLeaveCreateRequest,
  StaffLeaveListResponse,
  StaffLeaveRecord,
  StudentLeaveApplication,
  StudentLeaveApplicationList,
  StudentLeaveApplyRequest,
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

export type LeaveApplicationListParams = z.input<typeof LeaveApplicationListRequest>
export type StudentApplication = z.infer<typeof StudentLeaveApplication>
export type StaffApplication = z.infer<typeof StaffLeaveApplication>
export type StudentApplicationList = z.infer<typeof StudentLeaveApplicationList>
export type StaffApplicationList = z.infer<typeof StaffLeaveApplicationList>
export type StudentApplyInput = z.input<typeof StudentLeaveApplyRequest>
export type StaffApplyInput = z.input<typeof StaffLeaveApplyRequest>
export type LeaveDecideInput = z.input<typeof LeaveApplicationDecideRequest>
export type LeaveWithdrawInput = z.input<typeof LeaveApplicationWithdrawRequest>

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

// ---------- applications ----------
//
// A parent applies for their own child and a staff member for themselves; the class teacher or the
// office decides a pupil's, the office a staff member's. Every write answers with the application.

const pupilApplications = (schoolId: string, suffix = '') => schoolPath(schoolId, `/leave-applications/pupils${suffix}`)
const staffApplications = (schoolId: string, suffix = '') => schoolPath(schoolId, `/leave-applications/staff${suffix}`)

export const applications = {
  pupils: {
    list: (schoolId: string, params: LeaveApplicationListParams = {}) =>
      request(withQuery(pupilApplications(schoolId), { ...params }), { schema: StudentLeaveApplicationList }),
    apply: (schoolId: string, body: StudentApplyInput) =>
      request(pupilApplications(schoolId), { method: 'POST', body, schema: StudentLeaveApplication }),
    decide: (schoolId: string, applicationId: string, body: LeaveDecideInput) =>
      request(pupilApplications(schoolId, `/${seg(applicationId)}/decide`), { method: 'POST', body, schema: StudentLeaveApplication }),
    withdraw: (schoolId: string, applicationId: string, body: LeaveWithdrawInput) =>
      request(pupilApplications(schoolId, `/${seg(applicationId)}/withdraw`), { method: 'POST', body, schema: StudentLeaveApplication }),
  },
  staff: {
    list: (schoolId: string, params: LeaveApplicationListParams = {}) =>
      request(withQuery(staffApplications(schoolId), { ...params }), { schema: StaffLeaveApplicationList }),
    /** The server finds the caller's own staff record; nobody applies for somebody else. */
    apply: (schoolId: string, body: StaffApplyInput) =>
      request(staffApplications(schoolId), { method: 'POST', body, schema: StaffLeaveApplication }),
    decide: (schoolId: string, applicationId: string, body: LeaveDecideInput) =>
      request(staffApplications(schoolId, `/${seg(applicationId)}/decide`), { method: 'POST', body, schema: StaffLeaveApplication }),
    withdraw: (schoolId: string, applicationId: string, body: LeaveWithdrawInput) =>
      request(staffApplications(schoolId, `/${seg(applicationId)}/withdraw`), { method: 'POST', body, schema: StaffLeaveApplication }),
  },
}
