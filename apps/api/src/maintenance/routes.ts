import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { loadMembershipStateById, loadRoleKeys } from '@erp/authz'
import { RETENTION } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import type { ApiConfig } from '../config.ts'
import type { ApiPools } from '../db.ts'
import { ApiFailure } from '../http/errors.ts'
import { createRequestContext } from '../auth/request-context.ts'
import type { DocumentStorage } from '../files/storage.ts'
import { produceJob } from '../exports/run.ts'

export interface MaintenanceDependencies {
  readonly config: ApiConfig
  readonly pools: ApiPools
  /** Expired export files have to leave the object store, not just the table. */
  readonly documents: DocumentStorage
}

interface SweepRow {
  item: string
  count: number
}

/** How many queued exports one sweep will build, so a run stays bounded. */
const EXPORT_JOBS_PER_SWEEP = 20

interface QueuedJobRow {
  school_id: string
  id: string
  requested_by_membership_id: string
  requested_by_user_id: string
}

/** How many pages of expired files one sweep will clear, so a run stays bounded. */
const EXPORT_FILE_ROUNDS = 20

/** The page size list_expired_export_files() hands back. */
const EXPORT_FILE_PAGE = 1000

interface ExpiredFileRow {
  school_id: string
  id: string
  storage_key: string
}

/**
 * Delete the bytes behind every export whose row the tenant sweep is about to
 * remove. This runs first: a deleted row leaves nothing pointing at the file,
 * so the file would stay in the store forever. A key that cannot be removed is
 * left for the next run rather than failing the whole sweep.
 *
 * The listing function hands back one page at a time while the tenant sweep
 * deletes every aged row in one go, so this works through the pages until a
 * short one comes back. The number of pages is bounded, and whatever is still
 * waiting when the bound is reached is counted rather than passed over in
 * silence.
 */
async function removeExpiredExportFiles(
  deps: MaintenanceDependencies,
): Promise<{ removed: number; left: number }> {
  return removeExpiredFiles(
    deps,
    'SELECT * FROM list_expired_export_files()',
    'SELECT forget_export_file($1::uuid, $2::uuid)',
  )
}

/**
 * The same for the files attached to messages the message sweep is about to
 * remove (two years after they went out). Its listing pages at the same size.
 */
async function removeExpiredMessageFiles(
  deps: MaintenanceDependencies,
): Promise<{ removed: number; left: number }> {
  return removeExpiredFiles(
    deps,
    'SELECT * FROM list_expired_message_attachments()',
    'SELECT forget_message_attachment($1::uuid, $2::uuid)',
  )
}

async function removeExpiredFiles(
  deps: MaintenanceDependencies,
  listSql: string,
  forgetSql: string,
): Promise<{ removed: number; left: number }> {
  let removed = 0
  for (let round = 0; round < EXPORT_FILE_ROUNDS; round += 1) {
    const found = await deps.pools.runtime.query<ExpiredFileRow>(listSql)
    for (const row of found.rows) {
      try {
        await deps.documents.remove(row.storage_key)
        // The row stops naming bytes that are gone, so the next page is new
        // work rather than the same one over again.
        await deps.pools.runtime.query(forgetSql, [row.school_id, row.id])
        removed += 1
      } catch {
        // The key stays in its row, so the next sweep tries again.
      }
    }
    if (found.rows.length < EXPORT_FILE_PAGE) return { removed, left: 0 }
  }
  // The bound was reached. What is still listed waits for the next run, and
  // the count says so instead of the sweep looking complete.
  const rest = await deps.pools.runtime.query<ExpiredFileRow>(listSql)
  return { removed, left: rest.rows.length }
}

/**
 * Build one queued export. The job is produced as the person who asked for it,
 * under a context assembled here the same trusted way a request assembles one:
 * the membership is re-read from the database, and a membership that is no
 * longer active, or whose access has changed since the job was asked for, gets
 * no file at all.
 *
 * Returns what happened, so the route can report counts without ever naming a
 * person, a job or a storage key.
 */
async function produceQueuedJob(
  deps: MaintenanceDependencies,
  requestId: string,
  job: QueuedJobRow,
): Promise<'produced' | 'failed' | 'expired'> {
  // A context with no roles, used only to open the tenant transaction that
  // reads the membership and its roles. It serves no data and decides nothing,
  // exactly like the one the session code uses to resolve a membership.
  const lookupContext = createRequestContext({
    requestId,
    // The person behind the membership, read with the job itself: a membership
    // id is not a user id and must never stand in for one.
    userId: job.requested_by_user_id,
    sessionId: requestId,
    schoolId: job.school_id,
    membershipId: job.requested_by_membership_id,
    membershipKind: 'adult',
    accessVersion: 1,
    roleKeys: [],
    assurance: 'single_factor',
    mfaVerifiedAt: null,
  })

  return withTenantTransaction(deps.pools.runtime, lookupContext, async (conn) => {
    const stored = await conn.client.query<{
      access_version: number
      requested_assurance: string | null
      requested_mfa_verified_at: Date | null
    }>(
      `SELECT access_version, requested_assurance, requested_mfa_verified_at FROM export_jobs
        WHERE school_id = $1 AND id = $2 AND status = 'queued'
        FOR UPDATE`,
      [job.school_id, job.id],
    )
    const row = stored.rows[0]
    // Somebody produced or expired it between the list and this transaction.
    if (!row) return 'expired'

    const membership = await loadMembershipStateById(
      conn,
      job.school_id,
      job.requested_by_membership_id,
    )
    const roleKeys = membership
      ? await loadRoleKeys(conn, job.school_id, job.requested_by_membership_id)
      : []
    if (
      membership === null ||
      membership.status !== 'active' ||
      membership.accessVersion !== Number(row.access_version) ||
      roleKeys.length === 0
    ) {
      await conn.client.query(
        `UPDATE export_jobs SET status = 'expired', updated_at = now()
          WHERE school_id = $1 AND id = $2`,
        [job.school_id, job.id],
      )
      return 'expired'
    }

    // The assurance is replayed from the row, never assumed: a job asked for
    // on a single-factor session produces exactly what that session could have
    // read. A row that names nothing is read as the weaker of the two.
    const assurance = row.requested_assurance === 'mfa' ? 'mfa' : 'single_factor'
    const mfaVerifiedAt = row.requested_mfa_verified_at?.toISOString() ?? null
    const context = createRequestContext({
      requestId,
      userId: membership.userId,
      sessionId: requestId,
      schoolId: job.school_id,
      membershipId: membership.id,
      membershipKind: membership.kind,
      accessVersion: membership.accessVersion,
      roleKeys,
      assurance,
      mfaVerifiedAt,
    })
    const result = await produceJob(deps, conn, context, job.id)
    return result.status === 'ready' ? 'produced' : 'failed'
  })
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

    // Files before rows: the tenant sweep deletes the export rows that name
    // these keys, so anything not removed here could never be found again.
    const exportFiles = await removeExpiredExportFiles(deps)
    // The same for message attachments: sweep_messages only removes a
    // message once no attachment of it still names stored bytes.
    const messageFiles = await removeExpiredMessageFiles(deps)

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
      ...(await sweep(deps.pools.runtime, 'messages', 'SELECT * FROM sweep_messages()')),
      // Assistant conversations 30 days after each message was written, the
      // conversations left empty, and the word-free usage counts after 13 months.
      ...(await sweep(deps.pools.runtime, 'assistant', 'SELECT * FROM sweep_assistant()')),
    ]

    // The exports that were too big to build in the request that asked for
    // them. Only a bounded number is built per run, so a busy day cannot make
    // one sweep run for ever; the rest wait for the next run.
    const queued = await deps.pools.runtime.query<QueuedJobRow>(
      'SELECT * FROM list_queued_export_jobs()',
    )
    const produced = { produced: 0, failed: 0, expired: 0 }
    for (const job of queued.rows.slice(0, EXPORT_JOBS_PER_SWEEP)) {
      // One job's trouble is not the sweep's trouble, and the reason stays in
      // the server's own error reporting rather than in this count.
      const outcome = await produceQueuedJob(deps, request.id, job).catch(
        (): 'failed' => 'failed',
      )
      produced[outcome] += 1
    }

    const swept = Object.fromEntries([
      ...entries,
      ['exports.files_removed', exportFiles.removed],
      // Anything still waiting when the page bound was reached, so a run that
      // could not finish the work says so.
      ['exports.files_left', exportFiles.left],
      ['messages.files_removed', messageFiles.removed],
      ['messages.files_left', messageFiles.left],
      ['exports.produced', produced.produced],
      ['exports.failed', produced.failed],
      ['exports.expired', produced.expired],
    ])
    request.log.info({ swept }, 'maintenance sweep complete')
    return { swept }
  })
}
