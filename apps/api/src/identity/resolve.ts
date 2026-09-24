import {
  activeMembershipsForUser,
  studentLoginState,
  withTenantTransaction,
} from '@erp/db'
import { MembershipSummary, type RoleKey } from '@erp/contracts'
import type { ApiPools } from '../db.ts'
import { createRequestContext } from '../auth/request-context.ts'

export type MembershipSummaryValue = ReturnType<typeof MembershipSummary.parse>

/**
 * Memberships and roles are never readable by the Better Auth connection.
 * They are resolved here, after the session was verified, using the identity
 * bootstrap role and then one tenant transaction per school.
 */
export async function resolveMemberships(
  pools: ApiPools,
  input: { requestId: string; userId: string; sessionId: string },
): Promise<MembershipSummaryValue[]> {
  const rows = await activeMembershipsForUser(pools.identity, input.userId)

  const summaries: MembershipSummaryValue[] = []
  for (const row of rows) {
    // A bootstrap context carrying no roles: it only opens the tenant
    // transaction that reads the school and the roles themselves.
    const lookupContext = createRequestContext({
      requestId: input.requestId,
      userId: input.userId,
      sessionId: input.sessionId,
      schoolId: row.school_id,
      membershipId: row.membership_id,
      membershipKind: row.kind,
      accessVersion: row.access_version,
      roleKeys: [],
      assurance: 'single_factor',
      mfaVerifiedAt: null,
    })

    const read = await withTenantTransaction(
      pools.runtime,
      lookupContext,
      async ({ client }) => {
        const school = await client.query<{ id: string; name: string; code: string }>(
          'SELECT id, name, login_code AS code FROM schools WHERE id = $1',
          [row.school_id],
        )
        const roles = await client.query<{ key: string }>(
          `SELECT role.key
             FROM membership_roles AS assignment
             JOIN roles AS role
               ON role.id = assignment.role_id
              AND role.school_id = assignment.school_id
            WHERE assignment.membership_id = $1
            ORDER BY role.key`,
          [row.membership_id],
        )
        return { school: school.rows[0], roleKeys: roles.rows.map((r) => r.key) }
      },
    )

    // A membership with no readable school or no role assignment is not usable.
    if (!read.school || read.roleKeys.length === 0) continue

    summaries.push(
      MembershipSummary.parse({
        id: row.membership_id,
        school: read.school,
        status: 'active',
        kind: row.kind,
        roleKeys: read.roleKeys as RoleKey[],
        accessVersion: row.access_version,
      }),
    )
  }
  return summaries
}

/**
 * True for a pupil whose own login was switched off or ended: such an identity
 * never holds a session. An adult, and a pupil whose login is on, are false.
 */
export async function studentLoginIsInactive(
  pools: ApiPools,
  userId: string,
): Promise<boolean> {
  return (await studentLoginState(pools.identity, userId)) === 'inactive'
}
