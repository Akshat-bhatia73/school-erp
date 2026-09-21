import type { Pool } from 'pg'
import type { AuthzConnection } from '@erp/authz'
import { resolveDisplayNames, type MemberRow } from '../../memberships/directory.ts'

/** The parts of an audit row the actor label is built from. */
export interface ActorRow {
  readonly actorUserId: string | null
  readonly actorMembershipId: string | null
}

/** The names resolved once for a page of events. */
export interface ActorLabels {
  readonly byMembership: Map<string, string>
  readonly byUser: Map<string, string>
}

/**
 * The name to show beside each event. A membership is resolved exactly like
 * the member directory does it, so the audit log and the directory never
 * disagree about who somebody is. Some real actions are written before a
 * membership exists (accepting an invitation, for instance) and carry only a
 * user id: those must not be labelled "System", or the log would misreport a
 * person as the machine, so the login profile is read for them as a fallback.
 */
export async function actorLabels(
  conn: AuthzConnection,
  authPool: Pool,
  schoolId: string,
  rows: readonly ActorRow[],
): Promise<ActorLabels> {
  const membershipIds = [
    ...new Set(rows.map((row) => row.actorMembershipId).filter((id): id is string => id !== null)),
  ]
  const byMembership = new Map<string, string>()
  if (membershipIds.length > 0) {
    const result = await conn.client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM school_memberships WHERE school_id = $1 AND id = ANY($2::uuid[])`,
      [schoolId, membershipIds],
    )
    // resolveDisplayNames reads only the identity of a row, so the remaining
    // membership fields are filled with harmless placeholders rather than being
    // queried: nothing here is returned to the caller.
    const memberRows: MemberRow[] = result.rows.map((row) => ({
      id: row.id,
      schoolId,
      userId: row.user_id,
      status: 'active',
      kind: 'adult',
      version: 1,
      accessVersion: 1,
      roleKeys: [],
      staffId: null,
    }))
    for (const [id, name] of await resolveDisplayNames(conn, authPool, schoolId, memberRows)) {
      byMembership.set(id, name)
    }
  }

  const userIds = [
    ...new Set(
      rows
        .filter((row) => row.actorMembershipId === null && row.actorUserId !== null)
        .map((row) => row.actorUserId as string),
    ),
  ]
  const byUser = new Map<string, string>()
  if (userIds.length > 0) {
    const users = await authPool.query<{ id: string; name: string }>(
      `SELECT id, name FROM auth_user WHERE id = ANY($1::uuid[])`,
      [userIds],
    )
    for (const row of users.rows) {
      const name = (row.name ?? '').trim()
      if (name.length > 0) byUser.set(row.id, name)
    }
  }
  return { byMembership, byUser }
}

/** The label for one row, given the names that were resolved for the page. */
export function actorDisplayName(row: ActorRow, labels: ActorLabels): string {
  const name =
    row.actorMembershipId !== null
      ? (labels.byMembership.get(row.actorMembershipId) ?? 'Unnamed member')
      : row.actorUserId !== null
        ? (labels.byUser.get(row.actorUserId) ?? 'Unnamed member')
        : // Only a row with neither actor was written by the system itself.
          'System'
  // A login profile name is not length-bounded by the database, and the
  // contract's DisplayName is; clamping keeps a long name from turning a
  // readable page into a 503.
  return name.slice(0, 160)
}

