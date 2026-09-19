import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { RETENTION } from '@erp/contracts'
import type { ApiConfig } from '../config.ts'
import type { ApiPools } from '../db.ts'
import { ApiFailure } from '../http/errors.ts'

export interface MaintenanceDependencies {
  readonly config: ApiConfig
  readonly pools: ApiPools
}

interface SweepRow {
  item: string
  count: number
}

/**
 * Compare two secrets without leaking their contents through timing. Lengths
 * are compared through their digests so unequal lengths stay constant time.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Two functions both report an item called "sessions", so each group is
 * namespaced before the counts are merged into one object.
 */
async function sweep(
  pool: Pool,
  group: string,
  sql: string,
  params: unknown[] = [],
): Promise<Array<[string, number]>> {
  const result = await pool.query<SweepRow>(sql, params)
  return result.rows.map((row) => [`${group}.${row.item}`, Number(row.count)])
}

/**
 * The daily sweep of transient copies (Task 12). Registered only when
 * CRON_SECRET is configured, so a deployment without the cron has no route at
 * all. No session, no school and no audit row: the work is cross-school and
 * lives in SECURITY DEFINER functions, which is why the runtime pool is used
 * directly instead of through withTenantTransaction.
 */
export function registerMaintenanceRoutes(
  app: FastifyInstance,
  deps: MaintenanceDependencies,
): void {
  const secret = deps.config.CRON_SECRET
  if (secret === undefined) return

  app.get('/api/maintenance/sweep', async (request) => {
    const header = request.headers.authorization
    if (!header || !secretsMatch(header, `Bearer ${secret}`))
      throw new ApiFailure('AUTHENTICATION_REQUIRED')

    const entries = [
      ...(await sweep(
        deps.pools.runtime,
        'tenant',
        'SELECT * FROM sweep_tenant_transients()',
      )),
      // The access log is global infrastructure, but its sweep function is
      // granted to the runtime login only, so it runs on that pool. Its single
      // item name collides with nothing, so it is not namespaced.
      ...(
        await deps.pools.runtime.query<SweepRow>('SELECT * FROM sweep_access_log()')
      ).rows.map((row): [string, number] => [row.item, Number(row.count)]),
      ...(await sweep(
        deps.pools.auth,
        'auth',
        'SELECT * FROM sweep_auth_transients()',
      )),
      ...(await sweep(
        deps.pools.auth,
        'credentials',
        'SELECT * FROM sweep_orphaned_credentials($1::interval)',
        [`${RETENTION.credentialGraceDays} days`],
      )),
    ]
    const swept = Object.fromEntries(entries)
    request.log.info({ swept }, 'maintenance sweep complete')
    return { swept }
  })
}
