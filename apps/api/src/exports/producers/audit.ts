import { and, sql, type SQL } from 'drizzle-orm'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import { z } from 'zod'
import { ApiFailure, readPlan } from '../../modules/shared/index.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, formatExportDate, XLSX_CONTENT_TYPE } from '../xlsx.ts'

/** What the POST route stored: the window the caller asked for. */
const Criteria = z.object({ from: z.string(), to: z.string() })

interface Row extends Record<string, unknown> {
  created_at: Date
  actor_name: string | null
  has_actor: boolean
  action: string
  target_type: string
  result: string
  summary: string
}

const COLUMNS = [
  { header: 'Time (UTC)', key: 'time', width: 22 },
  { header: 'Person', key: 'actor', width: 28 },
  { header: 'Action', key: 'action', width: 28 },
  { header: 'Target type', key: 'targetType', width: 22 },
  { header: 'Outcome', key: 'outcome', width: 14 },
  { header: 'What happened', key: 'summary', width: 60 },
] as const

/** A timestamp as people read it, with the minute, from the stored instant. */
function formatMoment(value: Date): string {
  const hours = String(value.getUTCHours()).padStart(2, '0')
  const minutes = String(value.getUTCMinutes()).padStart(2, '0')
  return `${formatExportDate(value)} ${hours}:${minutes}`
}

/**
 * The audit trail as a spreadsheet, redacted the same way the screen is: no
 * safe_changes, no target ids, no request id, no address, and no note. The
 * note is free text somebody typed about a person and can be redacted later,
 * so it never leaves the database in a file at all.
 *
 * A name comes from the school's own staff or guardian record, the way the
 * member directory resolves it. The login profile lives in the auth database,
 * which this tenant connection may not read, so a member the school holds no
 * record for reads as "Unnamed member" rather than as the system.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const window = Criteria.parse(criteria)
  const table = scopedTableFor('audit_event')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const predicate = planPredicate(
    await readPlan(conn, context, 'audit.export', 'audit_event'),
    table,
  )
  const where: SQL =
    and(
      predicate,
      sql`audit_events.created_at >= ${window.from}::timestamptz`,
      sql`audit_events.created_at <= ${window.to}::timestamptz`,
    ) ?? predicate

  const result = await conn.db.execute<Row>(
    sql`SELECT audit_events.created_at, audit_events.action, audit_events.target_type,
               audit_events.result, audit_events.summary,
               (audit_events.actor_membership_id IS NOT NULL
                 OR audit_events.actor_user_id IS NOT NULL) AS has_actor,
               COALESCE(
                 NULLIF(btrim(concat_ws(' ', s.first_name, s.last_name)), ''),
                 NULLIF(btrim(concat_ws(' ', g.first_name, g.last_name)), '')
               ) AS actor_name
          FROM audit_events
          LEFT JOIN membership_staff_links msl
            ON msl.school_id = audit_events.school_id
           AND msl.membership_id = audit_events.actor_membership_id
          LEFT JOIN staff s ON s.school_id = msl.school_id AND s.id = msl.staff_id
          LEFT JOIN membership_guardian_links mgl
            ON mgl.school_id = audit_events.school_id
           AND mgl.membership_id = audit_events.actor_membership_id
          LEFT JOIN guardians g ON g.school_id = mgl.school_id AND g.id = mgl.guardian_id
         WHERE ${where}
         ORDER BY audit_events.created_at DESC, audit_events.id DESC`,
  )

  const rows = result.rows.map((row) => ({
    time: formatMoment(row.created_at instanceof Date ? row.created_at : new Date(row.created_at)),
    actor: row.actor_name ?? (row.has_actor ? 'Unnamed member' : 'System'),
    action: row.action,
    targetType: row.target_type,
    // The contract knows two outcomes, so anything that is not a clean allow
    // reads as denied, exactly as the list read reports it.
    outcome: row.result === 'allowed' ? 'Allowed' : 'Denied',
    summary: row.summary,
  }))

  return {
    bytes: await buildWorkbook({ sheetName: 'Audit events', columns: COLUMNS, rows }),
    contentType: XLSX_CONTENT_TYPE,
    fileName: `Audit events ${formatExportDate(new Date())}.xlsx`,
    rowCount: rows.length,
  }
}

registerProducer({ kind: 'audit', produce })
