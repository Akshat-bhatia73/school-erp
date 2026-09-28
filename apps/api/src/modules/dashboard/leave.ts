import { sql, type SQL } from 'drizzle-orm'
import { AuthorizationError, planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { DashboardLeaveToday } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { readPlan } from '../shared/index.ts'
import { attendancePlans, staffAttendancePlans, staffOnLeave } from '../attendance/figures.ts'
import { sectionVisibility } from '../attendance/reads.ts'
import { optionalBlock } from './calendar.ts'
import { label, rows } from './queries.ts'

/**
 * Who is on recorded leave today, for the office dashboard. Each half is read
 * through the caller's own plan, exactly as the leave lists read it, so a
 * count here is a count of rows those lists would show; a half whose read key
 * the caller does not hold is left out, and with neither the block is.
 */

const NAMES = 10

/** A plan the caller does not hold at all reads as FALSE, not as an error. */
async function predicateOrFalse(build: () => Promise<SQL>): Promise<SQL> {
  try {
    return await build()
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'ACCESS_DENIED') return sql`FALSE`
    throw error
  }
}

interface StaffNamedRow extends Record<string, unknown> {
  id: string
  first_name: string
  last_name: string | null
  ends_on: string
  total: number
}

interface NamedRow extends StaffNamedRow {
  class_name: string | null
}

async function pupilsOnLeave(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<NonNullable<DashboardLeaveToday['students']>> {
  const schoolId = context.schoolId
  const plans = await attendancePlans(conn, context)
  const sections = await sectionVisibility(conn, context)
  const enrollmentTable = scopedTableFor('enrollment')
  if (!enrollmentTable) throw new Error('the authorizer has no scoped table for enrollment')
  const enrolments = await predicateOrFalse(async () =>
    planPredicate(await readPlan(conn, context, 'students.read_enrollments', 'enrollment'), enrollmentTable),
  )
  const found = await rows<NamedRow>(
    conn,
    sql`SELECT students.id, students.first_name, students.last_name,
               to_char(lr.ends_on, 'YYYY-MM-DD') AS ends_on,
               (SELECT grades.name || ' ' || sections.name
                  FROM enrollments
                  JOIN sections ON sections.school_id = enrollments.school_id AND sections.id = enrollments.section_id
                  JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
                 WHERE enrollments.school_id = students.school_id AND enrollments.student_id = students.id
                   AND enrollments.joined_on <= ${date}::date
                   AND (enrollments.left_on IS NULL OR enrollments.left_on >= ${date}::date)
                   AND (${enrolments}) AND (${sections})
                 ORDER BY enrollments.joined_on DESC, enrollments.id LIMIT 1) AS class_name,
               count(*) OVER ()::int AS total
          FROM students
          JOIN LATERAL (
            SELECT leave_records.ends_on FROM leave_records
             WHERE leave_records.school_id = students.school_id
               AND leave_records.student_id = students.id
               AND leave_records.cancelled_at IS NULL
               AND ${date}::date BETWEEN leave_records.starts_on AND leave_records.ends_on
             ORDER BY leave_records.ends_on DESC LIMIT 1
          ) lr ON TRUE
         WHERE students.school_id = ${schoolId}::uuid
           AND students.status = 'active'
           AND (${plans.pupils})
         ORDER BY lr.ends_on, students.first_name, students.last_name, students.id
         LIMIT ${NAMES}`,
  )
  return {
    count: Number(found[0]?.total ?? 0),
    names: found.map((row) => ({
      id: row.id,
      name: label(row.first_name, row.last_name),
      ...(row.class_name === null ? {} : { section: label(row.class_name) }),
      endsOn: row.ends_on,
    })),
  }
}

async function staffOnLeaveToday(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<NonNullable<DashboardLeaveToday['staff']>> {
  const schoolId = context.schoolId
  const plans = await staffAttendancePlans(conn, context)
  const found = await rows<StaffNamedRow>(
    conn,
    sql`SELECT staff.id, staff.first_name, staff.last_name,
               to_char(lr.ends_on, 'YYYY-MM-DD') AS ends_on,
               count(*) OVER ()::int AS total
          FROM staff
          JOIN LATERAL (
            SELECT leave_records.ends_on FROM leave_records
             WHERE leave_records.school_id = staff.school_id
               AND leave_records.staff_id = staff.id
               AND leave_records.cancelled_at IS NULL
               AND ${date}::date BETWEEN leave_records.starts_on AND leave_records.ends_on
             ORDER BY leave_records.ends_on DESC LIMIT 1
          ) lr ON TRUE
         WHERE staff.school_id = ${schoolId}::uuid
           AND staff.status IN ('active', 'on_leave')
           AND (${plans.people})
         ORDER BY lr.ends_on, staff.first_name, staff.last_name, staff.id
         LIMIT ${NAMES}`,
  )
  return {
    count: Number(found[0]?.total ?? 0),
    names: found.map((row) => ({ id: row.id, name: label(row.first_name, row.last_name), endsOn: row.ends_on })),
  }
}

/** The "On leave today" block, or undefined for a caller who reads neither half. */
export async function leaveToday(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<DashboardLeaveToday | undefined> {
  const staff = await optionalBlock(() => staffOnLeaveToday(conn, context, date))
  const students = await optionalBlock(() => pupilsOnLeave(conn, context, date))
  if (staff === undefined && students === undefined) return undefined
  return {
    date,
    ...(staff === undefined ? {} : { staff }),
    ...(students === undefined ? {} : { students }),
  }
}

/**
 * Over `staff`: teachers on recorded leave that day who have no saved mark of
 * present or late, read through the caller's staff attendance plan. FALSE for
 * a caller who does not read the staff register, so they only ever count the
 * cover arrangements they could already see.
 */
export async function teachersOnLeave(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<SQL> {
  const schoolId = context.schoolId
  const plans = await optionalBlock(() => staffAttendancePlans(conn, context))
  if (plans === undefined) return sql`FALSE`
  return sql`(staff.staff_type = 'teaching'
      AND staff.status IN ('active', 'on_leave')
      AND ${staffOnLeave(schoolId, sql`staff.id`, sql`${date}::date`)}
      AND (${plans.people})
      AND NOT EXISTS (
        SELECT 1 FROM (
          SELECT staff_attendance_entries.mark FROM staff_attendance_entries
           WHERE staff_attendance_entries.school_id = staff.school_id
             AND staff_attendance_entries.staff_id = staff.id
             AND staff_attendance_entries.date = ${date}::date
             AND (${plans.entries})
           ORDER BY staff_attendance_entries.revision DESC LIMIT 1
        ) cur WHERE cur.mark IN ('present', 'late')))`
}
