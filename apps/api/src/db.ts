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
