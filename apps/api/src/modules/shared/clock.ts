import type { TenantConnection } from '../../memberships/audit.ts'
import { ApiFailure } from '../../http/errors.ts'

/**
 * Today as YYYY-MM-DD in the school's own timezone, by the database clock.
 * "Today" for a fee falling due or an attendance register is the school's
 * day, never the server's or the browser's.
 */
export async function schoolToday(
  conn: Pick<TenantConnection, 'client'>,
  schoolId: string,
): Promise<string> {
  const result = await conn.client.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata'))::date, 'YYYY-MM-DD') AS today
       FROM schools WHERE id = $1`,
    [schoolId],
  )
  const today = result.rows[0]?.today
  if (!today) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return today
}
