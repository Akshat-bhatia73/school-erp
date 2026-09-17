import type { TenantConnection } from './audit.ts'
import { ApiFailure } from './errors.ts'

/**
 * Server-assigned admission numbers and employee codes.
 *
 * The office never types either value. A number is claimed inside the same
 * transaction as the record it belongs to, after that write has already taken
 * the school lock, with one statement that both creates the counter on first
 * use and moves it on: two concurrent admissions therefore queue on the same
 * row and take consecutive numbers rather than the same one. The UNIQUE
 * constraints on students and staff remain the last line of defence, and a
 * violation there is a bug in this file rather than a bad request.
 */

/** The counter, padded to three digits and widened rather than truncated. */
export function formatCounter(counter: number): string {
  return String(counter).padStart(3, '0')
}

/** The school prefix as it appears in every number: trimmed, upper case. */
export function schoolPrefix(shortName: string): string {
  return shortName.trim().toUpperCase()
}

export function formatAdmissionNumber(
  shortName: string,
  yearName: string,
  counter: number,
): string {
  return `${schoolPrefix(shortName)}/${yearName.trim()}/${formatCounter(counter)}`
}

export function formatEmployeeCode(shortName: string, counter: number): string {
  return `${schoolPrefix(shortName)}-E${formatCounter(counter)}`
}

/** A literal turned into a regular expression that matches only itself. */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&')
}

/**
 * Moves a counter past numbers that already exist in the school's format.
 *
 * A school keeps its historical register through import, and fixtures seed
 * numbers directly, so a counter that only counted its own allocations would
 * hand out a number that is already taken. The unique constraint would then
 * roll the whole transaction back, counter included, and every retry would
 * repeat it. This runs before an allocation and lifts the counter above every
 * number already in use, so the next one is free.
 */
async function sync(
  conn: TenantConnection,
  schoolId: string,
  kind: 'admission' | 'employee',
  period: string,
  pattern: string,
  table: 'students' | 'staff',
  column: 'admission_number' | 'employee_code',
  extra: readonly string[],
): Promise<void> {
  await conn.client.query(
    `WITH used AS (
       SELECT max((regexp_match(value, $4))[1]::bigint) AS top
       FROM (
         SELECT ${column} AS value FROM ${table} WHERE school_id = $1 AND ${column} ~ $4
         UNION ALL
         SELECT unnest($5::text[]) AS value
       ) AS candidates
       WHERE value ~ $4
     )
     INSERT INTO number_sequences (school_id, kind, period, next_value)
     -- Clamped so a wild number in a sheet cannot overflow the counter.
     SELECT $1, $2, $3, least(coalesce(used.top, 0) + 1, 2000000000)::integer FROM used
     ON CONFLICT (school_id, kind, period)
       DO UPDATE SET
         next_value = greatest(number_sequences.next_value, excluded.next_value),
         updated_at = now()`,
    [schoolId, kind, period, pattern, extra],
  )
}

/**
 * The counter digits a pattern may capture. A kept number with more digits
 * than this is not one the counter could have produced, so it is simply not
 * counted; matching it would overflow the cast and fail every later allocation.
 */
const COUNTER_DIGITS = '0*([0-9]{1,9})$'

/** The pattern that recognises this school's admission numbers for one year. */
function admissionPattern(shortName: string, yearName: string): string {
  return `^${literal(schoolPrefix(shortName))}/${literal(yearName.trim())}/${COUNTER_DIGITS}`
}

/** One counter step. The row is created at 2 because this call takes the 1. */
async function allocate(
  conn: TenantConnection,
  schoolId: string,
  kind: 'admission' | 'employee',
  period: string,
): Promise<number> {
  const result = await conn.client.query<{ allocated: number }>(
    `INSERT INTO number_sequences (school_id, kind, period, next_value)
     VALUES ($1, $2, $3, 2)
     ON CONFLICT (school_id, kind, period)
       DO UPDATE SET next_value = number_sequences.next_value + 1, updated_at = now()
     RETURNING next_value - 1 AS allocated`,
    [schoolId, kind, period],
  )
  const allocated = result.rows[0]?.allocated
  if (allocated === undefined) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return Number(allocated)
}

/** The school's short name, read inside the transaction that numbers a row. */
async function shortNameOf(conn: TenantConnection, schoolId: string): Promise<string> {
  const result = await conn.client.query<{ short_name: string }>(
    `SELECT short_name FROM schools WHERE id = $1`,
    [schoolId],
  )
  const shortName = result.rows[0]?.short_name
  if (!shortName) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return shortName
}

/** The academic year's name, and proof that the year is this school's. */
async function yearNameOf(
  conn: TenantConnection,
  schoolId: string,
  academicYearId: string,
): Promise<string> {
  const result = await conn.client.query<{ name: string }>(
    `SELECT name FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, academicYearId],
  )
  const name = result.rows[0]?.name
  if (!name) throw new ApiFailure('INVALID_REQUEST')
  return name
}

/**
 * The next admission number for this school and academic year. The counter
 * restarts at 1 in every year, so the first admission into a new year is 001.
 */
export async function allocateAdmissionNumber(
  conn: TenantConnection,
  schoolId: string,
  academicYearId: string,
  options: { readonly synced?: boolean } = {},
): Promise<string> {
  const shortName = await shortNameOf(conn, schoolId)
  const yearName = await yearNameOf(conn, schoolId, academicYearId)
  if (!options.synced) {
    await syncAdmissionSequence(conn, schoolId, academicYearId)
  }
  const counter = await allocate(conn, schoolId, 'admission', academicYearId)
  return formatAdmissionNumber(shortName, yearName, counter)
}

/**
 * Lifts the admission counter above every number this school already uses in
 * this year, including numbers a sheet is about to keep but has not written
 * yet. An import calls this once and then allocates with `synced`, so a long
 * sheet does not repeat the scan for every row.
 */
export async function syncAdmissionSequence(
  conn: TenantConnection,
  schoolId: string,
  academicYearId: string,
  pending: readonly string[] = [],
): Promise<void> {
  const shortName = await shortNameOf(conn, schoolId)
  const yearName = await yearNameOf(conn, schoolId, academicYearId)
  await sync(
    conn,
    schoolId,
    'admission',
    academicYearId,
    admissionPattern(shortName, yearName),
    'students',
    'admission_number',
    pending,
  )
}

/** The next employee code for this school. One counter, never restarted. */
export async function allocateEmployeeCode(
  conn: TenantConnection,
  schoolId: string,
): Promise<string> {
  const shortName = await shortNameOf(conn, schoolId)
  await sync(
    conn,
    schoolId,
    'employee',
    '',
    `^${literal(schoolPrefix(shortName))}-E${COUNTER_DIGITS}`,
    'staff',
    'employee_code',
    [],
  )
  const counter = await allocate(conn, schoolId, 'employee', '')
  return formatEmployeeCode(shortName, counter)
}
