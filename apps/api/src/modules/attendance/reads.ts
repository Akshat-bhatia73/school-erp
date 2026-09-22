import { sql, type SQL } from 'drizzle-orm'
import { AuthorizationError, planPredicate, scopedTableFor } from '@erp/authz'
import {
  AttendanceDayResponse,
  type AttendanceDayWindow,
  type AttendanceMark,
  type AttendanceMonthDay,
  type AttendanceRegisterRow,
  type AttendanceRosterRow,
  AttendanceSectionMonthResponse,
  AttendanceStudentMonthResponse,
  type ErrorReason,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { allowedActionsFor, ApiFailure, decideResource, readPlan } from '../shared/index.ts'
import {
  attendanceFiguresCte,
  attendancePlans,
  monthBounds,
  readCalendarDay,
  schoolToday,
  toCalendarDay,
  toSummary,
  yearOfMonth,
  type AttendanceConnection,
  type AttendancePlans,
  type CalendarDayRow,
  type FiguresRow,
} from './figures.ts'

/**
 * The readers behind the register.
 *
 * One day of a section, one pupil's month and one section's month are all
 * read here, and the routes, the export producers and the dashboard blocks
 * call the same functions, so a file and a screen can never disagree. Every
 * statement ANDs the caller's own plans into SQL; nothing is fetched and then
 * filtered in JavaScript.
 */

/** A name as a roster prints it, never longer than the contract allows. */
function pupilName(first: string, last: string | null): string {
  return [first, last].filter((part) => part !== null && part !== '').join(' ').slice(0, 160)
}

/** The stored timestamp, as the contract's ISO string. */
const ISO_TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MSOF:00'`

function table(kind: 'section') {
  const scoped = scopedTableFor(kind)
  if (!scoped) throw new Error(`the authorizer has no scoped table for ${kind}`)
  return scoped
}

/**
 * Which sections the caller may name. A caller with no section grant sees no
 * class name at all, exactly as a fee row omits one it may not read.
 */
export async function sectionVisibility(
  conn: AttendanceConnection,
  context: RequestContext,
): Promise<SQL> {
  try {
    return planPredicate(await readPlan(conn, context, 'sections.read', 'section'), table('section'))
  } catch (error) {
    if (error instanceof AuthorizationError) return sql`FALSE`
    throw error
  }
}

/** A denial on a named record answers like a record that is not there. */
export async function decideAttendance(
  conn: AttendanceConnection,
  context: RequestContext,
  permission: 'attendance.read' | 'attendance.record' | 'attendance.manage' | 'attendance.export',
  id: string,
): Promise<void> {
  const decision = await decideResource(conn, context, permission, 'attendance', id)
  if (!decision.allowed) {
    throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
  }
}

/** True when the caller holds this permission on this section. */
export async function mayUse(
  conn: AttendanceConnection,
  context: RequestContext,
  permission: 'attendance.record' | 'attendance.manage',
  id: string,
): Promise<boolean> {
  return (await decideResource(conn, context, permission, 'attendance', id)).allowed
}

// ---------------------------------------------------------------------------
// The window.

export interface DayWindowInput {
  readonly day: CalendarDayRow
  readonly today: string
  /** decideResource(attendance.record).allowed for this section. */
  readonly mayRecord: boolean
  /** decideResource(attendance.manage).allowed for this section. */
  readonly mayCorrect: boolean
}

/** Why this day is not a day to mark, in the server's own words. */
function blockedBy(day: CalendarDayRow, today: string, forRecord: boolean): ErrorReason | undefined {
  if (day.kind === 'outside_year') return 'attendance_date_outside_year'
  if (day.kind === 'sunday' || day.kind === 'holiday') return 'attendance_not_a_school_day'
  if (day.future) return 'attendance_date_in_future'
  // A past school day is closed to the register, but never to a correction.
  if (forRecord && day.day !== today) return 'attendance_marking_window_closed'
  return undefined
}

/**
 * What the server will accept for this day from this caller. The register is
 * open only on today itself; the office corrects any school day up to today.
 * A caller who simply lacks the permission is given no reason: there is
 * nothing about the day to explain.
 */
export function dayWindow(input: DayWindowInput): AttendanceDayWindow {
  const recordReason = blockedBy(input.day, input.today, true)
  const correctReason = blockedBy(input.day, input.today, false)
  const record = input.mayRecord && recordReason === undefined
  const correct = input.mayCorrect && correctReason === undefined
  return {
    record,
    ...(record || !input.mayRecord || recordReason === undefined ? {} : { recordBlockedBy: recordReason }),
    correct,
    ...(correct || !input.mayCorrect || correctReason === undefined ? {} : { correctBlockedBy: correctReason }),
  }
}

// ---------------------------------------------------------------------------
// The roster.

/** Who was enrolled in this section on this date, and nobody else. */
function enrolledOn(schoolId: string, sectionId: string, date: string, pupils: SQL): SQL {
  return sql`FROM enrollments
      JOIN students ON students.school_id = enrollments.school_id AND students.id = enrollments.student_id
     WHERE enrollments.school_id = ${schoolId}::uuid
       AND enrollments.section_id = ${sectionId}::uuid
       AND enrollments.joined_on <= ${date}::date
       AND (enrollments.left_on IS NULL OR enrollments.left_on >= ${date}::date)
       AND (${pupils})`
}

/** The roll is ordered by roll number, and the pupils without one come last. */
const ROLL_ORDER = sql`ORDER BY enrollments.roll_number NULLS LAST, students.first_name, students.last_name, students.id`

export interface RosterPupil {
  readonly id: string
  readonly name: string
  readonly admissionNumber: string
  readonly rollNumber: number | null
}

interface RosterRow extends Record<string, unknown> {
  id: string
  first_name: string
  last_name: string | null
  admission_number: string
  roll_number: number | null
}

function toPupil(row: RosterRow): RosterPupil {
  return {
    id: row.id,
    name: pupilName(row.first_name, row.last_name),
    admissionNumber: row.admission_number,
    rollNumber: row.roll_number === null ? null : Number(row.roll_number),
  }
}

/** The pupil as the contract names them, with a roll number only when there is one. */
export function pupilRef(pupil: RosterPupil): {
  id: string
  name: string
  admissionNumber: string
  rollNumber?: number
} {
  return {
    id: pupil.id,
    name: pupil.name,
    admissionNumber: pupil.admissionNumber,
    ...(pupil.rollNumber === null || pupil.rollNumber <= 0 ? {} : { rollNumber: pupil.rollNumber }),
  }
}

/** The pupils enrolled in a section on a date, in roll order. */
export async function rosterOn(
  conn: AttendanceConnection,
  schoolId: string,
  sectionId: string,
  date: string,
  pupils: SQL,
): Promise<RosterPupil[]> {
  const rows = await conn.db.execute<RosterRow>(
    sql`SELECT students.id, students.first_name, students.last_name, students.admission_number,
               enrollments.roll_number
        ${enrolledOn(schoolId, sectionId, date, pupils)}
        ${ROLL_ORDER}`,
  )
  return rows.rows.map((row) => toPupil(row))
}

// ---------------------------------------------------------------------------
// One section, one day.

export interface SectionRow extends Record<string, unknown> {
  id: string
  name: string
  academic_year_id: string
  year_name: string
  grade_id: string
  grade_name: string
}

/**
 * The section itself, with its class and its year. The record has already
 * been decided, so this read is bounded by the school alone.
 */
export async function readSection(
  conn: AttendanceConnection,
  schoolId: string,
  sectionId: string,
): Promise<SectionRow> {
  const rows = await conn.client.query<SectionRow>(
    `SELECT sections.id, sections.name, sections.academic_year_id,
            ay.name AS year_name, grades.id AS grade_id, grades.name AS grade_name
       FROM sections
       JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
       JOIN academic_years ay ON ay.school_id = sections.school_id AND ay.id = sections.academic_year_id
      WHERE sections.school_id = $1 AND sections.id = $2`,
    [schoolId, sectionId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

interface DayRosterRow extends RosterRow {
  entry_id: string | null
  mark: AttendanceMark | null
  revision: number | null
  entry_kind: 'marking' | 'correction' | null
  recorded_at: string | null
}

/**
 * One section on one day: the roll, and against each name the current mark,
 * which is the newest row the caller may read.
 */
export async function readAttendanceDay(
  conn: AttendanceConnection,
  context: RequestContext,
  sectionId: string,
  date: string,
): Promise<AttendanceDayResponse> {
  const schoolId = context.schoolId
  const plans = await attendancePlans(conn, context)
  const section = await readSection(conn, schoolId, sectionId)
  const today = await schoolToday(conn, schoolId)
  const day = await readCalendarDay(conn, { schoolId, date, asOf: today, holidays: plans.holidays })

  // The mark of each pupil is read alongside the roll, so a row carries a
  // mark exactly when the caller may read that mark.
  const withMarks = await conn.db.execute<DayRosterRow>(
    sql`SELECT students.id, students.first_name, students.last_name, students.admission_number,
               enrollments.roll_number,
               cur.id AS entry_id, cur.mark, cur.revision, cur.kind AS entry_kind,
               to_char(cur.created_at, ${sql.raw(ISO_TIMESTAMP)}) AS recorded_at
          FROM enrollments
          JOIN students ON students.school_id = enrollments.school_id AND students.id = enrollments.student_id
          LEFT JOIN LATERAL (
            SELECT attendance_entries.id, attendance_entries.mark, attendance_entries.revision,
                   attendance_entries.kind, attendance_entries.created_at
              FROM attendance_entries
             WHERE attendance_entries.school_id = enrollments.school_id
               AND attendance_entries.student_id = enrollments.student_id
               AND attendance_entries.date = ${date}::date
               AND (${plans.entries})
             ORDER BY attendance_entries.revision DESC LIMIT 1
          ) cur ON TRUE
         WHERE enrollments.school_id = ${schoolId}::uuid
           AND enrollments.section_id = ${sectionId}::uuid
           AND enrollments.joined_on <= ${date}::date
           AND (enrollments.left_on IS NULL OR enrollments.left_on >= ${date}::date)
           AND (${plans.pupils})
        ${ROLL_ORDER}`,
  )
  const mayRecord = await mayUse(conn, context, 'attendance.record', sectionId)
  const mayCorrect = await mayUse(conn, context, 'attendance.manage', sectionId)
  const allowedActions = await allowedActionsFor(conn, context, {
    schoolId,
    resourceType: 'attendance',
    id: sectionId,
  })

  const roster: AttendanceRosterRow[] = withMarks.rows.map((row) => ({
    student: pupilRef(toPupil(row)),
    ...(row.mark === null ? {} : { mark: row.mark }),
    ...(row.entry_id === null || row.revision === null || row.entry_kind === null || row.recorded_at === null
      ? {}
      : {
          entry: {
            id: row.entry_id,
            revision: Number(row.revision),
            kind: row.entry_kind,
            recordedAt: row.recorded_at,
          },
        }),
  }))

  return AttendanceDayResponse.parse({
    section: { id: section.id, name: section.name },
    grade: { id: section.grade_id, name: section.grade_name },
    academicYear: { id: section.academic_year_id, name: section.year_name },
    date,
    day: toCalendarDay(day),
    window: dayWindow({ day, today, mayRecord, mayCorrect }),
    marked: roster.some((row) => row.mark !== undefined),
    rows: roster,
    allowedActions: [...allowedActions],
  })
}

// ---------------------------------------------------------------------------
// A pupil's month.

/** The `EXISTS` a span predicate must carry, so a span is only ever a pupil's. */
function spanPupils(plans: AttendancePlans): SQL {
  return sql`EXISTS (SELECT 1 FROM students
       WHERE students.school_id = enrollments.school_id
         AND students.id = enrollments.student_id
         AND (${plans.pupils}))`
}

interface MonthDayRow extends CalendarDayRow {
  enrolled: boolean
  mark: AttendanceMark | null
  corrected: boolean | null
}

/** One pupil, one month: every day of it and what the month adds up to. */
export async function readStudentMonth(
  conn: AttendanceConnection,
  context: RequestContext,
  studentId: string,
  month: string,
): Promise<AttendanceStudentMonthResponse> {
  const schoolId = context.schoolId
  const plans = await attendancePlans(conn, context)
  const sections = await sectionVisibility(conn, context)
  const year = await yearOfMonth(conn, schoolId, month)
  const today = await schoolToday(conn, schoolId)
  const { from, to } = monthBounds(month)

  const pupil = await conn.db.execute<RosterRow>(
    sql`SELECT students.id, students.first_name, students.last_name, students.admission_number,
               NULL::integer AS roll_number
          FROM students
         WHERE students.school_id = ${schoolId}::uuid AND students.id = ${studentId}::uuid
           AND (${plans.pupils}) LIMIT 1`,
  )
  const student = pupil.rows[0]
  if (!student) throw new ApiFailure('RESOURCE_NOT_FOUND')

  const cte = attendanceFiguresCte({
    schoolId,
    from,
    to,
    asOf: today,
    holidays: plans.holidays,
    spans: sql`enrollments.student_id = ${studentId}::uuid AND ${spanPupils(plans)}`,
    entries: plans.entries,
  })

  const dayRows = await conn.db.execute<MonthDayRow>(
    sql`${cte}
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day, d.kind, d.holiday_name, d.academic_year_id, d.future,
               (p.student_id IS NOT NULL) AS enrolled, p.mark, p.corrected
          FROM att_days d
          LEFT JOIN att_pupil_days p ON p.day = d.day AND p.student_id = ${studentId}::uuid
         ORDER BY d.day`,
  )
  const figures = await conn.db.execute<FiguresRow>(
    sql`${cte} SELECT * FROM att_figures WHERE student_id = ${studentId}::uuid`,
  )
  // The class the pupil sat in during the month, named only when the caller
  // may read that section.
  const klass = await conn.db.execute<{
    section_id: string | null
    section_name: string | null
    grade_id: string | null
    grade_name: string | null
  }>(
    sql`${cte}
        SELECT sections.id AS section_id, sections.name AS section_name,
               grades.id AS grade_id, grades.name AS grade_name
          FROM (SELECT section_id FROM att_spans
                 WHERE student_id = ${studentId}::uuid
                 ORDER BY to_on DESC, from_on DESC LIMIT 1) latest
          LEFT JOIN sections ON sections.school_id = ${schoolId}::uuid AND sections.id = latest.section_id
            AND (${sections})
          LEFT JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id`,
  )

  const allowedActions = await allowedActionsFor(conn, context, {
    schoolId,
    resourceType: 'attendance',
    id: studentId,
  })
  const days: AttendanceMonthDay[] = dayRows.rows.map((row) => ({
    ...toCalendarDay(row),
    enrolled: row.enrolled,
    ...(row.mark === null ? {} : { mark: row.mark }),
    ...(row.corrected === null ? {} : { corrected: row.corrected }),
  }))
  const klassRow = klass.rows[0]

  return AttendanceStudentMonthResponse.parse({
    student: pupilRef(toPupil(student)),
    academicYear: { id: year.id, name: year.name },
    month,
    ...(klassRow?.section_id == null || klassRow.section_name == null
      ? {}
      : { section: { id: klassRow.section_id, name: klassRow.section_name } }),
    ...(klassRow?.grade_id == null || klassRow.grade_name == null
      ? {}
      : { grade: { id: klassRow.grade_id, name: klassRow.grade_name } }),
    days,
    summary: toSummary(figures.rows[0]),
    allowedActions: [...allowedActions],
  })
}

// ---------------------------------------------------------------------------
// A section's month.

interface RegisterDayRow extends CalendarDayRow {
  marked: boolean
}

interface RegisterPupilRow extends RosterRow {
  student_id: string
}

interface PupilDayRow extends Record<string, unknown> {
  student_id: string
  day: string
  mark: AttendanceMark | null
  corrected: boolean | null
}

/** True when a month and a year share at least a day. */
function monthTouchesYear(bounds: { from: string; to: string }, year: { startDate: string; endDate: string }): boolean {
  const inside = (date: string) => date >= year.startDate && date <= year.endDate
  return inside(bounds.from) || inside(bounds.to)
}

/** One section, one month: the register as a grid, with a total per pupil. */
export async function readSectionMonth(
  conn: AttendanceConnection,
  context: RequestContext,
  sectionId: string,
  month: string,
): Promise<AttendanceSectionMonthResponse> {
  const schoolId = context.schoolId
  const plans = await attendancePlans(conn, context)
  const section = await readSection(conn, schoolId, sectionId)
  const today = await schoolToday(conn, schoolId)
  const bounds = monthBounds(month)

  // A section belongs to one year, so a month outside that year is a refused
  // request and not an empty register.
  const year = await conn.client.query<{ id: string; name: string; start_date: string; end_date: string }>(
    `SELECT id, name, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, section.academic_year_id],
  )
  const yearRow = year.rows[0]
  if (!yearRow) throw new ApiFailure('RESOURCE_NOT_FOUND')
  if (!monthTouchesYear(bounds, { startDate: yearRow.start_date, endDate: yearRow.end_date })) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_month_outside_year')
  }

  const cte = attendanceFiguresCte({
    schoolId,
    from: bounds.from,
    to: bounds.to,
    asOf: today,
    holidays: plans.holidays,
    spans: sql`enrollments.section_id = ${sectionId}::uuid AND ${spanPupils(plans)}`,
    entries: plans.entries,
  })

  const dayRows = await conn.db.execute<RegisterDayRow>(
    sql`${cte}
        SELECT to_char(d.day, 'YYYY-MM-DD') AS day, d.kind, d.holiday_name, d.academic_year_id, d.future,
               EXISTS (SELECT 1 FROM att_pupil_days p WHERE p.day = d.day AND p.mark IS NOT NULL) AS marked
          FROM att_days d ORDER BY d.day`,
  )
  const pupilRows = await conn.db.execute<RegisterPupilRow>(
    sql`${cte}
        SELECT s.student_id, students.id, students.first_name, students.last_name,
               students.admission_number, roll.roll_number
          FROM (SELECT DISTINCT student_id FROM att_spans) s
          JOIN students ON students.school_id = ${schoolId}::uuid AND students.id = s.student_id
          LEFT JOIN LATERAL (
            SELECT enrollments.roll_number FROM enrollments
             WHERE enrollments.school_id = ${schoolId}::uuid
               AND enrollments.section_id = ${sectionId}::uuid
               AND enrollments.student_id = s.student_id
             ORDER BY enrollments.joined_on DESC, enrollments.id LIMIT 1
          ) roll ON TRUE
         ORDER BY roll.roll_number NULLS LAST, students.first_name, students.last_name, students.id`,
  )
  const markRows = await conn.db.execute<PupilDayRow>(
    sql`${cte}
        SELECT student_id, to_char(day, 'YYYY-MM-DD') AS day, mark, corrected FROM att_pupil_days`,
  )
  const figureRows = await conn.db.execute<FiguresRow>(sql`${cte} SELECT * FROM att_figures`)

  const allowedActions = await allowedActionsFor(conn, context, {
    schoolId,
    resourceType: 'attendance',
    id: sectionId,
  })

  const days = dayRows.rows.map((row) => ({ ...toCalendarDay(row), marked: row.marked }))
  const byPupil = new Map<string, Map<string, PupilDayRow>>()
  for (const row of markRows.rows) {
    const days = byPupil.get(row.student_id) ?? new Map<string, PupilDayRow>()
    days.set(row.day, row)
    byPupil.set(row.student_id, days)
  }
  const figures = new Map(figureRows.rows.map((row) => [row.student_id, row]))

  const rows: AttendanceRegisterRow[] = pupilRows.rows.map((pupil) => {
    const marks = byPupil.get(pupil.student_id) ?? new Map<string, PupilDayRow>()
    return {
      student: pupilRef(toPupil(pupil)),
      marks: days.map((day) => {
        const found = marks.get(day.date)
        return {
          date: day.date,
          enrolled: found !== undefined,
          ...(found?.mark == null ? {} : { mark: found.mark }),
          ...(found?.corrected == null ? {} : { corrected: found.corrected }),
        }
      }),
      summary: toSummary(figures.get(pupil.student_id)),
    }
  })

  return AttendanceSectionMonthResponse.parse({
    section: { id: section.id, name: section.name },
    grade: { id: section.grade_id, name: section.grade_name },
    academicYear: { id: yearRow.id, name: yearRow.name },
    month,
    days,
    rows,
    allowedActions: [...allowedActions],
  })
}
