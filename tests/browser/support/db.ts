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

/**
 * Undo an authenticator enrolment, so the next test that needs one starts from
 * nothing exactly as the seed left it. A second enrolment for a person who
 * already has one is refused, so a test that enrols must clear up after itself.
 */
export async function forgetSecondFactor(userId: string): Promise<void> {
  await admin().query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
  await admin().query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = undefined
}
