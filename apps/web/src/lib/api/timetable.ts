/** Bell schedules, the weekly grid, conflicts, loads and substitutions.
 *  Mirrors apps/api/src/modules/timetable (bell.ts, grid.ts, substitutions.ts). */
import {
  AbsentTeacherPeriodList,
  AvailableTeacherSuggestionList,
  BellSchedule,
  BellScheduleList,
  ExportJobSummary,
  NotificationMarkResult,
  SectionTimetable,
  StaffTimetable,
  Substitution,
  SubstitutionDay,
  TeacherLoadList,
  TimetableBellScheduleRequest,
  TimetableBellScheduleUpdateRequest,
  TimetableConflictList,
  TimetableEntry,
  TimetableEntryRequest,
  TimetableExportRequest,
  TimetableGenerateRequest,
  TimetableGenerationResult,
  TimetableNotifyRequest,
  TimetableSubstitutionRequest,
} from '@erp/contracts'
import type { z } from 'zod'
import { request } from '@/lib/http'
import { schoolPath, seg, withQuery } from './shared'

export type YearParams = { academicYearId: string }
export type BellScheduleRecord = z.infer<typeof BellSchedule>
export type NewBellSchedule = z.input<typeof TimetableBellScheduleRequest>
export type UpdateBellScheduleInput = z.input<typeof TimetableBellScheduleUpdateRequest>
export type TimetableGrid = z.infer<typeof SectionTimetable>
export type TimetableCellRecord = z.infer<typeof TimetableEntry>
export type SetEntryInput = z.input<typeof TimetableEntryRequest>
export type EntrySlotParams = {
  academicYearId: string
  sectionId: string
  dayOfWeek: number
  periodIndex: number
}
export type FreeTeacherParams = {
  academicYearId: string
  dayOfWeek: number
  periodIndex: number
  subjectId?: string
}
export type FreeTeacher = z.infer<typeof AvailableTeacherSuggestionList>[number]
export type TimetableConflict = z.infer<typeof TimetableConflictList>[number]
export type TeacherLoad = z.infer<typeof TeacherLoadList>[number]
export type GenerateInput = z.input<typeof TimetableGenerateRequest>
export type SubstitutionRecord = z.infer<typeof Substitution>
export type CreateSubstitutionInput = z.input<typeof TimetableSubstitutionRequest>
export type NotifyInput = z.input<typeof TimetableNotifyRequest>
export type ExportTimetableInput = z.input<typeof TimetableExportRequest>

const base = (schoolId: string, suffix = '') => schoolPath(schoolId, `/timetable${suffix}`)

// ---------- bell schedules ----------

export function bellSchedules(schoolId: string, params: YearParams) {
  return request(withQuery(base(schoolId, '/bell-schedules'), { ...params }), { schema: BellScheduleList })
}

export function bellScheduleForGrade(schoolId: string, gradeId: string, params: YearParams) {
  return request(withQuery(base(schoolId, `/bell-schedules/for-grade/${seg(gradeId)}`), { ...params }), { schema: BellSchedule })
}

export function createBellSchedule(schoolId: string, body: NewBellSchedule) {
  return request(base(schoolId, '/bell-schedules'), { method: 'POST', body, schema: BellSchedule })
}

export function updateBellSchedule(schoolId: string, bellScheduleId: string, body: UpdateBellScheduleInput) {
  return request(base(schoolId, `/bell-schedules/${seg(bellScheduleId)}`), { method: 'PUT', body, schema: BellSchedule })
}

// ---------- the grid ----------

export function forSection(schoolId: string, sectionId: string, params: YearParams) {
  return request(withQuery(base(schoolId, `/sections/${seg(sectionId)}`), { ...params }), { schema: SectionTimetable })
}

export function forStaff(schoolId: string, staffId: string, params: YearParams) {
  return request(withQuery(base(schoolId, `/staff/${seg(staffId)}`), { ...params }), { schema: StaffTimetable })
}

export function freeTeachers(schoolId: string, params: FreeTeacherParams) {
  return request(withQuery(base(schoolId, '/free-teachers'), { ...params }), { schema: AvailableTeacherSuggestionList })
}

export function setEntry(schoolId: string, body: SetEntryInput) {
  return request(base(schoolId, '/entries'), { method: 'PUT', body, schema: TimetableEntry })
}

export async function clearEntry(schoolId: string, params: EntrySlotParams): Promise<void> {
  await request(withQuery(base(schoolId, '/entries'), { ...params }), { method: 'DELETE' })
}

export function generate(schoolId: string, sectionId: string, body: GenerateInput) {
  return request(base(schoolId, `/sections/${seg(sectionId)}/generate`), { method: 'POST', body, schema: TimetableGenerationResult })
}

export function conflicts(schoolId: string, params: YearParams) {
  return request(withQuery(base(schoolId, '/conflicts'), { ...params }), { schema: TimetableConflictList })
}

export function teacherLoads(schoolId: string, params: YearParams) {
  return request(withQuery(base(schoolId, '/teacher-loads'), { ...params }), { schema: TeacherLoadList })
}

/** The week currently on screen, as a spreadsheet or a PDF. Exporting is reading, in another
 *  format, so it asks for nothing beyond the timetable read the screen already made. */
export function exportTimetable(schoolId: string, body: ExportTimetableInput) {
  return request(base(schoolId, '/export'), { method: 'POST', body, schema: ExportJobSummary })
}

// ---------- substitutions ----------

export function substitutions(schoolId: string, date: string) {
  return request(withQuery(base(schoolId, '/substitutions'), { date }), { schema: SubstitutionDay })
}

export function absentPeriods(schoolId: string, params: { staffId: string; date: string }) {
  return request(withQuery(base(schoolId, '/substitutions/absent-periods'), { ...params }), { schema: AbsentTeacherPeriodList })
}

export function createSubstitution(schoolId: string, body: CreateSubstitutionInput) {
  return request(base(schoolId, '/substitutions'), { method: 'POST', body, schema: Substitution })
}

export async function deleteSubstitution(schoolId: string, substitutionId: string): Promise<void> {
  await request(base(schoolId, `/substitutions/${seg(substitutionId)}`), { method: 'DELETE' })
}

export function notifySubstitutions(schoolId: string, body: NotifyInput) {
  return request(base(schoolId, '/substitutions/notify'), { method: 'POST', body, schema: NotificationMarkResult })
}
