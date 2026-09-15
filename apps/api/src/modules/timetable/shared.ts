import type { PoolClient } from 'pg'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql, type SQL } from 'drizzle-orm'
import {
  ACTIVE_PERMISSION_KEYS,
  PERMISSION_CATALOGUE,
  type ErrorCode,
  type PermissionKey,
  type ResourceType,
} from '@erp/contracts'
import {
  evaluate,
  loadMembershipStateById,
  loadPolicySnapshotFor,
  loadRelationshipFactsFor,
} from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { decideAction } from '../../memberships/authorize.ts'

/** The connection withTenantTransaction hands a module handler. */
export interface ModuleConnection {
  readonly client: PoolClient
  readonly db: NodePgDatabase
}

/** Runs one statement and returns its rows, typed by the caller's select list. */
export async function queryRows<T>(conn: ModuleConnection, statement: SQL): Promise<T[]> {
  const result = await conn.db.execute(statement)
  return (result as unknown as { rows: T[] }).rows
}

export interface CellRow {
  readonly dayOfWeek: number
  readonly periodIndex: number
  readonly roomNumber: string | null
  readonly sectionId: string
  readonly sectionName: string
  readonly gradeName: string
  readonly subjectId: string
  readonly subjectName: string
  readonly staffId: string | null
  readonly staffFirstName: string | null
  readonly staffLastName: string | null
}

export interface TimetableCellDto {
  readonly section: { id: string; name: string }
  readonly subject: { id: string; name: string }
  readonly teacher: { id: string; name: string } | null
  readonly dayOfWeek: number
  readonly periodIndex: number
  readonly roomNumber?: string
}

/** A person's display name, built from the two stored parts. */
export function personName(first: string | null, last: string | null): string {
  return [first ?? '', last ?? ''].join(' ').trim()
}

/** A class is named for a human: "Six A", never a bare section letter. */
export function sectionName(gradeName: string, name: string): string {
  return `${gradeName} ${name}`.trim()
}

/** The select list every timetable cell read shares, so all of them project alike. */
export const CELL_COLUMNS = sql`timetable_entries.day_of_week::int AS "dayOfWeek",
    timetable_entries.period_index::int AS "periodIndex",
    timetable_entries.room_number AS "roomNumber",
    sections.id::text AS "sectionId", sections.name AS "sectionName", grades.name AS "gradeName",
    subjects.id::text AS "subjectId", subjects.name AS "subjectName",
    staff.id::text AS "staffId", staff.first_name AS "staffFirstName", staff.last_name AS "staffLastName"`

/** The joins those columns need. The entry table stays unaliased for the plan predicate. */
export const CELL_JOINS = sql`FROM timetable_entries
    JOIN sections ON sections.school_id = timetable_entries.school_id AND sections.id = timetable_entries.section_id
    JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
    JOIN subjects ON subjects.school_id = timetable_entries.school_id AND subjects.id = timetable_entries.subject_id
    LEFT JOIN staff ON staff.school_id = timetable_entries.school_id AND staff.id = timetable_entries.staff_id`

export function toCell(row: CellRow): TimetableCellDto {
  const teacherName = personName(row.staffFirstName, row.staffLastName)
  return {
    section: { id: row.sectionId, name: sectionName(row.gradeName, row.sectionName) },
    subject: { id: row.subjectId, name: row.subjectName },
    // A cell with no teacher is a real state, so the contract keeps it nullable.
    teacher: row.staffId === null || teacherName === '' ? null : { id: row.staffId, name: teacherName },
    dayOfWeek: Number(row.dayOfWeek),
    periodIndex: Number(row.periodIndex),
    // Optional means absent, never null: the contract rejects an explicit null.
    ...(row.roomNumber === null ? {} : { roomNumber: row.roomNumber }),
  }
}

/** Every active permission of one resource type, so a list cannot drift from the catalogue. */
export function permissionsOfType(resourceType: ResourceType): readonly PermissionKey[] {
  return ACTIVE_PERMISSION_KEYS.filter(
    (permission) => PERMISSION_CATALOGUE[permission].resourceType === resourceType,
  )
}

/**
 * The actions a caller may take on this kind of record anywhere in the school.
 * A timetable grid is not one row, so the decision is the aggregate one rather
 * than a per-record check. The membership state, the policy snapshot and the
 * relationship facts are loaded once and reused for every candidate, because
 * the answers all come from the same snapshot anyway.
 */
export async function aggregateAllowedActions(
  conn: ModuleConnection,
  context: RequestContext,
  resourceType: ResourceType,
): Promise<PermissionKey[]> {
  const state = await loadMembershipStateById(conn, context.schoolId, context.membershipId)
  if (!state || state.status !== 'active') return []
  const snapshot = await loadPolicySnapshotFor(conn, context.schoolId, context.membershipId)
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  const resource = { schoolId: context.schoolId, resourceType, id: context.schoolId }
  const resourceFacts = { resourceType, id: context.schoolId, aggregate: true as const }
  return permissionsOfType(resourceType).filter(
    (permission) => evaluate({ context, permission, resource, snapshot, facts, resourceFacts }).allowed,
  )
}

/**
 * A read the coverage table grants to more than one permission. The route's own
 * gate has already decided the first one; this accepts any of them, so a member
 * who holds only the second is not refused by the handler.
 */
export async function authorizeEitherSchoolAction(
  conn: ModuleConnection,
  context: RequestContext,
  permissions: readonly PermissionKey[],
): Promise<void> {
  let refusal: ErrorCode = 'ACCESS_DENIED'
  for (const permission of permissions) {
    const decision = await decideAction(conn, context, permission, context.schoolId, true)
    if (decision.allowed) return
    refusal = decision.code
  }
  throw new ApiFailure(refusal)
}

/** A record named in a body must exist in this school, or the request is bad input. */
async function assertExists(
  conn: ModuleConnection,
  statement: SQL,
): Promise<void> {
  const rows = await queryRows<{ ok: number }>(conn, statement)
  if (rows.length === 0) throw new ApiFailure('INVALID_REQUEST')
}

export async function assertYear(conn: ModuleConnection, schoolId: string, yearId: string): Promise<void> {
  await assertExists(
    conn,
    sql`SELECT 1 AS ok FROM academic_years WHERE school_id = ${schoolId}::uuid AND id = ${yearId}::uuid`,
  )
}

/** A section must exist in this school and belong to the year the caller named. */
export async function assertSectionInYear(
  conn: ModuleConnection,
  schoolId: string,
  sectionId: string,
  yearId: string,
): Promise<void> {
  await assertExists(
    conn,
    sql`SELECT 1 AS ok FROM sections WHERE school_id = ${schoolId}::uuid
          AND id = ${sectionId}::uuid AND academic_year_id = ${yearId}::uuid`,
  )
}

export async function assertSubject(conn: ModuleConnection, schoolId: string, subjectId: string): Promise<void> {
  await assertExists(
    conn,
    sql`SELECT 1 AS ok FROM subjects WHERE school_id = ${schoolId}::uuid AND id = ${subjectId}::uuid`,
  )
}

export async function assertStaff(conn: ModuleConnection, schoolId: string, staffId: string): Promise<void> {
  await assertExists(
    conn,
    sql`SELECT 1 AS ok FROM staff WHERE school_id = ${schoolId}::uuid AND id = ${staffId}::uuid`,
  )
}

/** An identifier that is not a UUID can never match a row, and must not reach Postgres. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A path identifier of the wrong shape is simply a record that is not there. */
export function requireUuidParam(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return value
}

/** The same shape check for a body value, where a bad identifier is bad input. */
export function requireUuidValue(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('INVALID_REQUEST')
  return value
}

/** The academic year a calendar date falls in, or bad input when none does. */
export async function yearForDate(
  conn: ModuleConnection,
  schoolId: string,
  date: string,
): Promise<string> {
  const rows = await queryRows<{ id: string }>(
    conn,
    sql`SELECT id::text AS id FROM academic_years
         WHERE school_id = ${schoolId}::uuid AND start_date <= ${date}::date AND end_date >= ${date}::date
         ORDER BY start_date DESC LIMIT 1`,
  )
  const row = rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  return row.id
}
