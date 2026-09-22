import { sql, type SQL } from 'drizzle-orm'
import {
  AuthorizationError,
  attendanceScopedTable,
  planPredicate,
  scopedTableFor,
  staffAttendanceScopedTable,
  type AuthzConnection,
} from '@erp/authz'
import { attendancePercentage, type AttendanceCalendarDay, type AttendanceSummary } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure, readPlan, schoolToday } from '../shared/index.ts'

/**
 * Attendance figures, in one place.
 *
 * Nothing about a percentage is stored. Which days are school days follows
 * from the academic year and the holidays; who was on a roster follows from
 * the enrolments (or the staff record); what the mark is follows from the
 * newest row of the register. The day list, the roster, a pupil's month, a
 * section's month, the dashboard, the files and the subject-access export all
 * read the common table expressions here, so two screens can never disagree.
 *
 * The rule, decided by the product owner: a school day is a day in the
 * academic year that is not a Sunday and not a holiday; present and late count
 * as a full day, half_day as half a day, leave is left out of the denominator
 * and absent counts against. Percentage = (present + late + half of half_day)
 * over (school days minus leave days). Two refinements, decided while building
 * it: a day after today (in the school's timezone) is not counted yet, and a
 * day on which the pupil was not enrolled is not theirs to be counted for. An
 * unmarked past school day counts against, and is reported as unmarked so a
 * screen can say why.
 */

export { schoolToday }

/** The tenant transaction an attendance read or write runs on. */
export type AttendanceConnection = AuthzConnection

/** The month a `YYYY-MM` string names, as its first and last day. */
export function monthBounds(month: string): { from: string; to: string } {
  const year = Number(month.slice(0, 4))
  const monthIndex = Number(month.slice(5, 7))
  const last = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

/**
 * The predicates every attendance read is built from. Each is a SQL boolean
 * over an unaliased table, exactly as the authorizer names it, so a query
 * ANDs it into a WHERE clause or an EXISTS over that table.
 */
export interface AttendancePlans {
  /** Over `attendance_entries`: the marks this caller may read. */
  readonly entries: SQL
  /** Over `sections`: the registers this caller may read. */
  readonly rosters: SQL
  /**
   * Over `students`: the pupils this caller may read attendance for AND may
   * name (the `students.read_basic` plan), so a row carries a name only when
   * the roster would.
   */
  readonly pupils: SQL
  /** Over `holidays`: the calendar this caller may read; FALSE when none. */
  readonly holidays: SQL
}

/** A plan that the caller does not hold at all reads as FALSE, not as an error. */
async function predicateOrFalse(build: () => Promise<SQL>): Promise<SQL> {
  try {
    return await build()
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'ACCESS_DENIED') return sql`FALSE`
    throw error
  }
}

function table(kind: 'student' | 'holiday') {
  const scoped = scopedTableFor(kind)
  if (!scoped) throw new Error(`the authorizer has no scoped table for ${kind}`)
  return scoped
}

/** The plans of one caller under `attendance.read`. Throws when they hold none. */
export async function attendancePlans(
  conn: AttendanceConnection,
  context: RequestContext,
  permission: 'attendance.read' | 'attendance.record' | 'attendance.manage' | 'attendance.export' = 'attendance.read',
): Promise<AttendancePlans> {
  const plan = await readPlan(conn, context, permission, 'attendance')
  const basic = await readPlan(conn, context, 'students.read_basic', 'student')
  return {
    entries: planPredicate(plan, attendanceScopedTable('entry')),
    rosters: planPredicate(plan, attendanceScopedTable('roster')),
    pupils: sql`(${planPredicate(plan, attendanceScopedTable('pupil'))}) AND (${planPredicate(basic, table('student'))})`,
    holidays: await predicateOrFalse(async () =>
      planPredicate(await readPlan(conn, context, 'holidays.read', 'holiday'), table('holiday')),
    ),
  }
}

export interface StaffAttendancePlans {
  /** Over `staff_attendance_entries`. */
  readonly entries: SQL
  /** Over `staff`: the people this caller may read the register of AND may name. */
  readonly people: SQL
  readonly holidays: SQL
}

/** The plans of one caller under a `staff_attendance` key. */
export async function staffAttendancePlans(
  conn: AttendanceConnection,
  context: RequestContext,
  permission:
    | 'staff_attendance.read'
    | 'staff_attendance.record'
    | 'staff_attendance.manage'
    | 'staff_attendance.export' = 'staff_attendance.read',
): Promise<StaffAttendancePlans> {
  const plan = await readPlan(conn, context, permission, 'staff_attendance')
  const directory = await readPlan(conn, context, 'staff.read_directory', 'staff')
  const staffTable = scopedTableFor('staff')
  if (!staffTable) throw new Error('the authorizer has no scoped table for staff')
  return {
    entries: planPredicate(plan, staffAttendanceScopedTable('entry')),
    people: sql`(${planPredicate(plan, staffAttendanceScopedTable('person'))}) AND (${planPredicate(directory, staffTable)})`,
    holidays: await predicateOrFalse(async () =>
      planPredicate(await readPlan(conn, context, 'holidays.read', 'holiday'), table('holiday')),
    ),
  }
}

// ---------------------------------------------------------------------------
// The calendar.

export interface CalendarInput {
  readonly schoolId: string
  readonly from: string
  readonly to: string
  /** Today in the school's timezone; days after it are `future`. */
  readonly asOf: string
  /** Over the unaliased `holidays` table. */
  readonly holidays: SQL
}

/**
 * The `WITH att_days` prefix: one row per calendar day between `from` and
 * `to` (inclusive), with the kind of day it is on this school's calendar.
 *
 * `att_days (day, kind, holiday_name, academic_year_id, future)`, where kind
 * is 'outside_year', 'sunday', 'holiday' or 'school_day', in that order of
 * precedence. A holiday the caller may not read is not a holiday to them,
 * exactly as the dashboard treats it.
 */
export function calendarDaysCte(input: CalendarInput): SQL {
  const school = sql`${input.schoolId}::uuid`
  return sql`att_days AS (
      SELECT series.day::date AS day,
             CASE WHEN ay.id IS NULL THEN 'outside_year'
                  WHEN extract(dow FROM series.day) = 0 THEN 'sunday'
                  WHEN hol.name IS NOT NULL THEN 'holiday'
                  ELSE 'school_day' END AS kind,
             hol.name AS holiday_name,
             ay.id AS academic_year_id,
             (series.day::date > ${input.asOf}::date) AS future
        FROM generate_series(${input.from}::date, ${input.to}::date, interval '1 day') AS series(day)
        LEFT JOIN LATERAL (
          SELECT id FROM academic_years
           WHERE school_id = ${school} AND start_date <= series.day::date AND end_date >= series.day::date
           ORDER BY start_date DESC, id LIMIT 1
        ) ay ON TRUE
        LEFT JOIN LATERAL (
          SELECT holidays.name FROM holidays
           WHERE holidays.school_id = ${school}
             AND holidays.start_date <= series.day::date AND holidays.end_date >= series.day::date
             AND (${input.holidays})
           ORDER BY holidays.start_date, holidays.id LIMIT 1
        ) hol ON TRUE
    )`
}

/** One row of `att_days`, as the driver returns it. */
export interface CalendarDayRow extends Record<string, unknown> {
  day: string
  kind: AttendanceCalendarDay['kind']
  holiday_name: string | null
  academic_year_id: string | null
  future: boolean
}

export function toCalendarDay(row: CalendarDayRow): AttendanceCalendarDay {
  return {
    date: row.day,
    kind: row.kind,
    ...(row.holiday_name === null ? {} : { holidayName: row.holiday_name.slice(0, 160) }),
    future: row.future,
  }
}

/** The calendar between two dates, as rows. */
export async function readCalendar(
  conn: AttendanceConnection,
  input: CalendarInput,
): Promise<CalendarDayRow[]> {
  const rows = await conn.db.execute<CalendarDayRow>(
    sql`WITH ${calendarDaysCte(input)}
        SELECT to_char(day, 'YYYY-MM-DD') AS day, kind, holiday_name, academic_year_id, future
          FROM att_days ORDER BY day`,
  )
  return rows.rows
}

/** One day of the calendar, or a refused request when it is not a date. */
export async function readCalendarDay(
  conn: AttendanceConnection,
  input: Omit<CalendarInput, 'from' | 'to'> & { readonly date: string },
): Promise<CalendarDayRow> {
  const rows = await readCalendar(conn, { ...input, from: input.date, to: input.date })
  const row = rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  return row
}

// ---------------------------------------------------------------------------
// Pupils: the current marks and the figures.

export interface AttendanceFiguresInput extends CalendarInput {
  /**
   * Over the unaliased `enrollments` table: which enrolment spans are in
   * scope. It MUST already contain the caller's plan over the pupil, for
   * example `EXISTS (SELECT 1 FROM students WHERE students.school_id =
   * enrollments.school_id AND students.id = enrollments.student_id AND
   * <plans.pupils>)`, and the caller ANDs its own filters (one section, one
   * pupil, one year) into it.
   */
  readonly spans: SQL
  /** Over the unaliased `attendance_entries` table: `plans.entries`. */
  readonly entries: SQL
}

/**
 * The `WITH ...` prefix of a pupil attendance statement. After it a query may
 * read:
 *
 * - `att_days`: the calendar above.
 * - `att_spans (student_id, section_id, academic_year_id, from_on, to_on)`:
 *   the enrolment spans in scope, clipped to the window.
 * - `att_current (id, student_id, section_id, academic_year_id, date, mark,
 *   kind, revision, created_at)`: the newest mark per pupil and date among
 *   the rows the caller may read.
 * - `att_pupil_days (student_id, day, kind, future, mark, corrected)`: one
 *   row per pupil and day they were enrolled in the window.
 * - `att_figures (student_id, school_days, present, absent, late, leave,
 *   half_day, unmarked)`: the counts over school days up to today.
 */
export function attendanceFiguresCte(input: AttendanceFiguresInput): SQL {
  const school = sql`${input.schoolId}::uuid`
  return sql`WITH ${calendarDaysCte(input)},
    att_spans AS (
      SELECT enrollments.student_id, enrollments.section_id, enrollments.academic_year_id,
             GREATEST(enrollments.joined_on, ${input.from}::date) AS from_on,
             LEAST(COALESCE(enrollments.left_on, 'infinity'::date), ${input.to}::date) AS to_on
        FROM enrollments
       WHERE enrollments.school_id = ${school}
         AND enrollments.joined_on <= ${input.to}::date
         AND (enrollments.left_on IS NULL OR enrollments.left_on >= ${input.from}::date)
         AND (${input.spans})
    ),
    att_current AS (
      SELECT DISTINCT ON (attendance_entries.student_id, attendance_entries.date)
             attendance_entries.id, attendance_entries.student_id, attendance_entries.section_id,
             attendance_entries.academic_year_id, attendance_entries.date, attendance_entries.mark,
             attendance_entries.kind, attendance_entries.revision, attendance_entries.created_at
        FROM attendance_entries
       WHERE attendance_entries.school_id = ${school}
         AND attendance_entries.date BETWEEN ${input.from}::date AND ${input.to}::date
         AND (${input.entries})
       ORDER BY attendance_entries.student_id, attendance_entries.date, attendance_entries.revision DESC
    ),
    att_pupil_days AS (
      SELECT DISTINCT ON (s.student_id, d.day)
             s.student_id, d.day, d.kind, d.future, c.mark, (c.kind = 'correction') AS corrected
        FROM att_spans s
        JOIN att_days d ON d.day BETWEEN s.from_on AND s.to_on
        LEFT JOIN att_current c ON c.student_id = s.student_id AND c.date = d.day
       ORDER BY s.student_id, d.day
    ),
    att_figures AS (
      SELECT student_id,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future)::int AS school_days,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'present')::int AS present,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'absent')::int AS absent,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'late')::int AS late,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'leave')::int AS leave,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'half_day')::int AS half_day,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark IS NULL)::int AS unmarked
        FROM att_pupil_days
       GROUP BY student_id
    )`
}

/** One row of `att_figures`, as the driver returns it. */
export interface FiguresRow extends Record<string, unknown> {
  student_id: string
  school_days: number
  present: number
  absent: number
  late: number
  leave: number
  half_day: number
  unmarked: number
}

/** The contract summary from a figures row, with the one percentage rule. */
export function toSummary(row: Omit<FiguresRow, 'student_id'> | undefined): AttendanceSummary {
  const counts = {
    schoolDays: Number(row?.school_days ?? 0),
    present: Number(row?.present ?? 0),
    absent: Number(row?.absent ?? 0),
    late: Number(row?.late ?? 0),
    leave: Number(row?.leave ?? 0),
    halfDay: Number(row?.half_day ?? 0),
    unmarked: Number(row?.unmarked ?? 0),
  }
  return { ...counts, percentage: attendancePercentage(counts) }
}

/** The empty summary, for a pupil with no school day in the window. */
export const EMPTY_SUMMARY: AttendanceSummary = toSummary(undefined)

// ---------------------------------------------------------------------------
// Staff: the same shape over the staff record.

export interface StaffFiguresInput extends CalendarInput {
  /**
   * Over the unaliased `staff` table: who is on the register in scope. It
   * MUST already contain `plans.people`, and the caller ANDs its own filter.
   */
  readonly people: SQL
  /** Over the unaliased `staff_attendance_entries` table: `plans.entries`. */
  readonly entries: SQL
}

/**
 * The `WITH ...` prefix of a staff attendance statement. After it a query may
 * read `att_days`, `sta_people (staff_id, from_on, to_on)`, `sta_current`,
 * `sta_days (staff_id, day, kind, future, mark, corrected)` and `sta_figures`
 * with the same columns as `att_figures`, keyed by `staff_id`.
 *
 * A person is on the register from their joining date to their leaving date,
 * whatever their status says: someone on leave is still marked (as leave).
 */
export function staffFiguresCte(input: StaffFiguresInput): SQL {
  const school = sql`${input.schoolId}::uuid`
  return sql`WITH ${calendarDaysCte(input)},
    sta_people AS (
      SELECT staff.id AS staff_id,
             GREATEST(staff.joining_date, ${input.from}::date) AS from_on,
             LEAST(COALESCE(staff.leaving_date, 'infinity'::date), ${input.to}::date) AS to_on
        FROM staff
       WHERE staff.school_id = ${school}
         AND staff.joining_date <= ${input.to}::date
         AND (staff.leaving_date IS NULL OR staff.leaving_date >= ${input.from}::date)
         AND (${input.people})
    ),
    sta_current AS (
      SELECT DISTINCT ON (staff_attendance_entries.staff_id, staff_attendance_entries.date)
             staff_attendance_entries.id, staff_attendance_entries.staff_id, staff_attendance_entries.date,
             staff_attendance_entries.mark, staff_attendance_entries.kind, staff_attendance_entries.revision,
             staff_attendance_entries.created_at
        FROM staff_attendance_entries
       WHERE staff_attendance_entries.school_id = ${school}
         AND staff_attendance_entries.date BETWEEN ${input.from}::date AND ${input.to}::date
         AND (${input.entries})
       ORDER BY staff_attendance_entries.staff_id, staff_attendance_entries.date, staff_attendance_entries.revision DESC
    ),
    sta_days AS (
      SELECT p.staff_id, d.day, d.kind, d.future, c.mark, (c.kind = 'correction') AS corrected
        FROM sta_people p
        JOIN att_days d ON d.day BETWEEN p.from_on AND p.to_on
        LEFT JOIN sta_current c ON c.staff_id = p.staff_id AND c.date = d.day
    ),
    sta_figures AS (
      SELECT staff_id,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future)::int AS school_days,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'present')::int AS present,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'absent')::int AS absent,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'late')::int AS late,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'leave')::int AS leave,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark = 'half_day')::int AS half_day,
             count(*) FILTER (WHERE kind = 'school_day' AND NOT future AND mark IS NULL)::int AS unmarked
        FROM sta_days
       GROUP BY staff_id
    )`
}

// ---------------------------------------------------------------------------
// Years and months.

/** The academic year of this school that contains a date, if any. */
export async function yearContaining(
  conn: AttendanceConnection,
  schoolId: string,
  date: string,
): Promise<{ id: string; name: string; startDate: string; endDate: string } | null> {
  const rows = await conn.client.query<{ id: string; name: string; start_date: string; end_date: string }>(
    `SELECT id, name, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM academic_years
      WHERE school_id = $1 AND start_date <= $2::date AND end_date >= $2::date
      ORDER BY start_date DESC, id LIMIT 1`,
    [schoolId, date],
  )
  const row = rows.rows[0]
  return row ? { id: row.id, name: row.name, startDate: row.start_date, endDate: row.end_date } : null
}

/**
 * The academic year a month belongs to: the one containing its first day,
 * else the one containing its last. A month outside every year of the
 * school is a refused request with its reason, not a missing record.
 */
export async function yearOfMonth(
  conn: AttendanceConnection,
  schoolId: string,
  month: string,
): Promise<{ id: string; name: string; startDate: string; endDate: string }> {
  const { from, to } = monthBounds(month)
  const year = (await yearContaining(conn, schoolId, from)) ?? (await yearContaining(conn, schoolId, to))
  if (!year) throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_month_outside_year')
  return year
}
