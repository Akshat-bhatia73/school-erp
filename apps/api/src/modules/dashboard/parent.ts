import { sql } from 'drizzle-orm'
import { sections as sectionsTable, timetableEntries } from '@erp/db/schema'
import { loadRelationshipFactsFor, type AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import type { z } from 'zod'
import type {
  DashboardChildAttendance,
  DashboardTimelineSlot,
  EnrollmentSummary,
  ParentDashboard,
} from '@erp/contracts'
import { CONSENT_PURPOSES, type ConsentPurpose } from '@erp/contracts'
import { readPlan } from '../shared/index.ts'
import { ApiFailure } from '../../http/errors.ts'
import { readStatement } from '../fees/statement.ts'
import {
  attendanceFiguresCte,
  attendancePlans,
  monthBounds,
  toSummary,
  type FiguresRow,
} from '../attendance/figures.ts'
import { currentEnrollmentsFor, label, listOwnChildren, predicateFor, rows } from './queries.ts'
import { buildCalendar, currentAcademicYear, dayOfWeek, optionalBlock } from './calendar.ts'
import { loadSchedules, scheduleForGrade } from './bell.ts'

/** The class teacher of one section, as a name only. */
async function classTeacherOf(
  conn: AuthzConnection,
  context: RequestContext,
  sectionId: string,
): Promise<{ id: string; name: string } | undefined> {
  const plan = await readPlan(conn, context, 'sections.read', 'section')
  const [row] = await rows<{ id: string; first_name: string; last_name: string | null }>(
    conn,
    sql`SELECT stf.id AS id, stf.first_name AS first_name, stf.last_name AS last_name
          FROM ${sectionsTable}
          JOIN staff stf ON stf.school_id = ${sectionsTable.schoolId}
                        AND stf.id = ${sectionsTable.classTeacherStaffId}
         WHERE ${predicateFor(plan)} AND ${sectionsTable.id} = ${sectionId}::uuid
         LIMIT 1`,
  )
  if (!row) return undefined
  return { id: row.id, name: label(row.first_name, row.last_name) }
}

/** One section's lessons on one day, laid over the bell schedule of its class. */
async function lessonsFor(
  conn: AuthzConnection,
  context: RequestContext,
  input: { sectionId: string; gradeId: string; yearId: string; date: string },
): Promise<DashboardTimelineSlot[]> {
  const plan = await readPlan(conn, context, 'timetable.read', 'timetable')
  const isoDay = dayOfWeek(input.date)
  if (isoDay === 0) return []
  const found = await rows<{
    section_id: string
    grade_name: string
    section_name: string
    subject_id: string
    subject_name: string
    period_index: number
    room_number: string | null
  }>(
    conn,
    sql`SELECT sct.id AS section_id, grd.name AS grade_name, sct.name AS section_name,
               sbj.id AS subject_id, sbj.name AS subject_name,
               ${timetableEntries.periodIndex} AS period_index,
               ${timetableEntries.roomNumber} AS room_number
          FROM ${timetableEntries}
          JOIN sections sct ON sct.school_id = ${timetableEntries.schoolId} AND sct.id = ${timetableEntries.sectionId}
          JOIN grades grd ON grd.school_id = sct.school_id AND grd.id = sct.grade_id
          JOIN subjects sbj ON sbj.school_id = ${timetableEntries.schoolId} AND sbj.id = ${timetableEntries.subjectId}
         WHERE ${predicateFor(plan)}
           AND ${timetableEntries.sectionId} = ${input.sectionId}::uuid
           AND ${timetableEntries.academicYearId} = ${input.yearId}::uuid
           AND ${timetableEntries.dayOfWeek} = ${isoDay}
         ORDER BY period_index`,
  )
  const schedules = await loadSchedules(conn, context.schoolId, input.yearId)
  const schedule = scheduleForGrade(schedules, input.gradeId)
  if (schedule === null) return []
  return schedule.periods.map((period) => {
    const entry = found.find((row) => row.period_index === period.index)
    return {
      periodIndex: period.index,
      name: period.name,
      startTime: period.startTime,
      endTime: period.endTime,
      type: period.type,
      ...(entry === undefined
        ? {}
        : {
            lesson: {
              section: { id: entry.section_id, name: label(entry.grade_name, entry.section_name) },
              subject: { id: entry.subject_id, name: label(entry.subject_name) },
              ...(entry.room_number === null ? {} : { roomNumber: entry.room_number }),
              cover: false,
            },
          }),
    }
  })
}

/** The consent purposes this child has no answer of "given" on record for. */
async function consentsWaiting(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
): Promise<ConsentPurpose[]> {
  const plan = await readPlan(conn, context, 'students.read_consents', 'student')
  const found = await rows<{ purpose: string }>(
    conn,
    sql`SELECT DISTINCT gc.purpose AS purpose
          FROM guardian_consents gc
         WHERE gc.school_id = ${context.schoolId}::uuid AND gc.student_id = ${studentId}::uuid
           AND gc.status = 'given'
           AND EXISTS (SELECT 1 FROM students
                        WHERE ${predicateFor(plan)} AND students.id = gc.student_id)`,
  )
  const given = new Set(found.map((row) => row.purpose))
  return CONSENT_PURPOSES.filter((purpose) => !given.has(purpose))
}

/**
 * What one child still owes this year: the balance at the foot of their
 * statement, and nothing when the family is paid up or ahead. It is the same
 * figure the statement and the dues list show, so the three never disagree.
 */
async function feesDueFor(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
  yearId: string,
): Promise<number | undefined> {
  try {
    const statement = await readStatement(conn, context, studentId, yearId)
    return Math.max(statement.totals.balancePaise, 0)
  } catch (error) {
    // A child the fee plan does not reach is answered like a record that is
    // not there; the card is then simply left off, as a refused block is.
    if (error instanceof ApiFailure && error.code === 'RESOURCE_NOT_FOUND') return undefined
    throw error
  }
}

/**
 * This month so far for one child, from the same figures the attendance
 * screens use, so the card and the calendar can never disagree. A child the
 * attendance plan does not reach carries no block at all.
 */
async function attendanceFor(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
  date: string,
): Promise<DashboardChildAttendance | undefined> {
  const plans = await attendancePlans(conn, context)
  const schoolId = context.schoolId
  const month = date.slice(0, 7)
  const { from, to } = monthBounds(month)
  const [reached] = await rows<{ ok: boolean }>(
    conn,
    sql`SELECT EXISTS (SELECT 1 FROM students
                        WHERE students.school_id = ${schoolId}::uuid
                          AND students.id = ${studentId}::uuid
                          AND (${plans.pupils})) AS ok`,
  )
  if (reached?.ok !== true) return undefined

  const cte = attendanceFiguresCte({
    schoolId,
    from,
    to,
    asOf: date,
    holidays: plans.holidays,
    spans: sql`enrollments.student_id = ${studentId}::uuid
               AND EXISTS (SELECT 1 FROM students
                            WHERE students.school_id = enrollments.school_id
                              AND students.id = enrollments.student_id
                              AND (${plans.pupils}))`,
    entries: plans.entries,
  })
  const [figures] = await rows<FiguresRow>(conn, sql`${cte} SELECT * FROM att_figures`)
  const summary = toSummary(figures)
  return {
    month,
    percentage: summary.percentage,
    present: summary.present,
    absent: summary.absent,
    schoolDays: summary.schoolDays,
  }
}

/**
 * The parent dashboard: their own children and nothing beside them. The
 * relationship list decides which students belong here and the student plan
 * decides what may be read about them; both are applied.
 */
export async function parentDashboard(
  conn: AuthzConnection,
  context: RequestContext,
  date: string,
): Promise<ParentDashboard> {
  const holidayPlan = await optionalBlock(() => readPlan(conn, context, 'holidays.read', 'holiday'))
  const calendar = await buildCalendar(conn, holidayPlan, date)
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  const year = await currentAcademicYear(conn, context.schoolId)

  const studentPlan = await readPlan(conn, context, 'students.read_basic', 'student')
  const students = await listOwnChildren(conn, studentPlan, facts.ownChildStudentIds)
  const enrollments =
    (await optionalBlock(async () =>
      currentEnrollmentsFor(
        conn,
        await readPlan(conn, context, 'students.read_enrollments', 'enrollment'),
        students.map((child) => child.id),
      ),
    )) ?? new Map<string, z.infer<typeof EnrollmentSummary>>()

  const nextHoliday = calendar.holidays[0]
  const children: ParentDashboard['children'] = []
  for (const student of students) {
    const enrollment = enrollments.get(student.id)
    const classTeacher =
      enrollment === undefined
        ? undefined
        : await optionalBlock(() => classTeacherOf(conn, context, enrollment.section.id))
    const todayLessons =
      enrollment === undefined || year === null
        ? undefined
        : calendar.day.kind !== 'school_day'
          ? []
          : await optionalBlock(() =>
            lessonsFor(conn, context, {
              sectionId: enrollment.section.id,
              gradeId: enrollment.grade.id,
              yearId: year.id,
                date,
              }),
            )
    const waiting = await optionalBlock(() => consentsWaiting(conn, context, student.id))
    const feesDuePaise =
      year === null
        ? undefined
        : await optionalBlock(() => feesDueFor(conn, context, student.id, year.id))
    const attendance = await optionalBlock(() => attendanceFor(conn, context, student.id, date))
    children.push({
      student,
      ...(attendance === undefined ? {} : { attendance }),
      ...(feesDuePaise === undefined ? {} : { feesDuePaise }),
      ...(enrollment === undefined ? {} : { enrollment }),
      ...(classTeacher === undefined ? {} : { classTeacher }),
      ...(todayLessons === undefined ? {} : { todayLessons }),
      ...(nextHoliday === undefined ? {} : { nextHoliday }),
      waitingOn: (waiting ?? []).map((purpose) => ({ kind: 'consent' as const, purpose })),
    })
  }

  return { audience: 'parent', day: calendar.day, children }
}
