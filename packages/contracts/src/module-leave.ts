/**
 * Leave recorded ahead of time for a pupil or a staff member (migration 0028).
 *
 * A leave record is a plan, not a mark. For every school day it covers, the
 * register offers "leave" already chosen for that person, and a school day
 * nobody marked counts as leave instead of against them. A mark somebody
 * saved always wins over the plan. Pupil leave sits behind the attendance
 * keys (read, and `attendance.manage` to record or cancel), staff leave
 * behind the staff attendance keys, so the same people who correct a
 * register decide leave for it and a teacher reads the leave of their own
 * sections.
 */
import { z } from 'zod'
import { CalendarDate, DisplayName, Id, Timestamp, Version } from './common.ts'
import { AttendancePupil, AttendanceStaffMember } from './module-attendance.ts'
import { AllowedActions, NamedReference } from './responses.ts'

/** The longest stretch one record covers, in days including both ends. */
export const LEAVE_MAX_DAYS = 180
/** The most records one list answers with. */
export const LEAVE_LIST_MAX = 500

export const LeaveStatus = z.enum(['active', 'cancelled'])
export type LeaveStatus = z.infer<typeof LeaveStatus>

const LeaveReason = z.string().trim().min(1).max(500)

const dayCount = (startsOn: string, endsOn: string) =>
  Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000) + 1

const LeaveDates = z.strictObject({
  startsOn: CalendarDate,
  endsOn: CalendarDate,
  reason: LeaveReason.optional(),
})

const withDateRules = <T extends z.ZodType<{ startsOn: string, endsOn: string }>>(schema: T) =>
  schema
    .refine((value) => value.endsOn >= value.startsOn, { message: 'The last day of leave is before the first', path: ['endsOn'] })
    .refine((value) => dayCount(value.startsOn, value.endsOn) <= LEAVE_MAX_DAYS, {
      message: `Leave is recorded ${LEAVE_MAX_DAYS} days at a time at most`,
      path: ['endsOn'],
    })

export const StudentLeaveCreateRequest = withDateRules(LeaveDates.extend({ studentId: Id }))
export type StudentLeaveCreateRequest = z.infer<typeof StudentLeaveCreateRequest>

export const StaffLeaveCreateRequest = withDateRules(LeaveDates.extend({ staffId: Id }))
export type StaffLeaveCreateRequest = z.infer<typeof StaffLeaveCreateRequest>

/** Cancelling keeps the record; the reason goes on the audit row. */
export const LeaveCancelRequest = z.strictObject({ expectedVersion: Version, reason: LeaveReason.optional() })
export type LeaveCancelRequest = z.infer<typeof LeaveCancelRequest>

/**
 * Records that overlap the range from..to (both optional; with neither, the
 * records that have not ended before today). Cancelled records only when asked.
 */
export const LeaveListRequest = z.strictObject({
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  personId: Id.optional(),
  includeCancelled: z.enum(['true', 'false']).optional(),
})
export type LeaveListRequest = z.infer<typeof LeaveListRequest>

const LeaveCommon = {
  id: Id,
  version: Version,
  startsOn: CalendarDate,
  endsOn: CalendarDate,
  /** Calendar days, both ends included; the school days among them are the register's business. */
  days: z.number().int().positive(),
  reason: LeaveReason.optional(),
  status: LeaveStatus,
  recordedAt: Timestamp,
  recordedBy: DisplayName.optional(),
  cancelledAt: Timestamp.optional(),
  allowedActions: AllowedActions,
}

export const StudentLeaveRecord = z.strictObject({
  ...LeaveCommon,
  student: AttendancePupil,
  /** The pupil's class on the first day of the leave, when the caller may read it. */
  section: NamedReference.optional(),
  grade: NamedReference.optional(),
})
export type StudentLeaveRecord = z.infer<typeof StudentLeaveRecord>

export const StaffLeaveRecord = z.strictObject({
  ...LeaveCommon,
  staff: AttendanceStaffMember,
})
export type StaffLeaveRecord = z.infer<typeof StaffLeaveRecord>

export const StudentLeaveListResponse = z.strictObject({
  items: z.array(StudentLeaveRecord).max(LEAVE_LIST_MAX),
  allowedActions: AllowedActions,
})
export type StudentLeaveListResponse = z.infer<typeof StudentLeaveListResponse>

export const StaffLeaveListResponse = z.strictObject({
  items: z.array(StaffLeaveRecord).max(LEAVE_LIST_MAX),
  allowedActions: AllowedActions,
})
export type StaffLeaveListResponse = z.infer<typeof StaffLeaveListResponse>

/**
 * Who is on leave today, for the office dashboard: counts over the caller's own
 * read plans and the first few names of each. Absent for anybody who holds
 * neither read key at school scope.
 */
export const DashboardLeaveToday = z.strictObject({
  date: CalendarDate,
  staff: z.strictObject({
    count: z.number().int().nonnegative(),
    names: z.array(z.strictObject({ id: Id, name: DisplayName, endsOn: CalendarDate })).max(10),
  }).optional(),
  students: z.strictObject({
    count: z.number().int().nonnegative(),
    names: z.array(z.strictObject({ id: Id, name: DisplayName, section: DisplayName.optional(), endsOn: CalendarDate })).max(10),
  }).optional(),
})
export type DashboardLeaveToday = z.infer<typeof DashboardLeaveToday>
