/** Task 20 request and response contracts owned by the attendance module. */
import { z } from 'zod'
import { CalendarDate, DisplayName, Id, Reason, Timestamp } from './common.ts'
import { ErrorReason } from './errors.ts'
import { AllowedActions, ExportFileFormat, ExportJobSummary, NamedReference } from './responses.ts'

/**
 * The five marks. In the monthly percentage, present and late count as a
 * full day, half_day as half a day, leave is left out of the denominator and
 * absent counts against.
 */
export const AttendanceMark = z.enum(['present', 'absent', 'late', 'leave', 'half_day'])
export type AttendanceMark = z.infer<typeof AttendanceMark>
export const ATTENDANCE_MARKS = AttendanceMark.options

/** A calendar month, `YYYY-MM`. */
export const AttendanceMonth = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/)

/** What a day is on the school calendar, as the register sees it. */
export const AttendanceDayKind = z.enum(['school_day', 'sunday', 'holiday', 'outside_year'])
export type AttendanceDayKind = z.infer<typeof AttendanceDayKind>

/** One day of a month, as a calendar or a register draws it. */
export const AttendanceCalendarDay = z.strictObject({
  date: CalendarDate,
  kind: AttendanceDayKind,
  holidayName: DisplayName.optional(),
  /** True for a day after today in the school's timezone. */
  future: z.boolean(),
})
export type AttendanceCalendarDay = z.infer<typeof AttendanceCalendarDay>

/**
 * The counts one month adds up to, and the percentage they make. School days
 * are the days of the academic year in the month that are not Sundays or
 * holidays, up to today, on which the pupil (or staff member) was on the
 * roster. An unmarked school day is neither present nor leave, so it counts
 * against, and it is reported so a screen can say why a figure is low.
 */
export const AttendanceSummary = z.strictObject({
  schoolDays: z.number().int().nonnegative(),
  present: z.number().int().nonnegative(),
  absent: z.number().int().nonnegative(),
  late: z.number().int().nonnegative(),
  leave: z.number().int().nonnegative(),
  halfDay: z.number().int().nonnegative(),
  unmarked: z.number().int().nonnegative(),
  /** To one decimal place; null when there is no school day to count. */
  percentage: z.number().min(0).max(100).nullable(),
})
export type AttendanceSummary = z.infer<typeof AttendanceSummary>

/**
 * The one percentage rule, shared by the API, the files and the screens:
 * (present + late + half of half_day) over (school days less leave days), to
 * one decimal place, and null when nothing is there to count.
 */
export function attendancePercentage(counts: {
  readonly schoolDays: number
  readonly present: number
  readonly late: number
  readonly halfDay: number
  readonly leave: number
}): number | null {
  const denominator = counts.schoolDays - counts.leave
  if (denominator <= 0) return null
  const attended = counts.present + counts.late + counts.halfDay / 2
  const value = Math.round((attended / denominator) * 1000) / 10
  return Math.min(100, Math.max(0, value))
}

/** The pupil a mark belongs to, named no further than a roster names them. */
export const AttendancePupil = z.strictObject({
  id: Id,
  name: DisplayName,
  admissionNumber: z.string().min(1).max(100),
  rollNumber: z.number().int().positive().optional(),
})
export type AttendancePupil = z.infer<typeof AttendancePupil>

/** The stored row behind a current mark: which revision, by whom, when. */
export const AttendanceEntryRef = z.strictObject({
  id: Id,
  revision: z.number().int().positive(),
  /** 'marking' by whoever marks the register, 'correction' by the office with a reason. */
  kind: z.enum(['marking', 'correction']),
  recordedAt: Timestamp,
})
export type AttendanceEntryRef = z.infer<typeof AttendanceEntryRef>

// ---------------------------------------------------------------------------
// The day list: which sections are marked.

export const AttendanceSectionsRequest = z.strictObject({ date: CalendarDate.optional() })
export type AttendanceSectionsRequest = z.infer<typeof AttendanceSectionsRequest>

export const AttendanceSectionDay = z.strictObject({
  section: NamedReference,
  grade: NamedReference,
  /** Pupils on the roster that day. */
  strength: z.number().int().nonnegative(),
  marked: z.boolean(),
  /** Counts over the current marks, present only when the day is marked. */
  counts: z
    .strictObject({
      present: z.number().int().nonnegative(),
      absent: z.number().int().nonnegative(),
      late: z.number().int().nonnegative(),
      leave: z.number().int().nonnegative(),
      halfDay: z.number().int().nonnegative(),
    })
    .optional(),
  lastRecordedAt: Timestamp.optional(),
  allowedActions: AllowedActions,
})
export type AttendanceSectionDay = z.infer<typeof AttendanceSectionDay>

export const AttendanceSectionsResponse = z.strictObject({
  date: CalendarDate,
  day: AttendanceCalendarDay,
  academicYear: NamedReference.nullable(),
  items: z.array(AttendanceSectionDay).max(500),
})
export type AttendanceSectionsResponse = z.infer<typeof AttendanceSectionsResponse>

// ---------------------------------------------------------------------------
// One section on one day: the roster and its marks.

export const AttendanceRosterRow = z.strictObject({
  student: AttendancePupil,
  /** Absent when nobody has marked this pupil on this day yet. */
  mark: AttendanceMark.optional(),
  entry: AttendanceEntryRef.optional(),
})
export type AttendanceRosterRow = z.infer<typeof AttendanceRosterRow>

/**
 * What the server will accept for this day from this caller, worked out once
 * here so the screen and the write agree. `record` is true only on today (in
 * the school's timezone) for a school day inside the year; `correct` is true
 * for any school day up to today. Each carries the reason it is not, from the
 * closed list, so the screen can say why in the server's words.
 */
export const AttendanceDayWindow = z.strictObject({
  record: z.boolean(),
  recordBlockedBy: ErrorReason.optional(),
  correct: z.boolean(),
  correctBlockedBy: ErrorReason.optional(),
})
export type AttendanceDayWindow = z.infer<typeof AttendanceDayWindow>

export const AttendanceDayResponse = z.strictObject({
  section: NamedReference,
  grade: NamedReference,
  academicYear: NamedReference,
  date: CalendarDate,
  day: AttendanceCalendarDay,
  window: AttendanceDayWindow,
  marked: z.boolean(),
  rows: z.array(AttendanceRosterRow).max(200),
  allowedActions: AllowedActions,
})
export type AttendanceDayResponse = z.infer<typeof AttendanceDayResponse>

/**
 * The revision of the pupil's current mark the writer read (0 when there was
 * none). When sent, the server refuses the whole write with VERSION_CONFLICT
 * if the mark has moved since, so a register read before somebody else saved
 * never overwrites their marks. Optional only so an older screen still saves.
 */
export const ExpectedRevision = z.number().int().nonnegative()

export const AttendanceMarkLine = z.strictObject({
  studentId: Id,
  mark: AttendanceMark,
  expectedRevision: ExpectedRevision.optional(),
})
const AttendanceMarkLines = z
  .array(AttendanceMarkLine)
  .min(1)
  .max(200)
  .refine((lines) => new Set(lines.map((line) => line.studentId)).size === lines.length, 'A pupil may appear once')

/**
 * Marking a day is one write of the whole roster: every pupil enrolled in the
 * section on that date, and nobody else. The server derives the roster from
 * the enrolments and refuses a body that names anybody else or leaves anybody
 * out. There is no reason: this is the register, not a correction.
 */
export const AttendanceMarkRequest = z.strictObject({ marks: AttendanceMarkLines })
export type AttendanceMarkRequest = z.infer<typeof AttendanceMarkRequest>

/**
 * A correction names only the pupils being corrected, each of whom must be on
 * that day's roster, and the reason somebody typed. The reason goes to the
 * audit note and is stored nowhere else.
 */
export const AttendanceCorrectionRequest = z.strictObject({ marks: AttendanceMarkLines, reason: Reason })
export type AttendanceCorrectionRequest = z.infer<typeof AttendanceCorrectionRequest>

// ---------------------------------------------------------------------------
// A pupil's month, and a section's month.

export const AttendanceMonthDay = AttendanceCalendarDay.extend({
  /** False when the pupil was not on this section's roster that day. */
  enrolled: z.boolean(),
  mark: AttendanceMark.optional(),
  /** True when the current mark is an office correction. */
  corrected: z.boolean().optional(),
})
export type AttendanceMonthDay = z.infer<typeof AttendanceMonthDay>

export const AttendanceStudentMonthResponse = z.strictObject({
  student: AttendancePupil,
  academicYear: NamedReference,
  month: AttendanceMonth,
  /** The class the pupil sat in during the month, when the caller may read it. */
  section: NamedReference.optional(),
  grade: NamedReference.optional(),
  days: z.array(AttendanceMonthDay).max(31),
  summary: AttendanceSummary,
  allowedActions: AllowedActions,
})
export type AttendanceStudentMonthResponse = z.infer<typeof AttendanceStudentMonthResponse>

export const AttendanceRegisterRow = z.strictObject({
  student: AttendancePupil,
  /** One entry per day of the month, in date order, matching `days`. */
  marks: z.array(
    z.strictObject({
      date: CalendarDate,
      enrolled: z.boolean(),
      mark: AttendanceMark.optional(),
      corrected: z.boolean().optional(),
    }),
  ).max(31),
  summary: AttendanceSummary,
})
export type AttendanceRegisterRow = z.infer<typeof AttendanceRegisterRow>

export const AttendanceRegisterDay = AttendanceCalendarDay.extend({
  /** True when at least one pupil has a mark that day. */
  marked: z.boolean(),
})

export const AttendanceSectionMonthResponse = z.strictObject({
  section: NamedReference,
  grade: NamedReference,
  academicYear: NamedReference,
  month: AttendanceMonth,
  days: z.array(AttendanceRegisterDay).max(31),
  rows: z.array(AttendanceRegisterRow).max(200),
  allowedActions: AllowedActions,
})
export type AttendanceSectionMonthResponse = z.infer<typeof AttendanceSectionMonthResponse>

/** One year of a pupil's marks, for the subject-access export. */
export const AttendanceYearRecord = z.strictObject({
  academicYear: NamedReference,
  marks: z.array(z.strictObject({ date: CalendarDate, mark: AttendanceMark, corrected: z.boolean() })).max(400),
  summary: AttendanceSummary,
})
export type AttendanceYearRecord = z.infer<typeof AttendanceYearRecord>

// ---------------------------------------------------------------------------
// The staff register.

export const AttendanceStaffMember = z.strictObject({
  id: Id,
  name: DisplayName,
  employeeCode: z.string().min(1).max(100),
  designation: z.string().max(160).optional(),
})
export type AttendanceStaffMember = z.infer<typeof AttendanceStaffMember>

export const StaffAttendanceRow = z.strictObject({
  staff: AttendanceStaffMember,
  mark: AttendanceMark.optional(),
  entry: AttendanceEntryRef.optional(),
  /** True on the caller's own row, which nobody marks for themselves. */
  self: z.boolean(),
})
export type StaffAttendanceRow = z.infer<typeof StaffAttendanceRow>

export const StaffAttendanceDayResponse = z.strictObject({
  date: CalendarDate,
  day: AttendanceCalendarDay,
  window: AttendanceDayWindow,
  marked: z.boolean(),
  rows: z.array(StaffAttendanceRow).max(500),
  allowedActions: AllowedActions,
})
export type StaffAttendanceDayResponse = z.infer<typeof StaffAttendanceDayResponse>

/** `expectedRevision` works as on AttendanceMarkLine. */
export const StaffAttendanceMarkLine = z.strictObject({
  staffId: Id,
  mark: AttendanceMark,
  expectedRevision: ExpectedRevision.optional(),
})
const StaffAttendanceMarkLines = z
  .array(StaffAttendanceMarkLine)
  .min(1)
  .max(500)
  .refine((lines) => new Set(lines.map((line) => line.staffId)).size === lines.length, 'A staff member may appear once')

/**
 * Marking the staff register is one write of everybody on it that day, except
 * the caller's own row: nobody marks their own attendance.
 */
export const StaffAttendanceMarkRequest = z.strictObject({ marks: StaffAttendanceMarkLines })
export type StaffAttendanceMarkRequest = z.infer<typeof StaffAttendanceMarkRequest>

export const StaffAttendanceCorrectionRequest = z.strictObject({ marks: StaffAttendanceMarkLines, reason: Reason })
export type StaffAttendanceCorrectionRequest = z.infer<typeof StaffAttendanceCorrectionRequest>

export const StaffAttendanceMonthDay = AttendanceCalendarDay.extend({
  /** False when the person was not on the register that day. */
  onRegister: z.boolean(),
  mark: AttendanceMark.optional(),
  corrected: z.boolean().optional(),
})

export const StaffAttendanceMemberMonthResponse = z.strictObject({
  staff: AttendanceStaffMember,
  academicYear: NamedReference,
  month: AttendanceMonth,
  days: z.array(StaffAttendanceMonthDay).max(31),
  summary: AttendanceSummary,
  allowedActions: AllowedActions,
})
export type StaffAttendanceMemberMonthResponse = z.infer<typeof StaffAttendanceMemberMonthResponse>

export const StaffAttendanceRegisterRow = z.strictObject({
  staff: AttendanceStaffMember,
  marks: z.array(
    z.strictObject({
      date: CalendarDate,
      onRegister: z.boolean(),
      mark: AttendanceMark.optional(),
      corrected: z.boolean().optional(),
    }),
  ).max(31),
  summary: AttendanceSummary,
})

export const StaffAttendanceMonthResponse = z.strictObject({
  academicYear: NamedReference,
  month: AttendanceMonth,
  days: z.array(AttendanceRegisterDay).max(31),
  rows: z.array(StaffAttendanceRegisterRow).max(500),
  allowedActions: AllowedActions,
})
export type StaffAttendanceMonthResponse = z.infer<typeof StaffAttendanceMonthResponse>

// ---------------------------------------------------------------------------
// Files.

/** A section's month as a spreadsheet or a document. */
export const AttendanceRegisterExportRequest = z.strictObject({ format: ExportFileFormat })
export type AttendanceRegisterExportRequest = z.infer<typeof AttendanceRegisterExportRequest>

/** One pupil's month as a document. The pupil and the month are in the path. */
export const AttendancePupilMonthExportRequest = z.strictObject({})
export type AttendancePupilMonthExportRequest = z.infer<typeof AttendancePupilMonthExportRequest>

export const StaffAttendanceRegisterExportRequest = z.strictObject({ format: ExportFileFormat })
export type StaffAttendanceRegisterExportRequest = z.infer<typeof StaffAttendanceRegisterExportRequest>

export const AttendanceExportJob = ExportJobSummary
