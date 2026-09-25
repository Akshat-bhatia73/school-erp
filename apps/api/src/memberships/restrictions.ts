import {
  commitAccessChange,
  lockMembershipForAccessChange,
  type AuthzConnection,
} from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import {
  CreateMemberRestrictionRequest,
  LiftMemberRestrictionRequest,
  MemberRestriction,
  MemberRestrictionList,
  RESTRICTABLE_PERMISSIONS,
  ROLE_RESTRICTION_RULES,
  type RoleKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { z } from 'zod'
import { ApiFailure } from '../http/errors.ts'
import { lockSchool, recordAuditEvent } from './audit.ts'
import { authorizeSchoolAction } from './authorize.ts'
import { resolveDisplayNames, type MemberRow } from './directory.ts'
import { loadTarget, parseBody, type LifecycleDependencies } from './lifecycle.ts'

/**
 * Member restrictions (September 2026). A restriction is an ordinary
 * `resource_access_rules` row: effect deny, the school as its target, one of
 * the four restrictable keys. Nothing here decides a read; the policy service
 * already lets any applicable deny win, so this file only writes and lists the
 * rows, under the same locks, delegation and audit as a suspension.
 */

/** The longest a dated restriction may run; longer is "until lifted". */
const MAX_RESTRICTION_MS = 2 * 366 * 24 * 60 * 60 * 1000

/** Roles that make a membership staff; parents and pupils are never restricted. */
const NON_STAFF_ROLES: readonly RoleKey[] = ['parent', 'student']

interface RuleRow {
  id: string
  permission: string
  reason: string
  effective_from: Date
  expires_at: Date | null
  author_membership_id: string
  created_at: Date
  version: number
}

/** The rules in force for one membership: restrictable, deny, school, not lifted, not ended. */
const IN_FORCE = `
      school_id = $1 AND membership_id = $2
      AND effect = 'deny' AND target_type = 'school'
      AND permission = ANY($3::text[])
      AND revoked_at IS NULL
      AND effective_from <= now()
      AND (expires_at IS NULL OR expires_at > now())`

const RULE_COLUMNS = `id, permission, reason, effective_from, expires_at, author_membership_id, created_at, version`

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** An id that cannot be a row answers exactly like a row that is not there. */
function assertRowId(id: string): void {
  if (!UUID.test(id)) throw new ApiFailure('RESOURCE_NOT_FOUND')
}

function holdsStaffRole(roleKeys: readonly RoleKey[]): boolean {
  return roleKeys.some((role) => !NON_STAFF_ROLES.includes(role))
}

/**
 * Whether the actor may add or lift restrictions on this target. Nobody
 * touches themselves or an owner, and every staff role the target holds must
 * be one `ROLE_RESTRICTION_RULES` lets one of the actor's roles restrict. That
 * is wider than suspension because a restriction only ever takes access away.
 * On top of that the target must be an active member of staff.
 */
type Delegation = { ok: true } | { ok: false; code: 'ACCESS_DENIED' | 'INVALID_REQUEST' }

function delegationFor(context: RequestContext, target: MemberRow): Delegation {
  // The control is for staff; a parent or pupil is not a wrong target of
  // authority but a wrong kind of target.
  if (!holdsStaffRole(target.roleKeys)) return { ok: false, code: 'INVALID_REQUEST' }
  if (target.id === context.membershipId || target.roleKeys.includes('owner'))
    return { ok: false, code: 'ACCESS_DENIED' }
  const restrictable = new Set<RoleKey>(
    context.roleKeys.flatMap((role) => ROLE_RESTRICTION_RULES[role].restrictableTargetRoles),
  )
  const staffRoles = target.roleKeys.filter((role) => !NON_STAFF_ROLES.includes(role))
  if (!staffRoles.every((role) => restrictable.has(role))) return { ok: false, code: 'ACCESS_DENIED' }
  if (target.status !== 'active') return { ok: false, code: 'INVALID_REQUEST' }
  return { ok: true }
}

function assertDelegation(context: RequestContext, target: MemberRow): void {
  const delegation = delegationFor(context, target)
  if (!delegation.ok) throw new ApiFailure(delegation.code)
}

/** Authors are named the way the directory names anybody, even after they leave. */
async function authorNames(
  conn: AuthzConnection,
  deps: LifecycleDependencies,
  schoolId: string,
  authorIds: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(authorIds)]
  if (unique.length === 0) return new Map()
  const found = await conn.client.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM school_memberships WHERE school_id = $1 AND id = ANY($2::uuid[])`,
    [schoolId, unique],
  )
  // Only the id and the login are used to find a name.
  const rows: MemberRow[] = found.rows.map((row) => ({
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
  return resolveDisplayNames(conn, deps.pools.auth, schoolId, rows)
}

function toRestriction(row: RuleRow, authorName: string): MemberRestriction {
  return MemberRestriction.parse({
    id: row.id,
    permission: row.permission,
    reason: row.reason,
    startsAt: new Date(row.effective_from).toISOString(),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    createdBy: { membershipId: row.author_membership_id, displayName: authorName },
    createdAt: new Date(row.created_at).toISOString(),
    version: Number(row.version),
  })
}

/**
 * Lock the target for an access change, comparing the access version the
 * caller saw. The shared lock compares `version`, so the row is read under
 * the same lock first and the protocol helper is handed what it wants.
 */
async function lockTarget(
  conn: AuthzConnection,
  schoolId: string,
  membershipId: string,
  expectedAccessVersion: number | null,
): Promise<number> {
  const current = await conn.client.query<{ version: number; access_version: number }>(
    `SELECT version, access_version FROM school_memberships
      WHERE school_id = $1 AND id = $2 FOR UPDATE`,
    [schoolId, membershipId],
  )
  const row = current.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  if (expectedAccessVersion !== null && Number(row.access_version) !== expectedAccessVersion) {
    throw new ApiFailure('VERSION_CONFLICT')
  }
  const locked = await lockMembershipForAccessChange(conn, schoolId, membershipId, Number(row.version))
  return locked.version
}

export async function listRestrictions(
  deps: LifecycleDependencies,
  context: RequestContext,
  membershipId: string,
): Promise<z.infer<typeof MemberRestrictionList>> {
  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await authorizeSchoolAction(conn, context, 'access.manage')
    assertRowId(membershipId)
    const target = await loadTarget(conn, context.schoolId, membershipId)
    const rules = await conn.client.query<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM resource_access_rules
        WHERE ${IN_FORCE}
        ORDER BY created_at DESC, id DESC
        LIMIT 20`,
      [context.schoolId, target.id, [...RESTRICTABLE_PERMISSIONS]],
    )
    const names = await authorNames(
      conn,
      deps,
      context.schoolId,
      rules.rows.map((row) => row.author_membership_id),
    )
    return MemberRestrictionList.parse({
      items: rules.rows.map((row) =>
        toRestriction(row, names.get(row.author_membership_id) ?? 'Unnamed member'),
      ),
      allowedActions: delegationFor(context, target).ok ? ['access.manage'] : [],
    })
  })
}

export async function addRestriction(
  deps: LifecycleDependencies,
  context: RequestContext,
  membershipId: string,
  rawBody: unknown,
): Promise<MemberRestriction> {
  const body = parseBody(rawBody, CreateMemberRestrictionRequest)
  if (body.expiresAt !== undefined) {
    const ends = Date.parse(body.expiresAt)
    const now = Date.now()
    if (!(ends > now) || ends - now > MAX_RESTRICTION_MS) throw new ApiFailure('INVALID_REQUEST')
  }

  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    // Serialise every access change in this school, including two people
    // adding the same restriction at once.
    await lockSchool(conn, context.schoolId)
    await authorizeSchoolAction(conn, context, 'access.manage')
    assertRowId(membershipId)
    const target = await loadTarget(conn, context.schoolId, membershipId)
    assertDelegation(context, target)
    const lockedVersion = await lockTarget(conn, context.schoolId, target.id, body.expectedAccessVersion)

    const existing = await conn.client.query<{ id: string }>(
      `SELECT id FROM resource_access_rules WHERE ${IN_FORCE} LIMIT 1`,
      [context.schoolId, target.id, [body.permission]],
    )
    if (existing.rows.length > 0) throw new ApiFailure('VERSION_CONFLICT')

    const inserted = await conn.client.query<RuleRow>(
      `INSERT INTO resource_access_rules
         (school_id, membership_id, permission, effect, target_type,
          effective_from, expires_at, reason, author_membership_id)
       VALUES ($1, $2, $3, 'deny', 'school', now(), $4::timestamptz, $5, $6)
       RETURNING ${RULE_COLUMNS}`,
      [
        context.schoolId,
        target.id,
        body.permission,
        body.expiresAt ?? null,
        body.reason,
        context.membershipId,
      ],
    )
    const rule = inserted.rows[0]
    if (!rule) throw new ApiFailure('SERVICE_UNAVAILABLE')

    // Their next request, and any export job already queued, is decided again.
    await commitAccessChange(conn, context.schoolId, target.id, lockedVersion)

    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: 'access.restrict',
      targetType: 'membership',
      targetId: target.id,
      result: 'allowed',
      summary: 'Restricted a member from one kind of student information.',
      safeChanges: {
        restrictionId: rule.id,
        permission: body.permission,
        expiresAt: body.expiresAt ?? null,
      },
      requestId: context.requestId,
      // The typed reason is a redactable note, never structural audit data.
      note: body.reason,
    })

    const names = await authorNames(conn, deps, context.schoolId, [context.membershipId])
    return toRestriction(rule, names.get(context.membershipId) ?? 'Unnamed member')
  })
}

export async function liftRestriction(
  deps: LifecycleDependencies,
  context: RequestContext,
  membershipId: string,
  restrictionId: string,
  rawBody: unknown,
): Promise<{ status: 'lifted' }> {
  const body = parseBody(rawBody, LiftMemberRestrictionRequest)

  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await lockSchool(conn, context.schoolId)
    await authorizeSchoolAction(conn, context, 'access.manage')
    assertRowId(membershipId)
    const target = await loadTarget(conn, context.schoolId, membershipId)
    assertDelegation(context, target)
    const lockedVersion = await lockTarget(conn, context.schoolId, target.id, null)
    assertRowId(restrictionId)

    // Another member's rule, another school's rule or one already lifted or
    // ended all answer the same way.
    const found = await conn.client.query<{ id: string; permission: string; version: number }>(
      `SELECT id, permission, version FROM resource_access_rules
        WHERE ${IN_FORCE} AND id = $4
        FOR UPDATE`,
      [context.schoolId, target.id, [...RESTRICTABLE_PERMISSIONS], restrictionId],
    )
    const rule = found.rows[0]
    if (!rule) throw new ApiFailure('RESOURCE_NOT_FOUND')
    if (Number(rule.version) !== body.expectedVersion) throw new ApiFailure('VERSION_CONFLICT')

    await conn.client.query(
      `UPDATE resource_access_rules
          SET revoked_at = now(), version = version + 1, updated_at = now()
        WHERE school_id = $1 AND id = $2`,
      [context.schoolId, rule.id],
    )
    await commitAccessChange(conn, context.schoolId, target.id, lockedVersion)

    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: 'access.restriction_lift',
      targetType: 'membership',
      targetId: target.id,
      result: 'allowed',
      summary: 'Lifted a restriction on a member.',
      safeChanges: { restrictionId: rule.id, permission: rule.permission },
      requestId: context.requestId,
      note: body.reason,
    })

    return { status: 'lifted' as const }
  })
}
