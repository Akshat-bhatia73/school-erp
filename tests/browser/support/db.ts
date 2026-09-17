/**
 * Direct database access, for the two things no HTTP route offers a test:
 * clearing the real sign-in rate limits (this suite signs in far more often
 * than a person would) and reading a membership's committed status.
 *
 * It never decides anything and never stands in for the API.
 */
import pg from 'pg'
import { MIGRATOR_URL } from '../env.ts'

let pool: pg.Pool | undefined

function admin(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: MIGRATOR_URL })
  return pool
}

export async function resetRateLimits(): Promise<void> {
  await admin().query('DELETE FROM auth_rate_limit')
  await admin().query('DELETE FROM auth_throttle')
}

export async function membershipStatus(membershipId: string): Promise<string> {
  const result = await admin().query<{ status: string }>(
    'SELECT status FROM school_memberships WHERE id = $1',
    [membershipId],
  )
  return result.rows[0]?.status ?? 'missing'
}

/** Put a membership back the way the seed left it, after a lifecycle test. */
export async function restoreMembership(membershipId: string): Promise<void> {
  await admin().query(
    `UPDATE school_memberships
        SET status = 'active', access_version = access_version + 1, version = version + 1
      WHERE id = $1`,
    [membershipId],
  )
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = undefined
}
