import type { RequestContext } from '@erp/contracts/server'
import { lockSchool, recordAuditEvent, type TenantConnection } from '../../memberships/audit.ts'

export { lockSchool, recordAuditEvent }
export type { TenantConnection }

export interface ModuleAuditEntry {
  /** The permission or workflow name, in the same vocabulary as Task 4 rows. */
  readonly action: string
  readonly targetType: string
  readonly targetId: string | null
  /** Plain English, no names, addresses, phone numbers, keys or tokens. */
  readonly summary: string
  readonly safeChanges?: Record<string, unknown>
  readonly result?: 'allowed' | 'denied' | 'failed'
  /**
   * Free text a person typed. It goes to audit_event_notes, which can be
   * redacted, never into safe_changes, which cannot.
   */
  readonly note?: string
}

/**
 * One audit row for a module change, written inside the same transaction as
 * the change. The actor and the request id come from the verified context, so
 * a caller can never choose who a row is attributed to.
 */
export async function writeAudit(
  conn: TenantConnection,
  context: RequestContext,
  entry: ModuleAuditEntry,
): Promise<void> {
  await recordAuditEvent(conn, {
    schoolId: context.schoolId,
    actorUserId: context.userId,
    actorMembershipId: context.membershipId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    result: entry.result ?? 'allowed',
    summary: entry.summary,
    safeChanges: entry.safeChanges ?? {},
    requestId: context.requestId,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  })
}
