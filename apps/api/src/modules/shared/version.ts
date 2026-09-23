import type { TenantConnection } from '../../memberships/audit.ts'
import { ApiFailure } from '../../http/errors.ts'

/**
 * The tables a module may bump a version on. The name is never a free string,
 * so nothing a caller supplies can reach the query text.
 */
export type VersionedTable =
  | 'schools'
  | 'academic_years'
  | 'grades'
  | 'sections'
  | 'subjects'
  | 'holidays'
  | 'students'
  | 'guardians'
  | 'staff'
  | 'bell_schedules'
  | 'student_import_previews'
  | 'fee_heads'
  | 'fee_structures'
  | 'fee_student_heads'
  | 'fee_concessions'
  | 'exams'
  | 'report_card_entries'
  | 'exam_settings'

/** The caller edited a record someone else has already changed. */
export function assertVersion(expected: number, actual: number): void {
  if (expected !== actual) throw new ApiFailure('VERSION_CONFLICT')
}

/** Columns a module may set through bumpVersion. Never a request key. */
const COLUMN_NAME = /^[a-z][a-z0-9_]{0,62}$/
const PROTECTED_COLUMNS = new Set(['id', 'school_id', 'version', 'updated_at', 'created_at'])

/**
 * The optimistic write every module update uses: the version in the WHERE
 * clause is the whole concurrency check, so two editors cannot both win. Zero
 * rows updated means either the record is gone or somebody got in first, and
 * the two are told apart by a second read rather than guessed at.
 *
 * Column names come from module code and are checked against a strict shape;
 * every value is a bound parameter. Nothing from a request body can reach the
 * statement text, because the caller maps request fields to columns itself.
 */
export async function bumpVersion(
  conn: TenantConnection,
  table: VersionedTable,
  input: {
    readonly schoolId: string
    readonly id: string
    readonly expectedVersion: number
    /** Column name to new value. JSON columns take an already stringified value. */
    readonly set?: Readonly<Record<string, unknown>>
  },
): Promise<number> {
  const entries = Object.entries(input.set ?? {})
  const assignments: string[] = []
  const values: unknown[] = [input.schoolId, input.id, input.expectedVersion]
  for (const [column, value] of entries) {
    if (!COLUMN_NAME.test(column) || PROTECTED_COLUMNS.has(column)) {
      throw new Error(`bumpVersion refuses column ${JSON.stringify(column)}`)
    }
    values.push(value)
    assignments.push(`${column} = $${values.length}`)
  }
  const extra = assignments.length > 0 ? `${assignments.join(', ')}, ` : ''
  // The schools table is the tenant itself, so it has no school_id column: its
  // own id is the school. Both parameters must then name the same row, which
  // keeps a caller from bumping any school but the one it is working in.
  const owner = table === 'schools' ? 'id = $1' : 'school_id = $1'
  const result = await conn.client.query<{ version: number }>(
    `UPDATE ${table}
        SET ${extra}version = version + 1, updated_at = now()
      WHERE ${owner} AND id = $2 AND version = $3
      RETURNING version`,
    values,
  )
  const row = result.rows[0]
  if (!row) {
    const exists = await conn.client.query<{ version: number }>(
      `SELECT version FROM ${table} WHERE ${owner} AND id = $2`,
      [input.schoolId, input.id],
    )
    if (exists.rows.length === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
    throw new ApiFailure('VERSION_CONFLICT')
  }
  return Number(row.version)
}
