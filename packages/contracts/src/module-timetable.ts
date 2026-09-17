/** Task 5 request and response contracts owned by the timetable module. */
import { z } from 'zod'
import { CalendarDate, Id, Reason, Version } from './common.ts'
import { BellSchedule } from './school.ts'

/** 1 = Monday ... 6 = Saturday. Sunday is never a school day. */
export const TimetableDayOfWeek = z.number().int().min(1).max(6)
export const TimetablePeriodIndex = z.number().int().min(0).max(60)

/** The bell schedule fields a caller may choose. Identity and version are ours. */
export const TimetableBellScheduleRequest = BellSchedule.omit({
  id: true,
  schoolId: true,
  version: true,
})

/**
 * The update body carries the version the caller read. bell_schedules has no
 * version column yet, so every schedule reports version 1 and the route refuses
 * any other expectedVersion as bad input rather than pretending to check it.
 */
export const TimetableBellScheduleUpdateRequest = TimetableBellScheduleRequest.extend({
  expectedVersion: Version,
})

/** One slot of one section's week. The slot keys are the identity. */
export const TimetableEntryRequest = z.strictObject({
  academicYearId: Id,
  sectionId: Id,
  dayOfWeek: TimetableDayOfWeek,
  periodIndex: TimetablePeriodIndex,
  subjectId: Id,
  staffId: Id.optional(),
  roomNumber: z.string().trim().min(1).max(100).optional(),
})

export const TimetableEntrySlotQuery = z.strictObject({
  academicYearId: Id,
  sectionId: Id,
  dayOfWeek: TimetableDayOfWeek,
  periodIndex: TimetablePeriodIndex,
})

export const TimetableYearQuery = z.strictObject({ academicYearId: Id })

export const TimetableFreeTeacherQuery = z.strictObject({
  academicYearId: Id,
  dayOfWeek: TimetableDayOfWeek,
  periodIndex: TimetablePeriodIndex,
  subjectId: Id.optional(),
})

export const TimetableGenerateRequest = z.strictObject({
  academicYearId: Id,
  reason: Reason,
})

export const TimetableDateQuery = z.strictObject({ date: CalendarDate })

export const TimetableAbsentPeriodQuery = z.strictObject({
  staffId: Id,
  date: CalendarDate,
})

export const TimetableSubstitutionRequest = z.strictObject({
  date: CalendarDate,
  sectionId: Id,
  periodIndex: TimetablePeriodIndex,
  subjectId: Id,
  absentStaffId: Id,
  substituteStaffId: Id.optional(),
  reason: z.string().trim().min(1).max(500).optional(),
})

export const TimetableNotifyRequest = z.strictObject({ date: CalendarDate })

export type TimetableBellScheduleRequest = z.infer<typeof TimetableBellScheduleRequest>
export type TimetableBellScheduleUpdateRequest = z.infer<typeof TimetableBellScheduleUpdateRequest>
export type TimetableEntryRequest = z.infer<typeof TimetableEntryRequest>
export type TimetableSubstitutionRequest = z.infer<typeof TimetableSubstitutionRequest>
