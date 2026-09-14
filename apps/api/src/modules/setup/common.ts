import { sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'
import { scopedTableFor, type ScopedTable } from '@erp/authz'
import type { ResourceType } from '@erp/contracts'
import type { TenantConnection } from '../shared/audit.ts'
import { ApiFailure } from '../shared/errors.ts'

/**
 * Every setup record is addressed by a uuid. A malformed id would make
 * Postgres raise a type error, which the boundary would answer as 503, so the
 * shape is checked first and an unusable id is simply a record that is not
 * there.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function requireUuid(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return value
}

/**
 * The same shape check for a value that arrived as a list filter. A malformed
 * filter is bad input, not a collection that does not exist, so it is answered
 * as such.
 */
export function requireQueryUuid(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('INVALID_REQUEST')
  return value
}

/**
 * A reference a request body supplies. It must name a row of this school, and
 * a body that names someone else's row is a bad request rather than a database
 * error: the caller is told the details are wrong, never whether the row
 * exists somewhere else.
 */
export async function requireReference(
  conn: TenantConnection,
  table: 'academic_years' | 'grades' | 'subjects' | 'staff',
  schoolId: string,
  id: string,
): Promise<void> {
  if (!UUID.test(id)) throw new ApiFailure('INVALID_REQUEST')
  const found = await conn.client.query(
    `SELECT 1 FROM ${table} WHERE school_id = $1 AND id = $2`,
    [schoolId, id],
  )
  if (found.rowCount === 0) throw new ApiFailure('INVALID_REQUEST')
}

/**
 * Rows in other tables that would be orphaned by a delete. Refusing here keeps
 * the answer a plain bad request instead of letting a foreign key violation
 * become an unexplained service error.
 */
export async function refuseWhenReferenced(
  conn: TenantConnection,
  schoolId: string,
  references: readonly { readonly table: string; readonly column: string }[],
  id: string,
): Promise<void> {
  for (const reference of references) {
    const used = await conn.client.query(
      `SELECT 1 FROM ${reference.table} WHERE school_id = $1 AND ${reference.column} = $2 LIMIT 1`,
      [schoolId, id],
    )
    if (used.rowCount !== null && used.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')
  }
}

/**
 * Two tables this module edits (schools and holidays) carry no version column,
 * and access_version belongs to the access locking protocol so it must not
 * double as an edit counter. The moment of the last edit, in whole
 * microseconds, stands in for one: it rises on every save, it is the same
 * number on the read and on the write, and a second editor who saved first
 * moves it, so the loser is told VERSION_CONFLICT instead of quietly winning.
 */
export function touchVersion(column: PgColumn): SQL<string> {
  return sql<string>`(floor(extract(epoch from ${column}) * 1000000))::bigint::text`
}

/** The same expression in raw SQL, for statements drizzle does not build. */
export const TOUCH_VERSION_SQL = "(floor(extract(epoch from updated_at) * 1000000))::bigint::text"

/** A date column as the calendar date the contracts use, never a timestamp. */
export function isoDate(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column}, 'YYYY-MM-DD')`
}

/** Contract optionals are omitted, never null, so build them one at a time. */
export function optional<T>(key: string, value: T | null | undefined): Record<string, T> {
  return value === null || value === undefined ? {} : { [key]: value }
}

/** The table a read plan of this resource type filters. */
export function scopedTable(resourceType: ResourceType): ScopedTable {
  const table = scopedTableFor(resourceType)
  // Every resource type this module reads has one; a missing entry is a bug
  // here, not something a caller can provoke.
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return table
}
