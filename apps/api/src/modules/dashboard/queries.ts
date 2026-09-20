import { sql, type SQL } from 'drizzle-orm'
import {
  enrollments as enrollmentsTable,
  students as studentsTable,
} from '@erp/db/schema'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { AuthorizedReadPlan } from '@erp/contracts/server'
import type { z } from 'zod'
import { EnrollmentSummary, StudentBasic } from '@erp/contracts'
import { ApiFailure } from '../../http/errors.ts'
import { photoMoment } from '../students/project.ts'

type Basic = z.infer<typeof StudentBasic>
type Enrollment = z.infer<typeof EnrollmentSummary>

/**
 * Every read below adds the plan predicate to its WHERE clause, so each number
 * and each row on a dashboard is exactly what the matching detail read would
 * allow. Nothing is counted school-wide and filtered afterwards.
 */
export function predicateFor(plan: AuthorizedReadPlan): SQL {
  const table = scopedTableFor(plan.resourceType)
  // A resource type with no scoped table cannot be filtered safely, so the
  // dashboard refuses rather than answering with unfiltered rows.
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return planPredicate(plan, table)
}

export async function rows<T extends Record<string, unknown>>(
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

export function label(...parts: (string | null)[]): string {
  const text = parts.filter((part) => part !== null && part.trim() !== '').join(' ').trim()
  if (text === '') return 'Unnamed'
  return text.length > NAME_LIMIT ? text.slice(0, NAME_LIMIT).trim() : text
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
    anonymised_at: string | null
    has_photo: boolean
    photo_updated_at: string | null
  }>(
    conn,
    sql`SELECT ${studentsTable.id} AS id, ${studentsTable.schoolId} AS school_id,
               ${studentsTable.version} AS version, ${studentsTable.firstName} AS first_name,
               ${studentsTable.lastName} AS last_name,
               ${studentsTable.admissionNumber} AS admission_number,
               ${studentsTable.status} AS status,
               ${studentsTable.anonymisedAt}::text AS anonymised_at,
               (${studentsTable.photoStorageKey} IS NOT NULL) AS has_photo,
               ${studentsTable.photoUpdatedAt}::text AS photo_updated_at
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
    anonymised: row.anonymised_at !== null,
    // Whether there is a photograph, never where its bytes live.
    hasPhoto: row.has_photo === true,
    ...(photoMoment(row.photo_updated_at) === undefined
      ? {}
      : { photoUpdatedAt: photoMoment(row.photo_updated_at) as string }),
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
