import { sql, type SQL } from 'drizzle-orm'
import {
  academicYears,
  enrollments as enrollmentsTable,
  sections as sectionsTable,
  staff as staffTable,
  students as studentsTable,
  timetableEntries,
} from '@erp/db/schema'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { AuthorizedReadPlan } from '@erp/contracts/server'
import type { z } from 'zod'
import { EnrollmentSummary, NamedReference, StudentBasic, TimetableCell } from '@erp/contracts'
import { ApiFailure } from '../../http/errors.ts'

type Named = z.infer<typeof NamedReference>
type Cell = z.infer<typeof TimetableCell>
type Basic = z.infer<typeof StudentBasic>
type Enrollment = z.infer<typeof EnrollmentSummary>

/**
 * Every read below adds the plan predicate to its WHERE clause, so each number
 * and each row on a dashboard is exactly what the matching detail read would
 * allow. Nothing is counted school-wide and filtered afterwards.
 */
function predicateFor(plan: AuthorizedReadPlan): SQL {
  const table = scopedTableFor(plan.resourceType)
  // A resource type with no scoped table cannot be filtered safely, so the
  // dashboard refuses rather than answering with unfiltered rows.
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return planPredicate(plan, table)
}

async function rows<T extends Record<string, unknown>>(
  conn: AuthzConnection,
  query: SQL,
): Promise<T[]> {
  const result = await conn.db.execute(query)
  return result.rows as T[]
}

/**
 * A person or class label, always trimmed to something the contract accepts.
 * Name columns in the database are unbounded text while DisplayName stops at
 * 160 characters, so one long imported name must not make the whole dashboard
 * fail its response parse: clip instead.
 */
const NAME_LIMIT = 160

function label(...parts: (string | null)[]): string {
  const text = parts.filter((part) => part !== null && part.trim() !== '').join(' ').trim()
  if (text === '') return 'Unnamed'
  return text.length > NAME_LIMIT ? text.slice(0, NAME_LIMIT).trim() : text
}

export async function countActiveStudents(conn: AuthzConnection, plan: AuthorizedReadPlan): Promise<number> {
  const [row] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${studentsTable}
         WHERE ${predicateFor(plan)} AND ${studentsTable.status} = 'active'`,
  )
  return row?.total ?? 0
}

/**
 * Staff on the rolls: active plus on leave, which is the headcount the screen
 * this replaces showed. Only people who left (resigned, retired) drop out.
 */
export async function countActiveStaff(conn: AuthzConnection, plan: AuthorizedReadPlan): Promise<number> {
  const [row] = await rows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM ${staffTable}
         WHERE ${predicateFor(plan)} AND ${staffTable.status} IN ('active', 'on_leave')`,
  )
  return row?.total ?? 0
}

/** Sections of the current year the caller both teaches and is allowed to read. */
export async function listAssignedSections(
  conn: AuthzConnection,
  plan: AuthorizedReadPlan,
  staffId: string,
  now: string,
): Promise<Named[]> {
  const found = await rows<{ id: string; grade_name: string; section_name: string }>(
    conn,
    sql`SELECT ${sectionsTable.id} AS id, grd.name AS grade_name, ${sectionsTable.name} AS section_name
          FROM ${sectionsTable}
          JOIN ${academicYears} yr
            ON yr.school_id = ${sectionsTable.schoolId} AND yr.id = ${sectionsTable.academicYearId}
          JOIN grades grd
            ON grd.school_id = ${sectionsTable.schoolId} AND grd.id = ${sectionsTable.gradeId}
         WHERE ${predicateFor(plan)}
           AND yr.status = 'current'
           AND EXISTS (SELECT 1 FROM teaching_assignments ta
                        WHERE ta.school_id = ${sectionsTable.schoolId}
                          AND ta.section_id = ${sectionsTable.id}
                          AND ta.academic_year_id = ${sectionsTable.academicYearId}
                          AND ta.staff_id = ${staffId}::uuid
                          AND ta.effective_from <= ${now}::date
                          AND (ta.effective_to IS NULL OR ta.effective_to >= ${now}::date))
         ORDER BY grd.sort_order, section_name`,
  )
  return found.map((row) => ({ id: row.id, name: label(row.grade_name, row.section_name) }))
}

/** The caller's own periods: allowed by the plan and taught by them. */
export async function listOwnTimetable(
  conn: AuthzConnection,
  plan: AuthorizedReadPlan,
  staffId: string,
): Promise<Cell[]> {
  const found = await rows<{
    section_id: string
    grade_name: string
    section_name: string
    subject_id: string
    subject_name: string
    teacher_id: string
    teacher_first: string
    teacher_last: string | null
    day_of_week: number
    period_index: number
    room_number: string | null
  }>(
    conn,
    sql`SELECT sct.id AS section_id, grd.name AS grade_name, sct.name AS section_name,
               sbj.id AS subject_id, sbj.name AS subject_name,
               stf.id AS teacher_id, stf.first_name AS teacher_first, stf.last_name AS teacher_last,
               ${timetableEntries.dayOfWeek} AS day_of_week,
               ${timetableEntries.periodIndex} AS period_index,
               ${timetableEntries.roomNumber} AS room_number
          FROM ${timetableEntries}
          JOIN sections sct
            ON sct.school_id = ${timetableEntries.schoolId} AND sct.id = ${timetableEntries.sectionId}
          JOIN grades grd ON grd.school_id = sct.school_id AND grd.id = sct.grade_id
          JOIN subjects sbj
            ON sbj.school_id = ${timetableEntries.schoolId} AND sbj.id = ${timetableEntries.subjectId}
          JOIN staff stf
            ON stf.school_id = ${timetableEntries.schoolId} AND stf.id = ${timetableEntries.staffId}
         WHERE ${predicateFor(plan)} AND ${timetableEntries.staffId} = ${staffId}::uuid
         ORDER BY day_of_week, period_index`,
  )
  return found.map((row) => ({
    section: { id: row.section_id, name: label(row.grade_name, row.section_name) },
    subject: { id: row.subject_id, name: label(row.subject_name) },
    teacher: { id: row.teacher_id, name: label(row.teacher_first, row.teacher_last) },
    dayOfWeek: row.day_of_week,
    periodIndex: row.period_index,
    ...(row.room_number === null ? {} : { roomNumber: row.room_number }),
  }))
}

/**
 * The caller's own children: the read plan decides what may be read at all, and
 * the relationship list decides what belongs on a parent dashboard. Both are
 * applied, because a member who also holds a wider students.read_basic scope
 * (an accountant, or a school-wide access rule) must not see the whole school
 * listed as their children. The cap keeps the payload bounded.
 */
const CHILD_LIMIT = 50

export async function listOwnChildren(
  conn: AuthzConnection,
  plan: AuthorizedReadPlan,
  childStudentIds: readonly string[],
): Promise<Basic[]> {
  if (childStudentIds.length === 0) return []
  const idList = sql.join(
    childStudentIds.map((value) => sql`${value}::uuid`),
    sql`, `,
  )
  const found = await rows<{
    id: string
    school_id: string
    version: number
    first_name: string
    last_name: string | null
    admission_number: string
    status: Basic['status']
  }>(
    conn,
    sql`SELECT ${studentsTable.id} AS id, ${studentsTable.schoolId} AS school_id,
               ${studentsTable.version} AS version, ${studentsTable.firstName} AS first_name,
               ${studentsTable.lastName} AS last_name,
               ${studentsTable.admissionNumber} AS admission_number,
               ${studentsTable.status} AS status
          FROM ${studentsTable}
         WHERE ${predicateFor(plan)} AND ${studentsTable.id} IN (${idList})
         ORDER BY first_name, admission_number
         LIMIT ${CHILD_LIMIT}`,
  )
  return found.map((row) => ({
    id: row.id,
    schoolId: row.school_id,
    version: Number(row.version),
    firstName: row.first_name,
    ...(row.last_name === null || row.last_name.trim() === '' ? {} : { lastName: row.last_name }),
    admissionNumber: row.admission_number,
    status: row.status,
  }))
}

/** Current enrollments, by student, through the enrollment plan's own predicate. */
export async function currentEnrollmentsFor(
  conn: AuthzConnection,
  plan: AuthorizedReadPlan,
  studentIds: readonly string[],
): Promise<Map<string, Enrollment>> {
  const byStudent = new Map<string, Enrollment>()
  if (studentIds.length === 0) return byStudent
  const idList = sql.join(
    studentIds.map((value) => sql`${value}::uuid`),
    sql`, `,
  )
  const found = await rows<{
    id: string
    student_id: string
    roll_number: number | null
    outcome: Enrollment['outcome']
    year_id: string
    year_name: string
    section_id: string
    section_name: string
    grade_id: string
    grade_name: string
  }>(
    conn,
    sql`SELECT ${enrollmentsTable.id} AS id, ${enrollmentsTable.studentId} AS student_id,
               ${enrollmentsTable.rollNumber} AS roll_number, ${enrollmentsTable.outcome} AS outcome,
               yr.id AS year_id, yr.name AS year_name,
               sct.id AS section_id, sct.name AS section_name,
               grd.id AS grade_id, grd.name AS grade_name
          FROM ${enrollmentsTable}
          JOIN academic_years yr
            ON yr.school_id = ${enrollmentsTable.schoolId} AND yr.id = ${enrollmentsTable.academicYearId}
          JOIN sections sct
            ON sct.school_id = ${enrollmentsTable.schoolId} AND sct.id = ${enrollmentsTable.sectionId}
          JOIN grades grd ON grd.school_id = sct.school_id AND grd.id = sct.grade_id
         WHERE ${predicateFor(plan)}
           AND ${enrollmentsTable.leftOn} IS NULL
           AND ${enrollmentsTable.studentId} IN (${idList})
         ORDER BY yr.start_date DESC`,
  )
  for (const row of found) {
    if (byStudent.has(row.student_id)) continue
    byStudent.set(row.student_id, {
      id: row.id,
      academicYear: { id: row.year_id, name: label(row.year_name) },
      section: { id: row.section_id, name: label(row.section_name) },
      grade: { id: row.grade_id, name: label(row.grade_name) },
      ...(row.roll_number === null || row.roll_number <= 0 ? {} : { rollNumber: row.roll_number }),
      outcome: row.outcome,
    })
  }
  return byStudent
}
