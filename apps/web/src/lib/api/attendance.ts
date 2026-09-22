/** The attendance registers, a pupil's month, the staff register and the files.
 *  Mirrors apps/api/src/modules/attendance. */
import {
  AttendanceCorrectionRequest,
  AttendanceDayResponse,
  AttendanceExportJob,
  AttendanceMarkRequest,
  AttendancePupilMonthExportRequest,
  AttendanceRegisterExportRequest,
  AttendanceSectionMonthResponse,
  AttendanceSectionsResponse,
  AttendanceStudentMonthResponse,
  StaffAttendanceCorrectionRequest,
  StaffAttendanceDayResponse,
  StaffAttendanceMarkRequest,
  StaffAttendanceMemberMonthResponse,
  StaffAttendanceMonthResponse,
  StaffAttendanceRegisterExportRequest,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type AttendanceSectionsResult = z.infer<typeof AttendanceSectionsResponse>
export type AttendanceSectionDayRow = AttendanceSectionsResult['items'][number]
export type AttendanceDayResult = z.infer<typeof AttendanceDayResponse>
export type AttendanceRosterRowRecord = AttendanceDayResult['rows'][number]
export type AttendanceStudentMonthResult = z.infer<typeof AttendanceStudentMonthResponse>
export type AttendanceSectionMonthResult = z.infer<typeof AttendanceSectionMonthResponse>
export type StaffAttendanceDayResult = z.infer<typeof StaffAttendanceDayResponse>
export type StaffAttendanceRowRecord = StaffAttendanceDayResult['rows'][number]
export type StaffAttendanceMonthResult = z.infer<typeof StaffAttendanceMonthResponse>
export type StaffAttendanceMemberMonthResult = z.infer<typeof StaffAttendanceMemberMonthResponse>

export type AttendanceMarkInput = z.input<typeof AttendanceMarkRequest>
export type AttendanceCorrectionInput = z.input<typeof AttendanceCorrectionRequest>
export type StaffAttendanceMarkInput = z.input<typeof StaffAttendanceMarkRequest>
export type StaffAttendanceCorrectionInput = z.input<typeof StaffAttendanceCorrectionRequest>
export type AttendanceRegisterExportInput = z.input<typeof AttendanceRegisterExportRequest>
export type AttendancePupilMonthExportInput = z.input<typeof AttendancePupilMonthExportRequest>
export type StaffAttendanceRegisterExportInput = z.input<typeof StaffAttendanceRegisterExportRequest>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/attendance${suffix}`)
const staffBase = (schoolId: string, suffix = '') => schoolPath(schoolId, `/staff-attendance${suffix}`)

// ---------- the pupil register ----------

export function sections(schoolId: string, params: { date?: string } = {}) {
  return request(withQuery(base(schoolId, '/sections'), { ...params }), { schema: AttendanceSectionsResponse })
}

export function day(schoolId: string, sectionId: string, date: string) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/days/${seg(date)}`), { schema: AttendanceDayResponse })
}

/** Marking a day is one write of the whole roster: every pupil on it, nobody else. */
export function mark(schoolId: string, sectionId: string, date: string, body: AttendanceMarkInput) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/days/${seg(date)}`), { method: 'PUT', body, schema: AttendanceDayResponse })
}

/** A correction names only the rows that change, and the reason goes to the audit note. */
export function correct(schoolId: string, sectionId: string, date: string, body: AttendanceCorrectionInput) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/days/${seg(date)}/corrections`), { method: 'POST', body, schema: AttendanceDayResponse })
}

export function studentMonth(schoolId: string, studentId: string, month: string) {
  return request(base(schoolId, `/students/${seg(studentId)}/months/${seg(month)}`), { schema: AttendanceStudentMonthResponse })
}

export function sectionMonth(schoolId: string, sectionId: string, month: string) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/months/${seg(month)}`), { schema: AttendanceSectionMonthResponse })
}

// ---------- the staff register ----------

export function staffDay(schoolId: string, date: string) {
  return request(staffBase(schoolId, `/days/${seg(date)}`), { schema: StaffAttendanceDayResponse })
}

export function markStaff(schoolId: string, date: string, body: StaffAttendanceMarkInput) {
  return request(staffBase(schoolId, `/days/${seg(date)}`), { method: 'PUT', body, schema: StaffAttendanceDayResponse })
}

export function correctStaff(schoolId: string, date: string, body: StaffAttendanceCorrectionInput) {
  return request(staffBase(schoolId, `/days/${seg(date)}/corrections`), { method: 'POST', body, schema: StaffAttendanceDayResponse })
}

export function staffMonth(schoolId: string, month: string) {
  return request(staffBase(schoolId, `/months/${seg(month)}`), { schema: StaffAttendanceMonthResponse })
}

export function staffMemberMonth(schoolId: string, staffId: string, month: string) {
  return request(staffBase(schoolId, `/staff/${seg(staffId)}/months/${seg(month)}`), { schema: StaffAttendanceMemberMonthResponse })
}

// ---------- files ----------

export function exportSectionMonth(schoolId: string, sectionId: string, month: string, body: AttendanceRegisterExportInput) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/months/${seg(month)}/export`), { method: 'POST', body, schema: AttendanceExportJob })
}

/** The pupil and the month are in the path, so there is nothing to send. */
export function exportStudentMonth(schoolId: string, studentId: string, month: string) {
  return request(base(schoolId, `/students/${seg(studentId)}/months/${seg(month)}/export`), { method: 'POST', body: {}, schema: AttendanceExportJob })
}

export function exportStaffMonth(schoolId: string, month: string, body: StaffAttendanceRegisterExportInput) {
  return request(staffBase(schoolId, `/months/${seg(month)}/export`), { method: 'POST', body, schema: AttendanceExportJob })
}
