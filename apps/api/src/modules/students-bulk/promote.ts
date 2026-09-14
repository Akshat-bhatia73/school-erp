import type { PoolClient } from 'pg'
import { ApiFailure } from '../shared/errors.ts'

export interface SectionFacts {
  readonly id: string
  readonly name: string
  readonly gradeId: string
  readonly gradeName: string
}

/**
 * A section of this school, in the year the caller named. Asking for both
 * together is what stops a promotion from reaching into another year, and a
 * section from another school simply does not exist here.
 */
export async function sectionInYear(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
  sectionId: string,
  /**
   * Reads must not tell a stranger whether a section exists, so a GET asks for
   * RESOURCE_NOT_FOUND; a write names the section in a body it composed, so an
   * unreachable one is bad input.
   */
  missing: 'INVALID_REQUEST' | 'RESOURCE_NOT_FOUND' = 'INVALID_REQUEST',
): Promise<SectionFacts> {
  const result = await client.query<{
    id: string
    name: string
    grade_id: string
    grade_name: string
  }>(
    `SELECT s.id, s.name, s.grade_id, g.name AS grade_name
       FROM sections s
       JOIN grades g ON g.school_id = s.school_id AND g.id = s.grade_id
      WHERE s.school_id = $1 AND s.academic_year_id = $2 AND s.id = $3`,
    [schoolId, academicYearId, sectionId],
  )
  const row = result.rows[0]
  if (!row) throw new ApiFailure(missing)
  return { id: row.id, name: row.name, gradeId: row.grade_id, gradeName: row.grade_name }
}

/**
 * Every named student must be sitting in this section, in this year, right
 * now. One that is not means the caller is working from a stale list, so the
 * whole promotion is refused before anything is written.
 */
export async function assertAllEnrolled(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
  sectionId: string,
  studentIds: readonly string[],
): Promise<void> {
  if (studentIds.length === 0) return
  const result = await client.query<{ total: number }>(
    // Counted over distinct students: nothing stops a student from holding two
    // open rows in the same class, and count(*) would then let an unrelated
    // student ride along in the same request.
    `SELECT count(DISTINCT student_id)::int AS total FROM enrollments
      WHERE school_id = $1 AND academic_year_id = $2 AND section_id = $3
        AND left_on IS NULL AND student_id = ANY($4::uuid[])`,
    [schoolId, academicYearId, sectionId, [...studentIds]],
  )
  if ((result.rows[0]?.total ?? 0) !== studentIds.length) throw new ApiFailure('INVALID_REQUEST')
}

/** Nobody may hold two open enrollments, so the target year must be free. */
export async function assertNotAlreadyInYear(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
  studentIds: readonly string[],
): Promise<void> {
  if (studentIds.length === 0) return
  const result = await client.query(
    `SELECT 1 FROM enrollments
      WHERE school_id = $1 AND academic_year_id = $2 AND left_on IS NULL
        AND student_id = ANY($3::uuid[])
      LIMIT 1`,
    [schoolId, academicYearId, [...studentIds]],
  )
  if ((result.rowCount ?? 0) > 0) throw new ApiFailure('INVALID_REQUEST')
}

/**
 * Where a detained student goes: the same grade again, in the new year. The
 * section with the same name is preferred so a class stays recognisable, and
 * a grade with no section next year refuses the request instead of guessing.
 */
export async function detainedSection(
  client: PoolClient,
  schoolId: string,
  toAcademicYearId: string,
  gradeId: string,
  preferredName: string,
): Promise<string> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM sections
      WHERE school_id = $1 AND academic_year_id = $2 AND grade_id = $3
      ORDER BY (name = $4) DESC, name
      LIMIT 1`,
    [schoolId, toAcademicYearId, gradeId, preferredName],
  )
  const row = result.rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  return row.id
}

/** Closes the current enrollment of each student with the stated outcome. */
export async function closeEnrollments(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
  sectionId: string,
  studentIds: readonly string[],
  outcome: 'promoted' | 'detained',
): Promise<void> {
  if (studentIds.length === 0) return
  await client.query(
    `UPDATE enrollments
        SET left_on = GREATEST(joined_on, current_date), outcome = $5, updated_at = now()
      WHERE school_id = $1 AND academic_year_id = $2 AND section_id = $3
        AND left_on IS NULL AND student_id = ANY($4::uuid[])`,
    [schoolId, academicYearId, sectionId, [...studentIds], outcome],
  )
}

/** Opens next year's enrollment for each student, in one statement. */
export async function openEnrollments(
  client: PoolClient,
  schoolId: string,
  academicYearId: string,
  sectionId: string,
  studentIds: readonly string[],
): Promise<void> {
  if (studentIds.length === 0) return
  await client.query(
    `INSERT INTO enrollments
       (school_id, student_id, academic_year_id, section_id, joined_on, outcome)
     SELECT $1, student_id, $2, $3, current_date, 'ongoing'
       FROM unnest($4::uuid[]) AS student_id`,
    [schoolId, academicYearId, sectionId, [...studentIds]],
  )
}
