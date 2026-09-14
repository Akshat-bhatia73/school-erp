import type { FastifyInstance } from 'fastify'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { SearchQueryRequest, SearchResponse } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { academicYears, enrollments, grades, sections, staff, students } from '@erp/db/schema'
import { AuthorizationError, planPredicate, scopedTableFor } from '@erp/authz'
import type { AuthzConnection } from '@erp/authz'
import { protectedRoute, readPlan } from '../shared/index.ts'
import type { ModuleDependencies } from '../shared/route.ts'

/** The command menu never shows more than this many rows of either kind. */
const LIMIT = 10

type Student = typeof SearchResponse._output.students[number]
type Staff = typeof SearchResponse._output.staff[number]

/**
 * The term is data, never pattern syntax: the wildcards are escaped and the
 * whole value is bound as a parameter, so searching for "50%" looks for those
 * three characters rather than matching every row in the school.
 */
function containsTerm(column: SQL | PgColumn, term: string): SQL {
  const escaped = term.replace(/[\\%_]/g, (character) => `\\${character}`)
  return sql`${column} ILIKE ${`%${escaped}%`} ESCAPE '\\'`
}

/**
 * A plan for a permission the caller holds nowhere is not an error here. The
 * command menu searches two kinds of record at once, so the kind the caller may
 * not read is simply empty rather than failing the whole search.
 */
async function optionalPlan(
  conn: AuthzConnection,
  context: RequestContext,
  permission: 'students.read_basic' | 'students.read_enrollments' | 'staff.read_directory',
  resourceType: 'student' | 'staff' | 'enrollment',
): Promise<Awaited<ReturnType<typeof readPlan>> | null> {
  try {
    return await readPlan(conn, context, permission, resourceType)
  } catch (error) {
    if (error instanceof AuthorizationError) return null
    throw error
  }
}

/** Matching students, restricted to the rows the caller's plan allows. */
async function findStudents(conn: AuthzConnection, context: RequestContext, term: string): Promise<Student[]> {
  const plan = await optionalPlan(conn, context, 'students.read_basic', 'student')
  const table = scopedTableFor('student')
  if (!plan || !table) return []

  // Name and admission number only. Nothing here searches a field the caller
  // may not see, so a term can never confirm a phone, an address or an Aadhaar.
  const matches = sql`(${containsTerm(students.firstName, term)}
    OR ${containsTerm(sql`coalesce(${students.lastName}, '')`, term)}
    OR ${containsTerm(sql`${students.firstName} || ' ' || coalesce(${students.lastName}, '')`, term)}
    OR ${containsTerm(students.admissionNumber, term)})`

  const rows = await conn.db
    .select({
      id: students.id,
      schoolId: students.schoolId,
      version: students.version,
      firstName: students.firstName,
      lastName: students.lastName,
      admissionNumber: students.admissionNumber,
      status: students.status,
    })
    .from(students)
    .where(and(planPredicate(plan, table), matches))
    .orderBy(students.admissionNumber)
    .limit(LIMIT)

  const found: Student[] = rows.map((row) => ({
    id: row.id,
    schoolId: row.schoolId,
    version: row.version,
    firstName: row.firstName,
    ...(row.lastName === null ? {} : { lastName: row.lastName }),
    admissionNumber: row.admissionNumber,
    status: row.status as Student['status'],
  }))
  if (found.length === 0) return found

  // The current class is its own field group with its own permission and its
  // own scope, so it is decided separately: a caller who may read the student
  // but not enrollments, or who may read only the enrollments of the sections
  // they teach, gets the hit without a summary rather than someone else's class.
  const enrollmentPlan = await optionalPlan(conn, context, 'students.read_enrollments', 'enrollment')
  const enrollmentTable = scopedTableFor('enrollment')
  if (!enrollmentPlan || !enrollmentTable) return found

  // One extra query for the current classes of the rows already chosen. It is
  // bounded by LIMIT, so the summary stays cheap enough to include.
  const current = await conn.db
    .select({
      studentId: enrollments.studentId,
      id: enrollments.id,
      rollNumber: enrollments.rollNumber,
      outcome: enrollments.outcome,
      yearId: academicYears.id,
      yearName: academicYears.name,
      sectionId: sections.id,
      sectionName: sections.name,
      gradeId: grades.id,
      gradeName: grades.name,
    })
    .from(enrollments)
    .innerJoin(
      sections,
      and(eq(sections.schoolId, enrollments.schoolId), eq(sections.id, enrollments.sectionId)),
    )
    .innerJoin(grades, and(eq(grades.schoolId, sections.schoolId), eq(grades.id, sections.gradeId)))
    .innerJoin(
      academicYears,
      and(eq(academicYears.schoolId, enrollments.schoolId), eq(academicYears.id, enrollments.academicYearId)),
    )
    .where(
      and(
        planPredicate(enrollmentPlan, enrollmentTable),
        eq(enrollments.schoolId, context.schoolId),
        inArray(
          enrollments.studentId,
          found.map((student) => student.id),
        ),
        isNull(enrollments.leftOn),
      ),
    )
    // A student may hold more than one open enrollment; the newest one wins, so
    // the answer does not depend on the order the database happens to return.
    .orderBy(desc(enrollments.joinedOn), asc(enrollments.id))

  return found.map((student) => {
    const enrollment = current.find((row) => row.studentId === student.id)
    if (!enrollment) return student
    return {
      ...student,
      enrollment: {
        id: enrollment.id,
        academicYear: { id: enrollment.yearId, name: enrollment.yearName },
        section: { id: enrollment.sectionId, name: enrollment.sectionName },
        grade: { id: enrollment.gradeId, name: enrollment.gradeName },
        ...(enrollment.rollNumber === null ? {} : { rollNumber: enrollment.rollNumber }),
        outcome: enrollment.outcome as 'ongoing' | 'promoted' | 'detained' | 'left',
      },
    }
  })
}

/** Matching staff, restricted to the rows the caller's directory plan allows. */
async function findStaff(conn: AuthzConnection, context: RequestContext, term: string): Promise<Staff[]> {
  const plan = await optionalPlan(conn, context, 'staff.read_directory', 'staff')
  const table = scopedTableFor('staff')
  if (!plan || !table) return []

  // Directory fields only: never phone, address, pay or bank details.
  const matches = sql`(${containsTerm(staff.firstName, term)}
    OR ${containsTerm(sql`coalesce(${staff.lastName}, '')`, term)}
    OR ${containsTerm(sql`${staff.firstName} || ' ' || coalesce(${staff.lastName}, '')`, term)}
    OR ${containsTerm(staff.employeeCode, term)}
    OR ${containsTerm(staff.designation, term)})`

  const rows = await conn.db
    .select({
      id: staff.id,
      schoolId: staff.schoolId,
      version: staff.version,
      firstName: staff.firstName,
      lastName: staff.lastName,
      designation: staff.designation,
      department: staff.department,
    })
    .from(staff)
    .where(and(planPredicate(plan, table), matches))
    .orderBy(staff.employeeCode)
    .limit(LIMIT)

  return rows.map((row) => ({
    id: row.id,
    schoolId: row.schoolId,
    version: row.version,
    displayName: row.lastName === null ? row.firstName : `${row.firstName} ${row.lastName}`,
    designation: row.designation,
    ...(row.department === null ? {} : { department: row.department }),
  }))
}

export function registerSearchRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/search',
    // Every non-student role holds this somewhere, so the gate admits anyone
    // who may search at all; the two plans below decide the rows themselves.
    permission: 'students.read_basic',
    query: SearchQueryRequest,
    response: SearchResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => ({
        students: await findStudents(conn, context, query.q),
        staff: await findStaff(conn, context, query.q),
      })),
  })
}
