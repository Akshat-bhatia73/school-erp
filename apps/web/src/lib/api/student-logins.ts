/** A pupil's own login, as the office manages it. Mirrors the student login routes in apps/api. */
import {
  IssueStudentLoginsResult,
  StudentLoginView,
  type SwitchOffStudentLoginRequest,
  type SwitchOnStudentLoginRequest,
} from '@erp/contracts'
import { request } from '@/lib/http'
import { schoolPath, seg } from './shared'

export type StudentLogin = StudentLoginView
export type StudentLoginsIssued = IssueStudentLoginsResult

const base = (schoolId: string, studentId: string, suffix = '') =>
  schoolPath(schoolId, `/students/${seg(studentId)}/login${suffix}`)

/** The pupil's login: its state, username and school code, and what stands in the way of one. */
export function get(schoolId: string, studentId: string) {
  return request(base(schoolId, studentId), { schema: StudentLoginView })
}

/** Gives the pupil a login; the server texts the password to the primary guardian. */
export function issue(schoolId: string, studentId: string) {
  return request(base(schoolId, studentId), { method: 'POST', body: {}, schema: StudentLoginView })
}

/** Texts a new password to the primary guardian and signs the pupil out everywhere. */
export function resetPassword(schoolId: string, studentId: string) {
  return request(base(schoolId, studentId, '/reset-password'), { method: 'POST', body: {}, schema: StudentLoginView })
}

export function switchOff(schoolId: string, studentId: string, body: SwitchOffStudentLoginRequest) {
  return request(base(schoolId, studentId, '/switch-off'), { method: 'POST', body, schema: StudentLoginView })
}

export function switchOn(schoolId: string, studentId: string, body: SwitchOnStudentLoginRequest) {
  return request(base(schoolId, studentId, '/switch-on'), { method: 'POST', body, schema: StudentLoginView })
}

/** Every eligible pupil without a login gets one. Answers counts only. */
export function issueMissing(schoolId: string) {
  return request(schoolPath(schoolId, '/students/logins/issue'), { method: 'POST', body: {}, schema: IssueStudentLoginsResult })
}
