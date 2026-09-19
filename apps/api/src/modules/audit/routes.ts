import type { FastifyInstance } from 'fastify'
import type { Pool } from 'pg'
import { and, desc, eq, sql, type SQL } from 'drizzle-orm'
import {
  AUDIT_EXPORT_MAX_DAYS,
  AuditEventListRequest,
  AuditEventPage,
  AuditExportJob,
  AuditExportRequest,
  LIFECYCLE_ENDPOINTS,
  RedactAuditNoteRequest,
} from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { auditEventNotes, auditEvents } from '@erp/db/schema'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import { createAndMaybeProduce } from '../../exports/run.ts'
import { resolveDisplayNames, type MemberRow } from '../../memberships/directory.ts'
import { ApiFailure, assertUuidParam, lockSchool, readPlan, writeAudit } from '../shared/index.ts'
import type { ModuleDependencies } from '../shared/route.ts'
import { protectedRoute } from '../shared/route.ts'

/** The audit trail table, as the read plan knows how to filter it. */
function auditTable() {
  const table = scopedTableFor('audit_event')
  // The catalogue pairs audit.read with audit_event, so this cannot be missing
  // at runtime; failing closed keeps that a fact rather than an assumption.
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return table
}

interface EventRow {
  readonly id: string
  readonly createdAt: Date
  readonly actorUserId: string | null
  readonly actorMembershipId: string | null
  readonly action: string
  readonly summary: string
  readonly result: string
  /** Null when no note was written, or when the note has been redacted. */
  readonly note: string | null
}

/**
 * The name to show beside each event. A membership is resolved exactly like
 * the member directory does it, so the audit log and the directory never
 * disagree about who somebody is. Some real actions are written before a
 * membership exists (accepting an invitation, for instance) and carry only a
 * user id: those must not be labelled "System", or the log would misreport a
 * person as the machine, so the login profile is read for them as a fallback.
 */
async function actorLabels(
  conn: AuthzConnection,
  authPool: Pool,
  schoolId: string,
  rows: readonly EventRow[],
): Promise<{ byMembership: Map<string, string>; byUser: Map<string, string> }> {
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
function actorDisplayName(
  row: EventRow,
  labels: { byMembership: Map<string, string>; byUser: Map<string, string> },
): string {
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

/** A window that is ordered and no longer than a year. */
function exportWindow(body: AuditExportRequest): { from: string; to: string } {
  const from = Date.parse(body.from)
  const to = Date.parse(body.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    throw new ApiFailure('INVALID_REQUEST')
  }
  if (to - from > AUDIT_EXPORT_MAX_DAYS * 24 * 60 * 60 * 1000) {
    throw new ApiFailure('INVALID_REQUEST')
  }
  return { from: body.from, to: body.to }
}

/** The plan predicate plus the caller's filters, as one WHERE clause. */
function whereFor(predicate: SQL, filters: readonly (SQL | undefined)[]): SQL {
  const clause = and(predicate, ...filters)
  // `and` only widens to undefined when every part is, and the predicate never
  // is, so this is a type narrowing rather than a real branch.
  return clause ?? predicate
}

async function countEvents(conn: AuthzConnection, where: SQL): Promise<number> {
  const counted = (await conn.db
    .select({ total: sql<number>`count(*)::int` })
    .from(auditEvents)
    .where(where)) as { total: number }[]
  return counted[0]?.total ?? 0
}

export function registerAuditRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  /**
   * The audit log, redacted by design. The response carries no safe_changes,
   * no target ids, no request id and no address: those exist for an operator
   * reading the database, not for a member reading a screen. Every row is
   * selected by the read plan, so nothing outside the caller's scope is
   * counted, paged over or shown.
   */
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/audit-events',
    permission: 'audit.read',
    query: AuditEventListRequest,
    response: AuditEventPage,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const table = auditTable()
        const plan = await readPlan(conn, context, 'audit.read', 'audit_event')
        const where = whereFor(planPredicate(plan, table), [
          query.actorMembershipId === undefined
            ? undefined
            : sql`${auditEvents.actorMembershipId} = ${query.actorMembershipId}::uuid`,
          query.action === undefined ? undefined : sql`${auditEvents.action} = ${query.action}`,
          query.from === undefined
            ? undefined
            : sql`${auditEvents.createdAt} >= ${query.from}::timestamptz`,
          query.to === undefined
            ? undefined
            : sql`${auditEvents.createdAt} <= ${query.to}::timestamptz`,
        ])

        const total = await countEvents(conn, where)
        const rows = (await conn.db
          .select({
            id: auditEvents.id,
            createdAt: auditEvents.createdAt,
            actorUserId: auditEvents.actorUserId,
            actorMembershipId: auditEvents.actorMembershipId,
            action: auditEvents.action,
            summary: auditEvents.summary,
            result: auditEvents.result,
            // A redacted note reads as absent: the event stays, the free text
            // a person typed does not.
            note: sql<string | null>`CASE WHEN ${auditEventNotes.redactedAt} IS NULL THEN ${auditEventNotes.note} END`,
          })
          .from(auditEvents)
          .leftJoin(
            auditEventNotes,
            and(
              eq(auditEventNotes.schoolId, auditEvents.schoolId),
              eq(auditEventNotes.auditEventId, auditEvents.id),
            ),
          )
          .where(where)
          // Newest first, with the id as the tie break so paging is stable
          // when several rows share a timestamp.
          .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize)) as EventRow[]

        const labels = await actorLabels(conn, deps.pools.auth, context.schoolId, rows)
        return {
          items: rows.map((row) => ({
            id: row.id,
            at: row.createdAt.toISOString(),
            actorDisplayName: actorDisplayName(row, labels),
            action: row.action,
            summary: row.summary,
            // The contract has only two outcomes, so a write that failed part
            // way through is reported as denied: an operator who needs to tell
            // the two apart reads the result column in the database.
            outcome: row.result === 'allowed' ? ('allowed' as const) : ('denied' as const),
            ...(row.note === null ? {} : { note: row.note.slice(0, 1000) }),
          })),
          total,
          page: query.page,
          pageSize: query.pageSize,
        }
      }),
  })

  /**
   * An export request. It records what was asked for, under which permission
   * and at which access version, and counts the rows the same plan predicate
   * allows. The file itself is produced later and is only ever handed back
   * through the files module, which re-checks that version before it serves
   * anything, so a job cannot outlive the access that created it.
   */
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/audit-events/export',
    permission: 'audit.export',
    body: AuditExportRequest,
    response: AuditExportJob,
    successStatus: 202,
    handler: async ({ context, body }) => {
      const window = exportWindow(body)
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const table = auditTable()
        const plan = await readPlan(conn, context, 'audit.export', 'audit_event')
        const where = whereFor(planPredicate(plan, table), [
          sql`${auditEvents.createdAt} >= ${window.from}::timestamptz`,
          sql`${auditEvents.createdAt} <= ${window.to}::timestamptz`,
        ])
        const rowCount = await countEvents(conn, where)

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO export_jobs
             (school_id, requested_by_membership_id, kind, status, access_version,
              permission, criteria, row_count, expires_at)
           VALUES ($1, $2, 'audit', 'queued', $3, 'audit.export', $4::jsonb, $5, now() + interval '1 day')
           RETURNING id`,
          [
            context.schoolId,
            context.membershipId,
            context.accessVersion,
            JSON.stringify({ from: window.from, to: window.to }),
            rowCount,
          ],
        )
        const jobId = inserted.rows[0]?.id
        if (!jobId) throw new ApiFailure('SERVICE_UNAVAILABLE')

        // Reading the audit trail in bulk is itself something worth auditing.
        await writeAudit(conn, context, {
          action: 'audit.export',
          targetType: 'export_job',
          targetId: jobId,
          summary: 'Requested an export of audit events for a date window',
          safeChanges: { rowCount, days: Math.round((Date.parse(window.to) - Date.parse(window.from)) / 86_400_000) },
        })
        // A short window is produced now and comes back ready; a long one
        // stays queued until the daily route builds it. The status is never
        // claimed here, it is whatever the run actually reached.
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: rowCount })
      })
    },
  })

  /**
   * Redaction of one note. The audit event itself is permanent; the free text
   * a person typed into a reason box is not, so a subject can ask for it to be
   * removed without the trail losing the fact that something happened.
   */
  protectedRoute(app, deps, {
    method: LIFECYCLE_ENDPOINTS.redactAuditNote.method,
    path: LIFECYCLE_ENDPOINTS.redactAuditNote.path,
    permission: 'audit.redact_notes',
    body: RedactAuditNoteRequest,
    response: LIFECYCLE_ENDPOINTS.redactAuditNote.response,
    handler: async ({ context, param }) => {
      const eventId = assertUuidParam(param('eventId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const event = await conn.client.query<{ id: string }>(
          `SELECT id FROM audit_events WHERE school_id = $1 AND id = $2::uuid`,
          [context.schoolId, eventId],
        )
        if (event.rows.length === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')

        const updated = await conn.client.query(
          `UPDATE audit_event_notes
              SET redacted_at = now(), redacted_by_membership_id = $3
            WHERE school_id = $1 AND audit_event_id = $2::uuid AND redacted_at IS NULL`,
          [context.schoolId, eventId, context.membershipId],
        )
        // A note that is already redacted is left alone and leaves no second
        // audit row: repeating the request changes nothing.
        if ((updated.rowCount ?? 0) > 0) {
          // The reason the redacting person gave is itself free text about a
          // person, so it is not stored anywhere: the row records only that a
          // note was removed and from which event.
          await writeAudit(conn, context, {
            action: 'audit.redact_notes',
            targetType: 'audit_event',
            targetId: eventId,
            summary: 'Redacted the note attached to an audit event.',
            safeChanges: { eventId },
          })
        }
        return { status: 'redacted' as const }
      })
    },
  })
}
