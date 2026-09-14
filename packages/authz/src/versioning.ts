import type { RequestContext } from '@erp/contracts/server'

import { AuthorizationError } from './errors.ts'
import type { AuthzConnection } from './snapshot.ts'

export { AuthorizationError } from './errors.ts'

export interface LockedMembership {
  readonly id: string
  readonly status: 'active' | 'suspended' | 'removed'
  readonly kind: 'adult' | 'student'
  readonly version: number
  readonly accessVersion: number
}

interface Row {
  id: string
  status: 'active' | 'suspended' | 'removed'
  kind: 'adult' | 'student'
  version: number
  access_version: number
}

/**
 * The write protocol for anything that changes what a membership can do.
 *
 * 1. Lock the membership row with lockMembershipForAccessChange, passing the
 *    version the caller read. A concurrent writer blocks here.
 * 2. Apply the role, rule or status change in the same transaction.
 * 3. Call commitAccessChange, which bumps both counters and fails if another
 *    writer got in first.
 *
 * Readers of sensitive data call assertAccessVersionCurrent inside their own
 * transaction, so a request that started before an access change either waits
 * for the writer or is rejected as stale.
 */
export async function lockMembershipForAccessChange(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
  expectedVersion: number,
): Promise<LockedMembership> {
  const result = await conn.client.query<Row>(
    `SELECT id, status, kind, version, access_version
       FROM school_memberships
      WHERE school_id = $1 AND id = $2
      FOR UPDATE`,
    [schoolId, membershipId],
  )
  const row = result.rows[0]
  if (!row) throw new AuthorizationError('RESOURCE_NOT_FOUND')
  if (Number(row.version) !== expectedVersion) throw new AuthorizationError('VERSION_CONFLICT')
  return {
    id: row.id,
    status: row.status,
    kind: row.kind,
    version: Number(row.version),
    accessVersion: Number(row.access_version),
  }
}

export async function commitAccessChange(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
  expectedVersion: number,
): Promise<{ version: number; accessVersion: number }> {
  const result = await conn.client.query<{ version: number; access_version: number }>(
    `UPDATE school_memberships
        SET version = version + 1, access_version = access_version + 1, updated_at = now()
      WHERE school_id = $1 AND id = $2 AND version = $3
      RETURNING version, access_version`,
    [schoolId, membershipId, expectedVersion],
  )
  const row = result.rows[0]
  if (!row) throw new AuthorizationError('VERSION_CONFLICT')
  return { version: Number(row.version), accessVersion: Number(row.access_version) }
}

export async function assertAccessVersionCurrent(
  conn: AuthzConnection,
  context: RequestContext,
): Promise<void> {
  const result = await conn.client.query<Row>(
    `SELECT id, status, kind, version, access_version
       FROM school_memberships
      WHERE school_id = $1 AND id = $2
      FOR SHARE`,
    [context.schoolId, context.membershipId],
  )
  const row = result.rows[0]
  if (!row || row.status !== 'active') throw new AuthorizationError('ACCESS_DENIED')
  if (Number(row.access_version) !== context.accessVersion) {
    throw new AuthorizationError('VERSION_CONFLICT')
  }
}
