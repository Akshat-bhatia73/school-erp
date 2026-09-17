import { Pool } from 'pg'
import { assertRuntimeRole, createIdentityPool, createPool } from '@erp/db'
import type { ApiConfig } from './config.ts'

export interface ApiPools {
  /** Better Auth adapter only. It can never read school memberships. */
  readonly auth: Pool
  /** Executes the identity bootstrap functions and nothing else. */
  readonly identity: Pool
  /** Tenant tables, always through withTenantTransaction. */
  readonly runtime: Pool
  close(): Promise<void>
}

export async function createPools(config: ApiConfig): Promise<ApiPools> {
  const auth = new Pool({
    connectionString: config.AUTH_DATABASE_URL,
    application_name: 'school-erp-auth',
  })
  const identity = createIdentityPool({
    connectionString: config.IDENTITY_DATABASE_URL,
  })
  const runtime = createPool({ connectionString: config.DATABASE_URL })
  // A hosted database drops idle connections when it suspends. pg reports
  // that on the pool, and an unhandled 'error' event would end the process;
  // the pool has already discarded the client, so there is nothing to do.
  // Never log the error: its message can carry the connection string.
  for (const pool of [auth, identity, runtime]) pool.on('error', () => {})
  await assertRuntimeRole(runtime)
  return {
    auth,
    identity,
    runtime,
    async close() {
      await Promise.all([auth.end(), identity.end(), runtime.end()])
    },
  }
}
