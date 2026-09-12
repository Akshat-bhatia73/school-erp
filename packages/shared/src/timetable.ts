import { z } from 'zod'
import { ISODate, Id, TenantRecord } from './common'

/** 1 = Monday ... 6 = Saturday. Sunday is never a school day here. */
export const DayOfWeek = z.number().int().min(1).max(6)
export type DayOfWeek = z.infer<typeof DayOfWeek>
export const DAY_LABELS: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' }

export const PeriodType = z.enum(['period', 'break', 'lunch', 'assembly'])
export type PeriodType = z.infer<typeof PeriodType>

/** One slot in the school day, e.g. "Period 3, 09:20–10:00" or "Lunch" */
export const Period = z.object({
  index: z.number().int().min(0), // position in the day, 0-based
  name: z.string(), // "Period 1", "Break", "Lunch"
  startTime: z.string().regex(/^\d{2}:\d{2}$/), // "08:00"
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  type: PeriodType,
})
export type Period = z.infer<typeof Period>

/**
 * The bell schedule: which periods exist and on which days.
 * A school can have more than one (e.g. Primary and Senior wing), each applying to some grades.
 */
export const BellSchedule = TenantRecord.extend({
  academicYearId: Id,
  name: z.string(), // "Main schedule", "Primary wing"
  gradeIds: z.array(Id), // grades this applies to; empty = all grades not covered elsewhere
  workingDays: z.array(DayOfWeek), // [1,2,3,4,5,6]
  periods: z.array(Period),
  /** Saturday often has fewer periods. If set, Saturday uses only periods with index < this. */
  saturdayPeriodCount: z.number().int().optional(),
})
export type BellSchedule = z.infer<typeof BellSchedule>

/** Section X has Subject Y with Teacher Z on Day D at Period P */
export const TimetableEntry = TenantRecord.extend({
  academicYearId: Id,
  sectionId: Id,
  dayOfWeek: DayOfWeek,
  periodIndex: z.number().int().min(0),
  subjectId: Id,
  staffId: Id.optional(), // may be unassigned
  roomNumber: z.string().optional(),
})
export type TimetableEntry = z.infer<typeof TimetableEntry>

/** A one-day arrangement when the regular teacher is away */
export const Substitution = TenantRecord.extend({
  date: ISODate,
  sectionId: Id,
  periodIndex: z.number().int().min(0),
  subjectId: Id,
  absentStaffId: Id,
  substituteStaffId: Id.optional(), // undefined = "free period / self study"
  reason: z.string().optional(), // "On leave", "Exam duty"
  notified: z.boolean().default(false),
})
export type Substitution = z.infer<typeof Substitution>

export const BellScheduleInput = BellSchedule.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true })
export type BellScheduleInput = z.infer<typeof BellScheduleInput>
export const TimetableEntryInput = TimetableEntry.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true, academicYearId: true })
export type TimetableEntryInput = z.infer<typeof TimetableEntryInput>
export const SubstitutionInput = Substitution.omit({ id: true, createdAt: true, updatedAt: true, schoolId: true })
export type SubstitutionInput = z.infer<typeof SubstitutionInput>

/** Why a slot cannot be set */
export interface TimetableConflict {
  kind: 'teacher_busy' | 'section_busy' | 'teacher_not_assigned'
  message: string
  dayOfWeek: number
  periodIndex: number
  staffId?: string
  sectionId?: string
}

/** Read model: how many periods a teacher has per week, and where */
export interface TeacherLoad {
  staffId: string
  periodsPerWeek: number
  sectionsCount: number
  subjectsCount: number
  /** periods per day, index 1..6 */
  perDay: Record<number, number>
  maxPerWeek: number // school policy, e.g. 30
}
