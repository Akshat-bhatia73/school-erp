import { Pool, type PoolConfig } from 'pg'

/**
 * Bootstrap-only connection for resolving a signed-in identity to memberships
 * before a tenant transaction exists. It deliberately exposes no domain table.
 */
export function createIdentityPool(config: PoolConfig): Pool {
  return new Pool({
    ...config,
    application_name: config.application_name ?? 'school-erp-identity',
  })
}

export interface ActiveMembershipRow {
  membership_id: string
  school_id: string
  kind: 'adult' | 'student'
  version: number
  access_version: number
}

/** Every active membership of one identity in an open school, adult or student. */
export async function activeMembershipsForUser(
  pool: Pool,
  userId: string,
): Promise<ActiveMembershipRow[]> {
  const result = await pool.query<ActiveMembershipRow>(
    `SELECT membership_id, school_id, kind, version, access_version
       FROM active_memberships_for_user($1)`,
    [userId],
  )
  return result.rows
}

/**
 * 'none' when the identity was never a pupil, 'active' when its student
 * login is on, 'inactive' when it was switched off or ended. An inactive
 * student identity never holds a session.
 */
export async function studentLoginState(
  pool: Pool,
  userId: string,
): Promise<'none' | 'active' | 'inactive'> {
  const result = await pool.query<{ state: 'none' | 'active' | 'inactive' }>(
    'SELECT student_login_state($1) AS state',
    [userId],
  )
  return result.rows[0]?.state ?? 'none'
}

/**
 * The identity behind a school login code and an admission number, or null.
 * Only a pupil on the roll whose login is on is ever found.
 */
export async function studentSignInUser(
  pool: Pool,
  schoolCode: string,
  admissionNumber: string,
): Promise<string | null> {
  const result = await pool.query<{ user_id: string | null }>(
    'SELECT student_sign_in_user($1, $2) AS user_id',
    [schoolCode, admissionNumber],
  )
  return result.rows[0]?.user_id ?? null
}

/** True when the identity has any student membership, whatever its state. */
export async function userHasStudentMembership(
  pool: Pool,
  userId: string,
): Promise<boolean> {
  const result = await pool.query<{ has: boolean }>(
    'SELECT user_has_student_membership($1) AS has',
    [userId],
  )
  return result.rows[0]?.has === true
}
