import type { Pool } from 'pg'
import { loadRoleKeys, type AuthzConnection } from '@erp/authz'
import { MemberSummary, type RoleKey } from '@erp/contracts'
import type { z } from 'zod'

export interface MemberRow {
  readonly id: string
  readonly schoolId: string
  readonly userId: string
  readonly status: 'active' | 'suspended' | 'removed'
  readonly kind: 'adult' | 'student'
  readonly version: number
  readonly accessVersion: number
  readonly roleKeys: RoleKey[]
  readonly staffId: string | null
}

interface Row {
  id: string
  school_id: string
  user_id: string
  status: 'active' | 'suspended' | 'removed'
  kind: 'adult' | 'student'
  version: number
  access_version: number
  staff_id: string | null
}

const SELECT_ROWS = `
  SELECT sm.id, sm.school_id, sm.user_id, sm.status, sm.kind, sm.version, sm.access_version,
         msl.staff_id
    FROM school_memberships sm
    LEFT JOIN membership_staff_links msl
      ON msl.school_id = sm.school_id AND msl.membership_id = sm.id
   WHERE sm.school_id = $1`

async function withRoles(conn: AuthzConnection, row: Row): Promise<MemberRow> {
  return {
    id: row.id,
    schoolId: row.school_id,
    userId: row.user_id,
    status: row.status,
    kind: row.kind,
    version: Number(row.version),
    accessVersion: Number(row.access_version),
    roleKeys: [...(await loadRoleKeys(conn, row.school_id, row.id))],
    staffId: row.staff_id,
  }
}

export async function loadMemberRow(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
): Promise<MemberRow | null> {
  const result = await conn.client.query<Row>(`${SELECT_ROWS} AND sm.id = $2`, [schoolId, membershipId])
  const row = result.rows[0]
  if (!row) return null
  const member = await withRoles(conn, row)
  // A membership with no known role grants nothing, so it is not a member.
  return member.roleKeys.length === 0 ? null : member
}

export async function loadMemberRows(
  conn: AuthzConnection,
  schoolId: string,
  page: { page: number; pageSize: number },
): Promise<{ rows: MemberRow[]; total: number }> {
  const total = await conn.client.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM school_memberships WHERE school_id = $1`,
    [schoolId],
  )
  const result = await conn.client.query<Row>(
    `${SELECT_ROWS} ORDER BY sm.created_at, sm.id LIMIT $2 OFFSET $3`,
    [schoolId, page.pageSize, (page.page - 1) * page.pageSize],
  )
  const rows: MemberRow[] = []
  for (const row of result.rows) {
    const member = await withRoles(conn, row)
    if (member.roleKeys.length > 0) rows.push(member)
  }
  return { rows, total: Number(total.rows[0]?.total ?? '0') }
}

function fullName(first: string, last: string | null): string {
  return `${first} ${last ?? ''}`.trim()
}

/**
 * The name shown in the directory. The school's own staff or guardian record
 * wins, so the directory shows the school's data rather than whatever the
 * person typed into their login profile. auth_user is the last resort and is
 * the only value read from the auth credential, which may not read any tenant
 * table.
 */
export async function resolveDisplayNames(
  conn: AuthzConnection,
  authPool: Pool,
  schoolId: string,
  rows: readonly MemberRow[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (rows.length === 0) return names
  const ids = rows.map((row) => row.id)

  const staff = await conn.client.query<{ membership_id: string; first_name: string; last_name: string | null }>(
    `SELECT msl.membership_id, s.first_name, s.last_name
       FROM membership_staff_links msl
       JOIN staff s ON s.school_id = msl.school_id AND s.id = msl.staff_id
      WHERE msl.school_id = $1 AND msl.membership_id = ANY($2::uuid[])`,
    [schoolId, ids],
  )
  for (const row of staff.rows) {
    const name = fullName(row.first_name, row.last_name)
    if (name.length > 0) names.set(row.membership_id, name)
  }

  const guardians = await conn.client.query<{ membership_id: string; first_name: string; last_name: string | null }>(
    `SELECT mgl.membership_id, g.first_name, g.last_name
       FROM membership_guardian_links mgl
       JOIN guardians g ON g.school_id = mgl.school_id AND g.id = mgl.guardian_id
      WHERE mgl.school_id = $1 AND mgl.membership_id = ANY($2::uuid[])`,
    [schoolId, ids],
  )
  for (const row of guardians.rows) {
    if (names.has(row.membership_id)) continue
    const name = fullName(row.first_name, row.last_name)
    if (name.length > 0) names.set(row.membership_id, name)
  }

  const missing = rows.filter((row) => !names.has(row.id))
  if (missing.length > 0) {
    const users = await authPool.query<{ id: string; name: string }>(
      `SELECT id, name FROM auth_user WHERE id = ANY($1::uuid[])`,
      [[...new Set(missing.map((row) => row.userId))]],
    )
    const byUser = new Map(users.rows.map((row) => [row.id, row.name]))
    for (const row of missing) {
      const name = (byUser.get(row.userId) ?? '').trim()
      // A directory entry always has a label; an unnamed login is not exposed.
      names.set(row.id, name.length > 0 ? name : 'Unnamed member')
    }
  }
  return names
}

export function toMemberSummary(
  row: MemberRow,
  displayName: string,
): z.infer<typeof MemberSummary> {
  return MemberSummary.parse({
    id: row.id,
    schoolId: row.schoolId,
    displayName,
    status: row.status,
    roleKeys: row.roleKeys,
    ...(row.staffId === null ? {} : { staffId: row.staffId }),
    accessVersion: row.accessVersion,
  })
}
