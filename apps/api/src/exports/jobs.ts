import type { AuthzConnection } from '@erp/authz'
import type { PermissionKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../http/errors.ts'
import { writeAudit } from '../modules/shared/audit.ts'
import type { ExportJobKind } from './types.ts'

export interface NewExportJob {
  readonly kind: ExportJobKind
  /** The permission the download route will re-decide before it answers. */
  readonly permission: PermissionKey
  /** What the producer needs to rebuild the file. No names, no free text. */
  readonly criteria: Record<string, unknown>
  /** Plain English, for the audit row this write leaves behind. */
  readonly summary: string
  readonly safeChanges?: Record<string, unknown>
}

/**
 * Record the request for a file. The row remembers the access version it was
 * made under, so the file stops being downloadable the moment the requester's
 * access changes, and one audit row names the job in the same transaction.
 *
 * It also remembers the assurance this request reached. A job the daily route
 * builds later replays that stored value rather than assuming a second factor,
 * so a file can never hold rows the asking session could not have read.
 *
 * The expiry written here is a floor: the runner resets it to twenty-four
 * hours from the moment the bytes actually exist.
 */
export async function insertExportJob(
  conn: AuthzConnection,
  context: RequestContext,
  job: NewExportJob,
): Promise<string> {
  const inserted = await conn.client.query<{ id: string }>(
    `INSERT INTO export_jobs
       (school_id, requested_by_membership_id, kind, status, access_version, permission,
        criteria, requested_assurance, requested_mfa_verified_at, expires_at)
     VALUES ($1, $2, $3, 'queued', $4, $5, $6::jsonb, $7, $8::timestamptz,
             now() + interval '24 hours')
     RETURNING id`,
    [
      context.schoolId,
      context.membershipId,
      job.kind,
      context.accessVersion,
      job.permission,
      JSON.stringify(job.criteria),
      context.assurance,
      context.mfaVerifiedAt,
    ],
  )
  const id = inserted.rows[0]?.id
  if (!id) throw new ApiFailure('SERVICE_UNAVAILABLE')
  await writeAudit(conn, context, {
    action: job.permission,
    targetType: 'export_job',
    targetId: id,
    summary: job.summary,
    safeChanges: job.safeChanges ?? {},
  })
  return id
}
