import type { PoolClient } from 'pg'
import { ApiFailure } from '../http/errors.ts'

/** Every helper here runs on the connection opened by withTenantTransaction. */
export interface TenantConnection {
  readonly client: PoolClient
}

export interface AuditEvent {
  readonly schoolId: string
  readonly actorUserId: string | null
  readonly actorMembershipId: string | null
  readonly action: string
  readonly targetType: string
  readonly targetId: string | null
  readonly result: 'allowed' | 'denied' | 'failed'
  /** Plain English, no names, addresses, phone numbers or tokens. */
  readonly summary: string
  readonly safeChanges: Record<string, unknown>
  readonly requestId: string
  /**
   * Free text a person typed (a reason box). It is stored in audit_event_notes,
   * which can be redacted, never in safe_changes, which cannot. Task 12.
   */
  readonly note?: string
}

/**
 * One row per committed change, written inside the same transaction as the
 * change itself, so an audit trail can never drift from what happened.
 */
export async function recordAuditEvent(
  conn: TenantConnection,
  event: AuditEvent,
): Promise<void> {
  const inserted = await conn.client.query<{ id: string }>(
    `INSERT INTO audit_events
       (school_id, actor_user_id, actor_membership_id, action, target_type,
        target_id, result, summary, safe_changes, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     RETURNING id`,
    [
      event.schoolId,
      event.actorUserId,
      event.actorMembershipId,
      event.action,
      event.targetType,
      event.targetId,
      event.result,
      event.summary,
      JSON.stringify(event.safeChanges),
      event.requestId,
    ],
  )
  const note = event.note?.trim()
  if (note) {
    await conn.client.query(
      `INSERT INTO audit_event_notes (school_id, audit_event_id, note) VALUES ($1, $2, $3)`,
      [event.schoolId, inserted.rows[0]?.id, note],
    )
  }
}

/**
 * A school without an active owner has nobody who can restore access, so the
 * whole transaction is refused instead.
 */
export async function assertSchoolKeepsOwner(
  conn: TenantConnection,
  schoolId: string,
): Promise<void> {
  const result = await conn.client.query<{ owners: string }>(
    `SELECT count(*)::text AS owners
       FROM school_memberships sm
       JOIN membership_roles mr ON mr.school_id = sm.school_id AND mr.membership_id = sm.id
       JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
      WHERE sm.school_id = $1 AND sm.status = 'active' AND r.key = 'owner'`,
    [schoolId],
  )
  if (Number(result.rows[0]?.owners ?? '0') === 0) {
    throw new ApiFailure('LAST_OWNER_PROTECTED')
  }
}

/**
 * Taken first by every membership changing transaction, so two lifecycle
 * changes in one school serialise rather than racing the owner check.
 */
export async function lockSchool(
  conn: TenantConnection,
  schoolId: string,
): Promise<{ accessVersion: number }> {
  const result = await conn.client.query<{ access_version: number }>(
    `SELECT access_version FROM schools WHERE id = $1 FOR UPDATE`,
    [schoolId],
  )
  const row = result.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return { accessVersion: Number(row.access_version) }
}
