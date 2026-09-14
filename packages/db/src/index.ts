import { Pool, type PoolClient, type PoolConfig } from 'pg'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { RequestContext } from '@erp/contracts/server'

export {
  activeMembershipsForUser,
  createIdentityPool,
  userHasStudentMembership,
} from './identity.ts'

export class DatabaseConfigurationError extends Error {}
export class TransactionAbortedError extends Error {}

/** Create a pool. Callers must only access it through the callback helpers. */
export function createPool(config: PoolConfig): Pool {
  return new Pool({
    ...config,
    application_name: config.application_name ?? 'school-erp-runtime',
  })
}

/**
 * A request-scoped tenant transaction. SET LOCAL is automatically cleared on
 * commit or rollback, preventing a pooled connection from retaining a school.
 */
export async function withTenantTransaction<T>(
  pool: Pool,
  context: RequestContext,
  work: (connection: { client: PoolClient; db: NodePgDatabase }) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  let released = false
  try {
    await assertRuntimeClient(client)
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.school_id', $1, true)", [
      context.schoolId,
    ])
    await client.query("SELECT set_config('app.request_id', $1, true)", [
      context.requestId,
    ])
    const result = await work({ client, db: drizzle(client) })
    const completion = await client.query('COMMIT')
    if (completion.command !== 'COMMIT') {
      throw new TransactionAbortedError(
        'The transaction was rolled back after a database error.',
      )
    }
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      const failure =
        rollbackError instanceof Error
          ? rollbackError
          : new Error('rollback failed')
      client.release(failure)
      released = true
    })
    throw error
  } finally {
    if (!released) client.release()
  }
}

/** Fail startup when the connection is a schema owner, superuser or RLS bypass role. */
export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await assertRuntimeClient(client)
  } finally {
    client.release()
  }
}

async function assertRuntimeClient(client: PoolClient): Promise<void> {
  const result = await client.query<{
    role_name: string
    session_role_name: string
    rolsuper: boolean
    rolbypassrls: boolean
    rolreplication: boolean
    rolcreatedb: boolean
    rolcreaterole: boolean
    owns: boolean
    has_memberships: boolean
  }>(`
    SELECT r.rolname AS role_name, session_role.rolname AS session_role_name,
      r.rolsuper, r.rolbypassrls, r.rolreplication, r.rolcreatedb, r.rolcreaterole,
      EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid AND c.relnamespace = 'public'::regnamespace) AS owns,
      EXISTS (SELECT 1 FROM pg_auth_members am WHERE am.member = r.oid) AS has_memberships
    FROM pg_roles r
    JOIN pg_roles session_role ON session_role.rolname = session_user
    WHERE r.rolname = current_user`)
  const role = result.rows[0]
  if (
    !role ||
    role.role_name !== 'erp_runtime' ||
    role.session_role_name !== 'erp_runtime' ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolreplication ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.owns ||
    role.has_memberships
  ) {
    throw new DatabaseConfigurationError(
      'Database runtime connection must use the non-owner erp_runtime role without RLS bypass.',
    )
  }
}
