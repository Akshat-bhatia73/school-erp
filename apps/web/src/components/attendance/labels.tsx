/** The words, the short letters and the colours every attendance screen shares. */
import type { AttendanceMark, ErrorReason } from '@erp/contracts'
import { Tag, type TagColor } from '@/components/shared/tag'

/**
 * Said when a save is refused because somebody saved these marks after the screen read them.
 * The screen refetches at the same time, so the newer marks are already showing.
 */
export const STALE_MARKS_MESSAGE = 'Somebody else saved these marks first. The latest marks are now shown; check them and save again.'

export const MARK_LABEL: Record<AttendanceMark, string> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  leave: 'Leave',
  half_day: 'Half day',
}

/** One or two letters for a month grid, where a column is only a few pixels wide. */
export const MARK_SHORT: Record<AttendanceMark, string> = {
  present: 'P',
  absent: 'A',
  late: 'L',
  leave: 'LV',
  half_day: 'H',
}

export const MARK_COLOR: Record<AttendanceMark, TagColor> = {
  present: 'green',
  absent: 'red',
  late: 'orange',
  leave: 'blue',
  half_day: 'purple',
}

export function MarkTag({ mark }: { mark: AttendanceMark }) {
  return <Tag color={MARK_COLOR[mark]}>{MARK_LABEL[mark]}</Tag>
}

/** "94.2%", or an em dash when there was no school day to count. */
export function Percentage({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground/60">—</span>
  return <span className="tabular-nums">{value.toFixed(1)}%</span>
}

/**
 * The server's reason for refusing a register, in one plain sentence each. A window carries the
 * reason it is shut, so a screen says why in the same words the API would have used.
 */
export const REASON_TEXT: Partial<Record<ErrorReason, string>> = {
  attendance_date_outside_year: 'This date is not in an academic year, so there is no register for it.',
  attendance_not_a_school_day: 'There is no school on this day, so there is nothing to mark.',
  attendance_date_in_future: 'This day has not happened yet. The register opens on the day itself.',
  attendance_marking_window_closed: 'The day for marking this register has passed. The office can still correct it.',
  attendance_pupil_not_on_roster: 'This pupil was not in this class on this day.',
  attendance_roster_incomplete: 'Every pupil on the roster has to be marked in one go.',
  attendance_month_outside_year: 'This month is not in an academic year.',
  staff_attendance_own_record: 'Nobody marks their own attendance. A colleague in the office does it.',
  staff_attendance_not_on_register: 'This person was not on the staff register on this day.',
  staff_attendance_register_incomplete: 'Everybody on the register has to be marked in one go.',
}

/** The sentence for a shut window, or nothing when the server gave no reason. */
export function windowReason(window: { recordBlockedBy?: ErrorReason; correctBlockedBy?: ErrorReason }): string | undefined {
  const reason = window.recordBlockedBy ?? window.correctBlockedBy
  return reason ? REASON_TEXT[reason] : undefined
}
