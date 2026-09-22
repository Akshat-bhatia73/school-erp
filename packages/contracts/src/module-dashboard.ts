/**
 * The dashboard contract: one response per audience, built only from data the
 * school already keeps. Every block a caller may not read is absent from the
 * response rather than sent as a zero, so a screen never shows a number that
 * stands for "you are not allowed to know".
 */
import { z } from 'zod'
import { CalendarDate, DisplayName, Id } from './common.ts'
import { ConsentPurpose } from './module-lifecycle.ts'
import { AuditEventSummary, EnrollmentSummary, NamedReference, StudentBasic } from './responses.ts'

const Name = z.string().trim().min(1).max(160)

/**
 * The four homes, in the order the server picks one when a member holds more
 * than one role and has not asked for a view: office, accountant, teacher,
 * parent. A caller may ask for any audience their own roles earn and no other.
 */
export const DASHBOARD_AUDIENCES = ['office', 'accountant', 'teacher', 'parent'] as const
export const DashboardAudienceKey = z.enum(DASHBOARD_AUDIENCES)
const ClockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)

/**
 * The day the dashboard is about. A Sunday and a holiday are told apart so the
 * screen can say which one it is, and the next working day is carried so a
 * teacher sees the timetable they will actually teach next.
 */
export const DashboardDay = z.strictObject({
  date: CalendarDate,
  dayOfWeek: z.number().int().min(0).max(6),
  kind: z.enum(['school_day', 'holiday', 'sunday']),
  holidayName: Name.optional(),
  nextSchoolDay: z
    .strictObject({ date: CalendarDate, dayOfWeek: z.number().int().min(1).max(6) })
    .optional(),
})

/** A holiday inside the next thirty days from the dashboard date. */
export const DashboardHoliday = z.strictObject({
  id: Id,
  name: Name,
  startDate: CalendarDate,
  endDate: CalendarDate,
  type: z.enum(['national', 'festival', 'school', 'vacation']),
})
/** The name section 8.2 uses for the same shape. */
export const HolidayAhead = DashboardHoliday

/** Name and class only, for people the caller's plan already lets them read. */
export const DashboardBirthday = z.strictObject({
  kind: z.enum(['student', 'staff']),
  id: Id,
  name: DisplayName,
  className: z.string().max(160).optional(),
  date: CalendarDate,
})

export const DashboardAttentionKey = z.enum([
  'periods_without_cover',
  'students_absent_three_days',
  'invitations_expiring',
  'students_without_guardian_phone',
  'students_without_consent',
  'sections_without_class_teacher',
  'empty_timetable_slots',
  'staff_without_login',
])

export const DashboardAttentionItem = z.strictObject({
  key: DashboardAttentionKey,
  count: z.number().int().nonnegative(),
})

export const DashboardClassStrength = z.strictObject({
  grade: NamedReference,
  sections: z.array(
    z.strictObject({ id: Id, name: Name, count: z.number().int().nonnegative() }),
  ),
})

/** One lesson in a day. `cover` marks a period the caller was handed. */
export const DashboardLesson = z.strictObject({
  section: NamedReference,
  subject: NamedReference,
  roomNumber: z.string().max(100).optional(),
  cover: z.boolean(),
  coveredBy: NamedReference.optional(),
})

/** A bell slot. A `period` with no lesson is a free period. */
export const DashboardTimelineSlot = z.strictObject({
  periodIndex: z.number().int().nonnegative(),
  name: Name,
  startTime: ClockTime,
  endTime: ClockTime,
  type: z.enum(['period', 'break', 'lunch', 'assembly']),
  lesson: DashboardLesson.optional(),
})

/**
 * The roll is a plain count, readable by anyone who may read a student. The
 * gender mix and the month's movements come from the sensitive block of a
 * student record, so they are sent only to a caller who may read that block
 * and are absent otherwise.
 */
const Glance = z.strictObject({
  students: z.strictObject({ total: z.number().int().nonnegative() }),
  mix: z
    .strictObject({
      boys: z.number().int().nonnegative(),
      girls: z.number().int().nonnegative(),
      other: z.number().int().nonnegative(),
    })
    .optional(),
  admittedThisMonth: z.number().int().nonnegative().optional(),
  leftThisMonth: z.number().int().nonnegative().optional(),
})

/** Whole paise. Money is never a fraction and never a float. */
const DashboardPaise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

/**
 * The money cards. Every figure is a sum over the fee rows the caller's own
 * `fees.read` plan allows, so the block is absent for anybody who holds no fee
 * key. Outstanding is what has fallen due by the dashboard's date and is not
 * paid yet, in the current academic year.
 */
export const DashboardFees = z.strictObject({
  collectedTodayPaise: DashboardPaise,
  receiptsToday: z.number().int().nonnegative(),
  collectedThisMonthPaise: DashboardPaise,
  outstandingPaise: DashboardPaise,
  studentsWithDues: z.number().int().nonnegative(),
})

/**
 * Today's attendance for the office: how many of the sections the caller may
 * read are marked, and how many pupils are marked absent. Every figure is a
 * count over the rows the caller's own `attendance.read` plan allows, so the
 * block is absent for anybody who holds no attendance key, and absent on a
 * day that is not a school day.
 */
export const DashboardAttendance = z.strictObject({
  date: CalendarDate,
  sectionsMarked: z.number().int().nonnegative(),
  sectionsTotal: z.number().int().nonnegative(),
  absent: z.number().int().nonnegative(),
})

/** Whether today's register is done for a class teacher's own class. */
export const DashboardClassAttendance = z.strictObject({
  date: CalendarDate,
  marked: z.boolean(),
  absent: z.number().int().nonnegative().optional(),
})

/** This month so far for one child, from the same rule as the calendar screen. */
export const DashboardChildAttendance = z.strictObject({
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  percentage: z.number().min(0).max(100).nullable(),
  present: z.number().int().nonnegative(),
  absent: z.number().int().nonnegative(),
  schoolDays: z.number().int().nonnegative(),
})

export const DashboardSetupStepKey = z.enum(['school', 'years', 'grades', 'sections', 'subjects'])

export const OfficeDashboard = z.strictObject({
  audience: z.literal('office'),
  day: DashboardDay,
  academicYear: NamedReference.nullable(),
  today: z
    .strictObject({
      teachersAway: z.number().int().nonnegative(),
      periodsWithoutCover: z.number().int().nonnegative(),
    })
    .optional(),
  attention: z.array(DashboardAttentionItem),
  glance: Glance.optional(),
  fees: DashboardFees.optional(),
  attendance: DashboardAttendance.optional(),
  studentsPerTeacher: z.number().nonnegative().optional(),
  classStrength: z.array(DashboardClassStrength).optional(),
  admissionsByMonth: z
    .array(
      z.strictObject({
        month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
        count: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  holidays: z.array(DashboardHoliday),
  birthdays: z
    .strictObject({
      today: z.array(DashboardBirthday),
      thisWeek: z.array(DashboardBirthday),
    })
    .optional(),
  recentActivity: z.array(AuditEventSummary).optional(),
  securityEvents: z.array(AuditEventSummary).optional(),
  setup: z
    .strictObject({
      steps: z.array(z.strictObject({ key: DashboardSetupStepKey, done: z.boolean() })),
    })
    .optional(),
})

export const TeacherDashboard = z.strictObject({
  audience: z.literal('teacher'),
  day: DashboardDay,
  staffLinked: z.boolean(),
  academicYearId: Id.nullable(),
  timeline: z.array(DashboardTimelineSlot),
  timelineDate: CalendarDate.nullable(),
  week: z.array(
    z.strictObject({
      dayOfWeek: z.number().int().min(1).max(6),
      periodIndex: z.number().int().nonnegative(),
      section: NamedReference,
      subject: NamedReference,
      roomNumber: z.string().max(100).optional(),
    }),
  ),
  periods: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      name: Name,
      startTime: ClockTime,
      endTime: ClockTime,
      type: z.enum(['period', 'break', 'lunch', 'assembly']),
    }),
  ),
  myClass: z
    .strictObject({
      section: NamedReference,
      strength: z.number().int().nonnegative(),
      /** Absent when the caller may not read the sensitive block of a student record. */
      birthdaysThisWeek: z.array(DashboardBirthday).optional(),
      /** Today's register for this class; absent on a day that is not a school day. */
      attendanceToday: DashboardClassAttendance.optional(),
    })
    .optional(),
  holidays: z.array(DashboardHoliday),
})

export const ParentDashboard = z.strictObject({
  audience: z.literal('parent'),
  day: DashboardDay,
  children: z.array(
    z.strictObject({
      student: StudentBasic,
      enrollment: EnrollmentSummary.optional(),
      classTeacher: NamedReference.optional(),
      todayLessons: z.array(DashboardTimelineSlot).optional(),
      nextHoliday: DashboardHoliday.optional(),
      /** What has fallen due for this child and is not paid yet; needs `fees.read`. */
      feesDuePaise: DashboardPaise.optional(),
      /** This month's attendance so far; needs `attendance.read` on this child. */
      attendance: DashboardChildAttendance.optional(),
      waitingOn: z.array(
        z.strictObject({ kind: z.literal('consent'), purpose: ConsentPurpose }),
      ),
    }),
  ),
})

export const AccountantDashboard = z.strictObject({
  audience: z.literal('accountant'),
  day: DashboardDay,
  glance: Glance.optional(),
  classStrength: z.array(DashboardClassStrength).optional(),
  fees: DashboardFees.optional(),
})

export const DashboardResponse = z.discriminatedUnion('audience', [
  OfficeDashboard,
  TeacherDashboard,
  ParentDashboard,
  AccountantDashboard,
])

export type DashboardAudienceKey = z.infer<typeof DashboardAudienceKey>
export type DashboardDay = z.infer<typeof DashboardDay>
export type DashboardHoliday = z.infer<typeof DashboardHoliday>
export type HolidayAhead = z.infer<typeof DashboardHoliday>
export type DashboardBirthday = z.infer<typeof DashboardBirthday>
export type DashboardAttentionKey = z.infer<typeof DashboardAttentionKey>
export type DashboardAttentionItem = z.infer<typeof DashboardAttentionItem>
export type DashboardClassStrength = z.infer<typeof DashboardClassStrength>
export type DashboardLesson = z.infer<typeof DashboardLesson>
export type DashboardTimelineSlot = z.infer<typeof DashboardTimelineSlot>
export type DashboardFees = z.infer<typeof DashboardFees>
export type DashboardAttendance = z.infer<typeof DashboardAttendance>
export type DashboardClassAttendance = z.infer<typeof DashboardClassAttendance>
export type DashboardChildAttendance = z.infer<typeof DashboardChildAttendance>
export type DashboardGlance = z.infer<typeof Glance>
export type DashboardSetupStepKey = z.infer<typeof DashboardSetupStepKey>
export type OfficeDashboard = z.infer<typeof OfficeDashboard>
export type TeacherDashboard = z.infer<typeof TeacherDashboard>
export type ParentDashboard = z.infer<typeof ParentDashboard>
export type AccountantDashboard = z.infer<typeof AccountantDashboard>
export type DashboardResponse = z.infer<typeof DashboardResponse>
