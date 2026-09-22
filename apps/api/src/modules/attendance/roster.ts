import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import {
  AttendanceCorrectionRequest,
  AttendanceDayResponse,
  type AttendanceMark,
  AttendanceMarkRequest,
  AttendanceSectionsRequest,
  AttendanceSectionsResponse,
  type AttendanceSectionDay,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  allowedActionsForMany,
  ApiFailure,
  assertUuidParam,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  attendancePlans,
  readCalendarDay,
  schoolToday,
  toCalendarDay,
  yearContaining,
  type AttendanceConnection,
  type CalendarDayRow,
} from './figures.ts'
import {
  decideAttendance,
  readAttendanceDay,
  readSection,
  rosterOn,
  sectionVisibility,
} from './reads.ts'

/**
 * The register: which sections are marked today, one section's day, the one
 * write that marks it and the office correction that supersedes a mark.
 *
 * Nothing here is ever edited. A save is a new row per pupil whose mark
 * changed, pointing at the row it supersedes, and the current mark is always
 * the highest revision of that pupil and date.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MSOF:00'`

/** A path that is not a date is a path to nothing, exactly like a bad id. */
function assertDateParam(value: string): string {
  // The shape and the calendar both have to agree: 2026-13-45 is not a date.
  if (!DATE.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiFailure('RESOURCE_NOT_FOUND')
  }
  return value
}

/** The counts a body sends, for the audit row. */
function countMarks(marks: readonly { readonly mark: AttendanceMark }[]): Record<AttendanceMark, number> {
  const counts: Record<AttendanceMark, number> = { present: 0, absent: 0, late: 0, leave: 0, half_day: 0 }
  for (const line of marks) counts[line.mark] += 1
  return counts
}

/** The current mark of each pupil on a date, as stored. */
interface CurrentMark {
  readonly id: string
  readonly revision: number
  readonly mark: AttendanceMark
}

/**
 * The newest row per pupil on a date, read across the whole school and not
 * through a plan: a revision must follow the row that really exists, or the
 * append-only index would refuse the insert.
 */
async function currentMarks(
  conn: AttendanceConnection,
  schoolId: string,
  studentIds: readonly string[],
  date: string,
): Promise<Map<string, CurrentMark>> {
  if (studentIds.length === 0) return new Map()
  const rows = await conn.client.query<{ student_id: string; id: string; revision: number; mark: AttendanceMark }>(
    `SELECT DISTINCT ON (student_id) student_id, id, revision, mark
       FROM attendance_entries
      WHERE school_id = $1 AND date = $2::date AND student_id = ANY($3::uuid[])
      ORDER BY student_id, revision DESC`,
    [schoolId, date, [...studentIds]],
  )
  return new Map(rows.rows.map((row) => [row.student_id, { id: row.id, revision: Number(row.revision), mark: row.mark }]))
}

/** One mark, appended. Nothing else ever writes to this table. */
async function insertMark(
  conn: AttendanceConnection,
  context: RequestContext,
  input: {
    readonly studentId: string
    readonly sectionId: string
    readonly academicYearId: string
    readonly date: string
    readonly mark: AttendanceMark
    readonly kind: 'marking' | 'correction'
    readonly current: CurrentMark | undefined
  },
): Promise<void> {
  await conn.client.query(
    `INSERT INTO attendance_entries (school_id, student_id, section_id, academic_year_id, date, mark,
                                     revision, supersedes_entry_id, kind, recorded_by_membership_id)
     VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10)`,
    [
      context.schoolId,
      input.studentId,
      input.sectionId,
      input.academicYearId,
      input.date,
      input.mark,
      (input.current?.revision ?? 0) + 1,
      input.current?.id ?? null,
      input.kind,
      context.membershipId,
    ],
  )
}

/**
 * The day a write is asked for must be a school day of this section's own
 * year. Each refusal carries the reason, because the caller was allowed to
 * ask: only the school day itself is the answer.
 */
function assertSchoolDay(day: CalendarDayRow, sectionYearId: string): void {
  if (day.kind === 'outside_year' || day.academic_year_id !== sectionYearId) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_date_outside_year')
  }
  if (day.kind === 'sunday' || day.kind === 'holiday') {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_not_a_school_day')
  }
  if (day.future) throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_date_in_future')
}

interface SectionDayRow extends Record<string, unknown> {
  section_id: string
  section_name: string
  grade_id: string
  grade_name: string
  strength: number
  marked_count: number
  present: number
  absent: number
  late: number
  leave: number
  half_day: number
  last_recorded_at: string | null
}

/**
 * The day list: every section of the year this caller may see a register of,
 * with how many pupils were on its roll that day and whether it has been
 * marked. The strength, the counts and the last save are all worked out in
 * SQL under the caller's plans.
 */
async function readSections(
  conn: AttendanceConnection,
  context: RequestContext,
  date: string,
): Promise<AttendanceSectionsResponse> {
  const schoolId = context.schoolId
  const plans = await attendancePlans(conn, context)
  const sections = await sectionVisibility(conn, context)
  const today = await schoolToday(conn, schoolId)
  const day = await readCalendarDay(conn, { schoolId, date, asOf: today, holidays: plans.holidays })
  const year = await yearContaining(conn, schoolId, date)
  if (!year) {
    return AttendanceSectionsResponse.parse({ date, day: toCalendarDay(day), academicYear: null, items: [] })
  }

  const rows = await conn.db.execute<SectionDayRow>(
    sql`SELECT sections.id AS section_id, sections.name AS section_name,
               grades.id AS grade_id, grades.name AS grade_name,
               (SELECT count(*)::int FROM enrollments
                  JOIN students ON students.school_id = enrollments.school_id
                    AND students.id = enrollments.student_id
                 WHERE enrollments.school_id = ${schoolId}::uuid
                   AND enrollments.section_id = sections.id
                   AND enrollments.joined_on <= ${date}::date
                   AND (enrollments.left_on IS NULL OR enrollments.left_on >= ${date}::date)
                   AND (${plans.pupils})) AS strength,
               marks.marked_count, marks.present, marks.absent, marks.late, marks.leave, marks.half_day,
               to_char(marks.last_recorded_at, ${sql.raw(ISO_TIMESTAMP)}) AS last_recorded_at
          FROM sections
          JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS marked_count,
                   count(*) FILTER (WHERE cur.mark = 'present')::int AS present,
                   count(*) FILTER (WHERE cur.mark = 'absent')::int AS absent,
                   count(*) FILTER (WHERE cur.mark = 'late')::int AS late,
                   count(*) FILTER (WHERE cur.mark = 'leave')::int AS leave,
                   count(*) FILTER (WHERE cur.mark = 'half_day')::int AS half_day,
                   max(cur.created_at) AS last_recorded_at
              FROM (
                SELECT DISTINCT ON (attendance_entries.student_id)
                       attendance_entries.mark, attendance_entries.created_at
                  FROM attendance_entries
                 WHERE attendance_entries.school_id = ${schoolId}::uuid
                   AND attendance_entries.section_id = sections.id
                   AND attendance_entries.date = ${date}::date
                   AND (${plans.entries})
                   AND EXISTS (SELECT 1 FROM students
                                WHERE students.school_id = attendance_entries.school_id
                                  AND students.id = attendance_entries.student_id
                                  AND (${plans.pupils}))
                 ORDER BY attendance_entries.student_id, attendance_entries.revision DESC
              ) cur
          ) marks ON TRUE
         WHERE sections.school_id = ${schoolId}::uuid
           AND sections.academic_year_id = ${year.id}::uuid
           AND (${plans.rosters}) AND (${sections})
         ORDER BY grades.sort_order, sections.name, sections.id`,
  )

  const actions = await allowedActionsForMany(conn, context, 'attendance', rows.rows.map((row) => row.section_id))
  const items: AttendanceSectionDay[] = rows.rows.map((row) => {
    const marked = Number(row.marked_count ?? 0) > 0
    return {
      section: { id: row.section_id, name: row.section_name },
      grade: { id: row.grade_id, name: row.grade_name },
      strength: Number(row.strength ?? 0),
      marked,
      ...(marked
        ? {
            counts: {
              present: Number(row.present ?? 0),
              absent: Number(row.absent ?? 0),
              late: Number(row.late ?? 0),
              leave: Number(row.leave ?? 0),
              halfDay: Number(row.half_day ?? 0),
            },
          }
        : {}),
      ...(marked && row.last_recorded_at !== null ? { lastRecordedAt: row.last_recorded_at } : {}),
      allowedActions: [...(actions.get(row.section_id) ?? [])],
    }
  })

  return AttendanceSectionsResponse.parse({
    date,
    day: toCalendarDay(day),
    academicYear: { id: year.id, name: year.name },
    items,
  })
}

export function registerAttendanceRosterRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/attendance/sections',
    permission: 'attendance.read',
    query: AttendanceSectionsRequest,
    response: AttendanceSectionsResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const date = query.date ?? (await schoolToday(conn, context.schoolId))
        return readSections(conn, context, date)
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/attendance/sections/:sectionId/days/:date',
    permission: 'attendance.read',
    response: AttendanceDayResponse,
    handler: async ({ context, param }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const date = assertDateParam(param('date'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideAttendance(conn, context, 'attendance.read', sectionId)
        return readAttendanceDay(conn, context, sectionId, date)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/attendance/sections/:sectionId/days/:date',
    permission: 'attendance.record',
    body: AttendanceMarkRequest,
    response: AttendanceDayResponse,
    handler: async ({ context, body, param }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const date = assertDateParam(param('date'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideAttendance(conn, context, 'attendance.record', sectionId)
        const section = await readSection(conn, context.schoolId, sectionId)
        const plans = await attendancePlans(conn, context, 'attendance.record')
        const today = await schoolToday(conn, context.schoolId)
        const day = await readCalendarDay(conn, {
          schoolId: context.schoolId,
          date,
          asOf: today,
          holidays: plans.holidays,
        })
        assertSchoolDay(day, section.academic_year_id)
        // The register is the teacher's own day. Yesterday belongs to the
        // office, as a correction with a reason.
        if (date !== today) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_marking_window_closed')
        }

        // Marking a day is the whole roll: everybody on it, and nobody else.
        const roster = await rosterOn(conn, context.schoolId, sectionId, date, plans.pupils)
        const onRoll = new Set(roster.map((pupil) => pupil.id))
        const sent = new Map(body.marks.map((line) => [line.studentId, line.mark]))
        for (const studentId of sent.keys()) {
          if (!onRoll.has(studentId)) {
            throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_pupil_not_on_roster')
          }
        }
        if (sent.size !== onRoll.size) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_roster_incomplete')
        }

        const current = await currentMarks(conn, context.schoolId, [...onRoll], date)
        let changed = 0
        for (const pupil of roster) {
          const mark = sent.get(pupil.id)
          if (mark === undefined) continue
          const now = current.get(pupil.id)
          if (now?.mark === mark) continue
          await insertMark(conn, context, {
            studentId: pupil.id,
            sectionId,
            academicYearId: section.academic_year_id,
            date,
            mark,
            kind: 'marking',
            current: now,
          })
          changed += 1
        }

        const counts = countMarks(body.marks)
        await writeAudit(conn, context, {
          action: 'attendance.record',
          targetType: 'section',
          targetId: sectionId,
          summary: 'Marked attendance for a section.',
          safeChanges: {
            sectionId,
            academicYearId: section.academic_year_id,
            date,
            pupils: roster.length,
            changed,
            present: counts.present,
            absent: counts.absent,
            late: counts.late,
            leave: counts.leave,
            halfDay: counts.half_day,
          },
        })
        return readAttendanceDay(conn, context, sectionId, date)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/attendance/sections/:sectionId/days/:date/corrections',
    permission: 'attendance.manage',
    body: AttendanceCorrectionRequest,
    response: AttendanceDayResponse,
    successStatus: 201,
    handler: async ({ context, body, param }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const date = assertDateParam(param('date'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideAttendance(conn, context, 'attendance.manage', sectionId)
        const section = await readSection(conn, context.schoolId, sectionId)
        const plans = await attendancePlans(conn, context, 'attendance.manage')
        const today = await schoolToday(conn, context.schoolId)
        const day = await readCalendarDay(conn, {
          schoolId: context.schoolId,
          date,
          asOf: today,
          holidays: plans.holidays,
        })
        // A correction reaches back over any school day up to today; only
        // what never was a school day is refused.
        assertSchoolDay(day, section.academic_year_id)

        const roster = await rosterOn(conn, context.schoolId, sectionId, date, plans.pupils)
        const onRoll = new Set(roster.map((pupil) => pupil.id))
        for (const line of body.marks) {
          if (!onRoll.has(line.studentId)) {
            throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_pupil_not_on_roster')
          }
        }

        const current = await currentMarks(
          conn,
          context.schoolId,
          body.marks.map((line) => line.studentId),
          date,
        )
        let corrected = 0
        for (const line of body.marks) {
          const now = current.get(line.studentId)
          if (now?.mark === line.mark) continue
          await insertMark(conn, context, {
            studentId: line.studentId,
            sectionId,
            academicYearId: section.academic_year_id,
            date,
            mark: line.mark,
            kind: 'correction',
            current: now,
          })
          corrected += 1
        }

        await writeAudit(conn, context, {
          action: 'attendance.manage',
          targetType: 'section',
          targetId: sectionId,
          summary: 'Corrected attendance for a section.',
          safeChanges: { sectionId, academicYearId: section.academic_year_id, date, corrected },
          // What somebody typed lives in the note, which can be redacted.
          note: body.reason,
        })
        return readAttendanceDay(conn, context, sectionId, date)
      })
    },
  })
}
