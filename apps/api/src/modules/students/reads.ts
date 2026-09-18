import { sql, type SQL } from 'drizzle-orm'
import { AuthorizationError, planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { AuthorizedReadPlan, RequestContext } from '@erp/contracts/server'
import type { StudentListRequest } from '@erp/contracts'
import { readPlan } from '../shared/index.ts'

/**
 * The connection a module read runs on: the tenant transaction the route
 * opened, which is also what the authorizer needs for its own lookups.
 */
export type ModuleConnection = AuthzConnection

/** The student table as the authorizer describes it, for list predicates. */
export function studentTable() {
  const table = scopedTableFor('student')
  // The catalogue always has this entry; the check keeps the type honest.
  if (!table) throw new Error('the authorizer has no scoped table for students')
  return table
}

/** The enrolment table as the authorizer describes it. */
function enrollmentTable() {
  const table = scopedTableFor('enrollment')
  if (!table) throw new Error('the authorizer has no scoped table for enrolments')
  return table
}

/**
 * The class shown inside a basic student record is enrolment data, so it is
 * decided by the enrolment key rather than carried along for free. A caller
 * who may not read a given enrolment simply sees no class on that student,
 * which keeps the roster and GET /students/:id/enrollments in agreement even
 * when a student holds more than one open enrolment.
 */
export async function enrollmentVisibility(
  conn: ModuleConnection,
  context: RequestContext,
): Promise<SQL> {
  try {
    const plan = await readPlan(conn, context, 'students.read_enrollments', 'enrollment')
    return planPredicate(plan, enrollmentTable())
  } catch (error) {
    // No enrolment grant at all is not an error here: the block is omitted.
    if (error instanceof AuthorizationError) return sql`FALSE`
    throw error
  }
}

export interface StudentRow extends Record<string, unknown> {
  id: string
  school_id: string
  version: number
  first_name: string
  last_name: string | null
  admission_number: string
  status: string
  anonymised_at: string | null
  enrollment_id: string | null
  roll_number: number | null
  outcome: string | null
  year_id: string | null
  year_name: string | null
  section_id: string | null
  section_name: string | null
  grade_id: string | null
  grade_name: string | null
  /** Present only when the caller asked for the sensitive block. */
  date_of_birth?: string | null
  gender?: string | null
  category?: string | null
  admission_type?: string | null
  admission_date?: string | null
  apaar_last4?: string | null
  apaar_ciphertext?: string | null
  aadhaar_last4?: string | null
  address?: string | null
  /** Present only when the caller asked for the medical block. */
  blood_group?: string | null
  medical_notes?: string | null
}

/**
 * Which restricted column groups the statement may name. The roster, the
 * search and the count always pass the default, so a basic reader's query
 * never mentions a health note or a home address at all: nothing to leak
 * through an error message, a query log or a later change to the projection.
 */
export interface StudentReadOptions {
  readonly sensitive: boolean
  readonly medical: boolean
}

const BASIC: StudentReadOptions = { sensitive: false, medical: false }

/**
 * One statement for the roster, the search, the count and the detail read, so
 * a student appears in a list exactly when the detail read would return it.
 * The plan predicate is the only thing that decides which rows exist at all;
 * the filters below narrow that set and can never widen it.
 */
function studentSource(predicate: SQL, enrollmentPredicate: SQL, filters: SQL[]): SQL {
  const where = filters.reduce((carry, part) => sql`${carry} AND ${part}`, predicate)
  return sql`FROM students
      LEFT JOIN LATERAL (
        SELECT enrollments.id, enrollments.roll_number, enrollments.outcome,
               enrollments.section_id, enrollments.academic_year_id
          FROM enrollments
         WHERE enrollments.school_id = students.school_id AND enrollments.student_id = students.id
           AND enrollments.left_on IS NULL AND (${enrollmentPredicate})
         ORDER BY enrollments.joined_on DESC, enrollments.id
         LIMIT 1
      ) current_enrollment ON TRUE
      LEFT JOIN sections sec ON sec.school_id = students.school_id
        AND sec.id = current_enrollment.section_id
      LEFT JOIN academic_years ay ON ay.school_id = students.school_id
        AND ay.id = current_enrollment.academic_year_id
      LEFT JOIN grades gr ON gr.school_id = students.school_id AND gr.id = sec.grade_id
     WHERE ${where}`
}

/** The select list for a read, built from what the caller was allowed. */
export function studentProjection(options: StudentReadOptions): SQL {
  const sensitive = options.sensitive
    ? sql`, students.date_of_birth::text AS date_of_birth, students.gender, students.category,
      students.admission_type, students.admission_date::text AS admission_date,
      students.apaar_last4, students.apaar_ciphertext, students.aadhaar_last4,
      COALESCE(students.address #>> '{}', students.address::text) AS address`
    : sql``
  const medical = options.medical
    ? sql`, students.blood_group, students.medical_notes`
    : sql``
  return sql`SELECT students.id, students.school_id, students.version,
      students.first_name, students.last_name, students.admission_number, students.status,
      students.anonymised_at::text AS anonymised_at,
      current_enrollment.id AS enrollment_id, current_enrollment.roll_number, current_enrollment.outcome,
      ay.id AS year_id, ay.name AS year_name, sec.id AS section_id, sec.name AS section_name,
      gr.id AS grade_id, gr.name AS grade_name${sensitive}${medical} `
}

/** The filters the roster, the count and the search all share. */
export function rosterFilters(input: {
  readonly search?: string
  readonly sectionId?: string
  readonly academicYearId?: string
  readonly status?: string
}): SQL[] {
  const filters: SQL[] = []
  if (input.status !== undefined) filters.push(sql`students.status = ${input.status}`)
  if (input.sectionId !== undefined) {
    filters.push(sql`current_enrollment.section_id = ${input.sectionId}::uuid`)
  }
  if (input.academicYearId !== undefined) {
    filters.push(sql`current_enrollment.academic_year_id = ${input.academicYearId}::uuid`)
  }
  if (input.search !== undefined && input.search !== '') {
    // Only fields the basic projection already shows are searchable, so a
    // search can never confirm a value the caller may not read.
    const like = `%${input.search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
    filters.push(
      sql`(students.first_name ILIKE ${like} ESCAPE '\\'
        OR students.last_name ILIKE ${like} ESCAPE '\\'
        OR students.admission_number ILIKE ${like} ESCAPE '\\')`,
    )
  }
  return filters
}

function orderBy(sort: StudentListRequest['sort']): SQL {
  switch (sort) {
    case 'admission':
      return sql`students.admission_number ASC, students.id ASC`
    case 'roll':
      return sql`current_enrollment.roll_number ASC NULLS LAST, students.id ASC`
    default:
      return sql`students.first_name ASC, students.last_name ASC NULLS LAST, students.id ASC`
  }
}

export async function listStudents(
  conn: ModuleConnection,
  plan: AuthorizedReadPlan,
  enrollmentPredicate: SQL,
  input: StudentListRequest,
): Promise<{ rows: StudentRow[]; total: number }> {
  const predicate = planPredicate(plan, studentTable())
  const filters = rosterFilters(input)
  const offset = (input.page - 1) * input.pageSize
  const rows = await conn.db.execute<StudentRow>(
    sql`${studentProjection(BASIC)} ${studentSource(predicate, enrollmentPredicate, filters)}
        ORDER BY ${orderBy(input.sort)} LIMIT ${input.pageSize} OFFSET ${offset}`,
  )
  const counted = await conn.db.execute<{ total: number }>(
    sql`SELECT count(*)::int AS total ${studentSource(predicate, enrollmentPredicate, filters)}`,
  )
  return { rows: rows.rows, total: Number(counted.rows[0]?.total ?? 0) }
}

export async function countStudents(
  conn: ModuleConnection,
  plan: AuthorizedReadPlan,
  enrollmentPredicate: SQL,
  filters: SQL[],
): Promise<number> {
  const predicate = planPredicate(plan, studentTable())
  const counted = await conn.db.execute<{ total: number }>(
    sql`SELECT count(*)::int AS total ${studentSource(predicate, enrollmentPredicate, filters)}`,
  )
  return Number(counted.rows[0]?.total ?? 0)
}

export async function searchStudents(
  conn: ModuleConnection,
  plan: AuthorizedReadPlan,
  enrollmentPredicate: SQL,
  term: string,
): Promise<StudentRow[]> {
  const predicate = planPredicate(plan, studentTable())
  const rows = await conn.db.execute<StudentRow>(
    sql`${studentProjection(BASIC)} ${studentSource(predicate, enrollmentPredicate, rosterFilters({ search: term }))}
        ORDER BY students.first_name ASC, students.id ASC LIMIT 20`,
  )
  return rows.rows
}

/** One student, through the very predicate the roster uses. */
export async function getStudent(
  conn: ModuleConnection,
  plan: AuthorizedReadPlan,
  enrollmentPredicate: SQL,
  studentId: string,
  options: StudentReadOptions = BASIC,
): Promise<StudentRow | null> {
  const predicate = planPredicate(plan, studentTable())
  const rows = await conn.db.execute<StudentRow>(
    sql`${studentProjection(options)} ${studentSource(predicate, enrollmentPredicate, [sql`students.id = ${studentId}::uuid`])} LIMIT 1`,
  )
  return rows.rows[0] ?? null
}

/** The ids of students that share at least one guardian with this student. */
export async function siblingIds(
  conn: ModuleConnection,
  schoolId: string,
  studentId: string,
): Promise<string[]> {
  const rows = await conn.db.execute<{ student_id: string }>(
    sql`SELECT DISTINCT other.student_id FROM student_guardians mine
          JOIN student_guardians other ON other.school_id = mine.school_id
           AND other.guardian_id = mine.guardian_id AND other.student_id <> mine.student_id
         WHERE mine.school_id = ${schoolId}::uuid AND mine.student_id = ${studentId}::uuid`,
  )
  return rows.rows.map((row) => row.student_id)
}
