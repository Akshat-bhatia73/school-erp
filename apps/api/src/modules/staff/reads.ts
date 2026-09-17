import { and, asc, eq, isNotNull, sql, type SQL } from 'drizzle-orm'
import { planPredicate, scopedTableFor, type AuthzConnection, type ScopedTable } from '@erp/authz'
import type { PermissionKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { academicYears, grades, sections, staff, subjects, teachingAssignments } from '@erp/db/schema'
import { z } from 'zod'
import { TeachingAssignmentList } from '@erp/contracts'
import { ApiFailure } from '../../http/errors.ts'
import { allowedActionsFor, decideResource, readPlan } from '../shared/authorize.ts'
import {
  toDetail,
  toDirectory,
  type StaffDetailDto,
  type StaffDirectoryDto,
  type StaffRow,
} from './projection.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every identifier in a path is a database uuid. A value of another shape can
 * match no record, so it is answered like a missing one instead of reaching
 * Postgres and turning a bad request into a failed query.
 */
export function recordId(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return value
}

/**
 * A record level check whose denial never distinguishes "you may not" from
 * "there is no such row". The detail read already answers 404 for a record
 * outside the caller's scope, so a write on the same record must not be the
 * one place that confirms it exists.
 */
export async function requireRecord(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
  resourceType: 'staff' | 'section',
  id: string,
): Promise<void> {
  const decision = await decideResource(conn, context, permission, resourceType, id)
  if (!decision.allowed) throw new ApiFailure('RESOURCE_NOT_FOUND')
}

/** The staff table, described for the predicate builder. */
export function staffTable(): ScopedTable {
  const table = scopedTableFor('staff')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return table
}

/**
 * The one predicate every staff read starts from. Nothing is filtered in
 * JavaScript afterwards, so a list holds a row exactly when the detail read of
 * that row would answer it.
 */
export async function staffScope(
  conn: AuthzConnection,
  context: RequestContext,
  permission: PermissionKey,
): Promise<SQL> {
  return planPredicate(await readPlan(conn, context, permission, 'staff'), staffTable())
}

/** Search covers directory fields only: never pay, phone, address or identity. */
function searchTerm(search: string | undefined): SQL | undefined {
  if (!search) return undefined
  const pattern = `%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
  return sql`(${staff.firstName} ILIKE ${pattern} ESCAPE '\\'
    OR coalesce(${staff.lastName}, '') ILIKE ${pattern} ESCAPE '\\'
    OR ${staff.employeeCode} ILIKE ${pattern} ESCAPE '\\'
    OR ${staff.designation} ILIKE ${pattern} ESCAPE '\\'
    OR coalesce(${staff.department}, '') ILIKE ${pattern} ESCAPE '\\')`
}

export interface StaffListQuery {
  readonly page: number
  readonly pageSize: number
  readonly search?: string
  readonly sort: 'name' | 'employee_code'
}

export async function listStaff(
  conn: AuthzConnection,
  context: RequestContext,
  query: StaffListQuery,
): Promise<{ items: StaffDirectoryDto[]; total: number; page: number; pageSize: number }> {
  const where = and(await staffScope(conn, context, 'staff.read_directory'), searchTerm(query.search))
  const order =
    query.sort === 'employee_code'
      ? [asc(staff.employeeCode), asc(staff.id)]
      : [asc(staff.firstName), asc(staff.lastName), asc(staff.id)]
  const rows = await conn.db
    .select()
    .from(staff)
    .where(where)
    .orderBy(...order)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize)
  const counted = await conn.db
    .select({ total: sql<number>`count(*)::int` })
    .from(staff)
    .where(where)
  return {
    items: rows.map((row) => toDirectory(row as StaffRow)),
    total: counted[0]?.total ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  }
}

export async function countStaff(conn: AuthzConnection, context: RequestContext): Promise<number> {
  const counted = await conn.db
    .select({ total: sql<number>`count(*)::int` })
    .from(staff)
    .where(await staffScope(conn, context, 'staff.read_directory'))
  return counted[0]?.total ?? 0
}

/** A short type-ahead list, over the same authorized rows as the directory. */
export async function searchStaff(
  conn: AuthzConnection,
  context: RequestContext,
  term: string,
): Promise<StaffDirectoryDto[]> {
  const rows = await conn.db
    .select()
    .from(staff)
    .where(and(await staffScope(conn, context, 'staff.read_directory'), searchTerm(term)))
    .orderBy(asc(staff.firstName), asc(staff.lastName), asc(staff.id))
    .limit(20)
  return rows.map((row) => toDirectory(row as StaffRow))
}

/** The departments of the rows this caller may read, and no others. */
export async function listDepartments(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<string[]> {
  const rows = await conn.db
    .selectDistinct({ department: staff.department })
    .from(staff)
    .where(and(await staffScope(conn, context, 'staff.read_directory'), isNotNull(staff.department)))
    .orderBy(asc(staff.department))
    .limit(100)
  return rows.flatMap((row) => (row.department ? [row.department] : []))
}

/** One staff row, through the directory predicate. Absent means not found. */
export async function loadStaffRow(
  conn: AuthzConnection,
  context: RequestContext,
  staffId: string,
): Promise<StaffRow> {
  const where = and(await staffScope(conn, context, 'staff.read_directory'), eq(staff.id, staffId))
  const rows = await conn.db.select().from(staff).where(where).limit(1)
  const row = rows[0] as StaffRow | undefined
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

/**
 * The detail response for one row. Each block is a separate decision on the
 * same record, so a teacher reading their own record sees employment and
 * private data while pay stays out of the response entirely.
 */
export async function staffDetail(
  conn: AuthzConnection,
  context: RequestContext,
  row: StaffRow,
): Promise<StaffDetailDto> {
  // One decision at a time: they share the caller's single connection, which
  // runs one statement at a time.
  const employment = await decideResource(conn, context, 'staff.read_employment', 'staff', row.id)
  const privateBlock = await decideResource(conn, context, 'staff.read_private', 'staff', row.id)
  const pay = await decideResource(conn, context, 'staff.read_pay', 'staff', row.id)
  const allowedActions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'staff',
    id: row.id,
  })
  return toDetail(row, {
    employment: employment.allowed,
    private: privateBlock.allowed,
    pay: pay.allowed,
    allowedActions,
  })
}

type TeachingAssignmentDto = z.infer<typeof TeachingAssignmentList>[number]

/**
 * Assignments with the labels a screen needs. The section label carries its
 * grade, because "A" alone means nothing; the teacher label is a name only.
 */
async function assignmentsWhere(
  conn: AuthzConnection,
  where: SQL,
): Promise<TeachingAssignmentDto[]> {
  const rows = await conn.db
    .select({
      id: teachingAssignments.id,
      academicYearId: teachingAssignments.academicYearId,
      sectionId: sections.id,
      sectionName: sections.name,
      gradeName: grades.name,
      subjectId: subjects.id,
      subjectName: subjects.name,
      staffId: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
      effectiveFrom: teachingAssignments.effectiveFrom,
      effectiveTo: teachingAssignments.effectiveTo,
    })
    .from(teachingAssignments)
    .innerJoin(
      sections,
      and(eq(sections.schoolId, teachingAssignments.schoolId), eq(sections.id, teachingAssignments.sectionId)),
    )
    .innerJoin(grades, and(eq(grades.schoolId, sections.schoolId), eq(grades.id, sections.gradeId)))
    .innerJoin(
      subjects,
      and(eq(subjects.schoolId, teachingAssignments.schoolId), eq(subjects.id, teachingAssignments.subjectId)),
    )
    .innerJoin(
      staff,
      and(eq(staff.schoolId, teachingAssignments.schoolId), eq(staff.id, teachingAssignments.staffId)),
    )
    .where(where)
    .orderBy(asc(teachingAssignments.effectiveFrom), asc(teachingAssignments.id))
    .limit(200)
  return rows.map((row) => ({
    id: row.id,
    academicYearId: row.academicYearId,
    section: { id: row.sectionId, name: `${row.gradeName} ${row.sectionName}`.trim() },
    subject: { id: row.subjectId, name: row.subjectName },
    teacher: { id: row.staffId, name: `${row.firstName} ${row.lastName ?? ''}`.trim() },
    validFrom: row.effectiveFrom,
    validUntil: row.effectiveTo,
  }))
}

export async function assignmentsForStaff(
  conn: AuthzConnection,
  schoolId: string,
  staffId: string,
): Promise<TeachingAssignmentDto[]> {
  const where = and(
    eq(teachingAssignments.schoolId, schoolId),
    eq(teachingAssignments.staffId, staffId),
  )
  if (!where) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return assignmentsWhere(conn, where)
}

export async function assignmentsForSection(
  conn: AuthzConnection,
  schoolId: string,
  sectionId: string,
): Promise<TeachingAssignmentDto[]> {
  const where = and(
    eq(teachingAssignments.schoolId, schoolId),
    eq(teachingAssignments.sectionId, sectionId),
  )
  if (!where) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return assignmentsWhere(conn, where)
}

/** The academic year a section belongs to, or nothing when it is not ours. */
export async function sectionYear(
  conn: AuthzConnection,
  schoolId: string,
  sectionId: string,
): Promise<string | null> {
  const rows = await conn.db
    .select({ academicYearId: sections.academicYearId })
    .from(sections)
    .innerJoin(
      academicYears,
      and(eq(academicYears.schoolId, sections.schoolId), eq(academicYears.id, sections.academicYearId)),
    )
    .where(and(eq(sections.schoolId, schoolId), eq(sections.id, sectionId)))
    .limit(1)
  return rows[0]?.academicYearId ?? null
}
