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

export async function activeMembershipsForUser(pool: Pool, userId: string) {
  const result = await pool.query(
    `SELECT membership_id, school_id, version, access_version
       FROM active_adult_memberships_for_user($1)`,
    [userId],
  )
  return result.rows
}
