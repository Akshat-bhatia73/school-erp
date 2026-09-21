import type { Pool } from 'pg'
import { and, desc, sql, type SQL } from 'drizzle-orm'
import { auditEvents } from '@erp/db/schema'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import type { z } from 'zod'
import type { AuditEventSummary } from '@erp/contracts'
import { actorDisplayName, actorLabels, type ActorLabels } from '../audit/actors.ts'
import { readPlan } from '../shared/index.ts'
import { ApiFailure } from '../../http/errors.ts'

type Summary = z.infer<typeof AuditEventSummary>

/** How many events each activity card carries. */
const ACTIVITY_LIMIT = 8

interface EventRow {
  readonly id: string
  readonly createdAt: Date
  readonly actorUserId: string | null
  readonly actorMembershipId: string | null
  readonly action: string
  readonly summary: string
  readonly result: string
}

/**
 * The dashboard shows the same projection the audit list shows: an id, a
 * moment, who acted, the action, its one-line summary and whether it was
 * allowed. Nothing of safe_changes, no target ids and no free-text note
 * reaches a dashboard. The actor names come from the audit module's own
 * helper, so the two can never disagree about who somebody is.
 */
function toSummary(row: EventRow, names: ActorLabels): Summary {
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    actorDisplayName: actorDisplayName(row, names),
    action: row.action,
    summary: row.summary,
    outcome: row.result === 'allowed' ? 'allowed' : 'denied',
  }
}

async function listEvents(
  conn: AuthzConnection,
  context: RequestContext,
  authPool: Pool,
  extra: SQL | undefined,
): Promise<Summary[]> {
  const table = scopedTableFor('audit_event')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const plan = await readPlan(conn, context, 'audit.read', 'audit_event')
  const predicate = planPredicate(plan, table)
  const where = extra === undefined ? predicate : (and(predicate, extra) ?? predicate)
  const found = (await conn.db
    .select({
      id: auditEvents.id,
      createdAt: auditEvents.createdAt,
      actorUserId: auditEvents.actorUserId,
      actorMembershipId: auditEvents.actorMembershipId,
      action: auditEvents.action,
      summary: auditEvents.summary,
      result: auditEvents.result,
    })
    .from(auditEvents)
    .where(where)
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(ACTIVITY_LIMIT)) as EventRow[]
  const names = await actorLabels(conn, authPool, context.schoolId, found)
  return found.map((row) => toSummary(row, names))
}

/** The eight most recent events the caller may read. */
export function recentAuditEvents(
  conn: AuthzConnection,
  context: RequestContext,
  authPool: Pool,
): Promise<Summary[]> {
  return listEvents(conn, context, authPool, undefined)
}

/**
 * The eight most recent events an owner should look at: anything refused, and
 * every change to roles, memberships or ownership.
 */
export function securityAuditEvents(
  conn: AuthzConnection,
  context: RequestContext,
  authPool: Pool,
): Promise<Summary[]> {
  return listEvents(
    conn,
    context,
    authPool,
    sql`(${auditEvents.result} <> 'allowed'
         OR ${auditEvents.action} LIKE 'roles.%'
         OR ${auditEvents.action} LIKE 'members.%'
         OR ${auditEvents.action} LIKE 'ownership.%')`,
  )
}
