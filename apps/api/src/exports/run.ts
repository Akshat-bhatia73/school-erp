import type { AuthzConnection } from '@erp/authz'
import { EXPORT_INLINE_MAX_ROWS, FilesExportJobSummary } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../http/errors.ts'
import type { DocumentStorage } from '../files/storage.ts'
import { getProducer } from './registry.ts'
import type { ExportFile } from './types.ts'

/** All the runner needs, so the daily route can call it as easily as a route. */
export interface ExportDependencies {
  readonly documents: DocumentStorage
}

/** The extension a stored key ends in, decided by the bytes we produced. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/pdf': 'pdf',
}

/**
 * The format a stored job reports to the caller. The download route reads the
 * same table, so it asks here rather than keeping a second list that could
 * disagree with the one the keys are built from.
 */
export function exportFormatFor(contentType: string): string | undefined {
  return EXTENSIONS[contentType]
}

interface JobRow {
  kind: string
  status: string
  criteria: unknown
  storage_key: string | null
  file_name: string | null
  content_type: string | null
  row_count: number | null
}

/**
 * A stored state outside the contract's four values would be a producer bug,
 * not a caller error, so it answers like any other response that cannot be
 * shaped to the contract.
 */
function summary(
  id: string,
  status: string,
  file?: { fileName: string; contentType: string },
): FilesExportJobSummary {
  const format = file ? EXTENSIONS[file.contentType] : undefined
  const parsed = FilesExportJobSummary.safeParse({
    id,
    status,
    ...(file ? { fileName: file.fileName } : {}),
    ...(format ? { format } : {}),
  })
  if (!parsed.success) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return parsed.data
}

/** Keys are built here and nowhere else, so no caller ever names a path. */
function storageKeyFor(schoolId: string, jobId: string, contentType: string): string {
  const extension = EXTENSIONS[contentType]
  if (!extension) throw new Error('unknown export content type')
  return `exports/${schoolId}/${jobId}.${extension}`
}

/**
 * Run the producer without letting a failure poison the transaction: a
 * database error inside the producer would otherwise leave the connection
 * unable to record the failure it just caused.
 */
async function tryProduce(
  conn: AuthzConnection,
  context: RequestContext,
  kind: string,
  criteria: unknown,
): Promise<ExportFile | null> {
  const producer = getProducer(kind)
  if (!producer) return null
  await conn.client.query('SAVEPOINT export_produce')
  try {
    const file = await producer.produce(conn, context, criteria)
    await conn.client.query('RELEASE SAVEPOINT export_produce')
    return file
  } catch {
    // The reason stays in the server's own error reporting; the job says only
    // that it failed, because the caller may not learn why a row was refused.
    await conn.client.query('ROLLBACK TO SAVEPOINT export_produce')
    await conn.client.query('RELEASE SAVEPOINT export_produce')
    return null
  }
}

/**
 * Where the runner reports the key it actually stored bytes under, so a caller
 * whose transaction is about to roll back can take those bytes away again.
 */
interface WrittenFile {
  key: string | null
}

/**
 * Produce the file for one queued job. The job row is the whole instruction:
 * the producer re-reads the records under the requester's own scope, so
 * nothing here depends on what was visible when the job was asked for.
 *
 * A job that is not queued any more is returned as it stands, so running the
 * daily route twice cannot rebuild a file somebody already has.
 */
export async function produceJob(
  deps: ExportDependencies,
  conn: AuthzConnection,
  context: RequestContext,
  jobId: string,
  written?: WrittenFile,
): Promise<FilesExportJobSummary> {
  const found = await conn.client.query<JobRow>(
    `SELECT kind, status, criteria, storage_key, file_name, content_type, row_count
       FROM export_jobs
      WHERE school_id = $1 AND id = $2
      FOR UPDATE`,
    [context.schoolId, jobId],
  )
  const row = found.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  if (row.status !== 'queued') {
    return row.status === 'ready' && row.file_name && row.content_type
      ? summary(jobId, row.status, { fileName: row.file_name, contentType: row.content_type })
      : summary(jobId, row.status)
  }

  const file = await tryProduce(conn, context, row.kind, row.criteria)
  if (!file) {
    await conn.client.query(
      `UPDATE export_jobs SET status = 'failed', updated_at = now()
        WHERE school_id = $1 AND id = $2`,
      [context.schoolId, jobId],
    )
    return summary(jobId, 'failed')
  }

  const storageKey = storageKeyFor(context.schoolId, jobId, file.contentType)
  // The row names the file before the file exists. A step after this one may
  // fail, and the sweep can only delete bytes a row still points at, so the
  // key is written first and taken away again only when nothing was stored.
  await conn.client.query(
    `UPDATE export_jobs SET storage_key = $3, updated_at = now()
      WHERE school_id = $1 AND id = $2`,
    [context.schoolId, jobId, storageKey],
  )
  try {
    await deps.documents.write(storageKey, file.bytes, file.contentType)
    if (written) written.key = storageKey
  } catch {
    // Nothing reached the store, or what did reach it is not named by any row:
    // the job fails and no file is left behind.
    await deps.documents.remove(storageKey)
    await conn.client.query(
      `UPDATE export_jobs SET storage_key = NULL, updated_at = now()
        WHERE school_id = $1 AND id = $2`,
      [context.schoolId, jobId],
    )
    await conn.client.query(
      `UPDATE export_jobs SET status = 'failed', updated_at = now()
        WHERE school_id = $1 AND id = $2`,
      [context.schoolId, jobId],
    )
    return summary(jobId, 'failed')
  }

  // The file starts its twenty-four hours now, not when the job was asked for,
  // so a job produced by the daily route is not born expired.
  await conn.client.query(
    `UPDATE export_jobs
        SET status = 'ready', storage_key = $3, file_name = $4, content_type = $5,
            row_count = $6, expires_at = now() + interval '24 hours', updated_at = now()
      WHERE school_id = $1 AND id = $2`,
    [context.schoolId, jobId, storageKey, file.fileName, file.contentType, file.rowCount],
  )
  return summary(jobId, 'ready', { fileName: file.fileName, contentType: file.contentType })
}

/**
 * What a POST route calls once it has inserted its job row and counted what
 * the file would hold. A small export is produced in the same request, so the
 * caller downloads it straight away; a big one stays queued for the daily
 * route. The insert and the production share one transaction, so a job whose
 * file could not be written is recorded as failed rather than left waiting.
 */
export async function createAndMaybeProduce(
  deps: ExportDependencies,
  conn: AuthzConnection,
  context: RequestContext,
  job: { id: string; estimatedRows: number },
): Promise<FilesExportJobSummary> {
  if (job.estimatedRows > EXPORT_INLINE_MAX_ROWS) return summary(job.id, 'queued')
  // The insert and the production share this caller's transaction. If anything
  // after the bytes throws, the row that named them disappears with the
  // rollback, so the bytes are taken away here before the failure travels on.
  const written: WrittenFile = { key: null }
  try {
    return await produceJob(deps, conn, context, job.id, written)
  } catch (error) {
    if (written.key !== null) await deps.documents.remove(written.key).catch(() => {})
    throw error
  }
}
