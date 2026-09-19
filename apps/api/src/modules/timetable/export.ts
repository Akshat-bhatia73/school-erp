import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { planPredicate, scopedTableFor } from '@erp/authz'
import { ExportJobSummary, TimetableExportRequest } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { insertExportJob } from '../../exports/jobs.ts'
import { createAndMaybeProduce } from '../../exports/run.ts'
import {
  ApiFailure,
  decideResource,
  protectedRoute,
  readPlan,
  type ModuleDependencies,
} from '../shared/index.ts'
import { assertYear, queryRows, requireUuidValue, type ModuleConnection } from './shared.ts'

/** The week this request names, as the caller may read it. */
type View =
  | { readonly kind: 'section'; readonly sectionId: string }
  | { readonly kind: 'teacher'; readonly staffId: string }

/**
 * The same decision the grid read makes before it answers: a week under the
 * timetable read plan, and when that week is empty, the class or the person
 * itself. A view the caller may not read is not there, so nothing is written.
 */
async function assertViewReadable(
  conn: ModuleConnection,
  context: RequestContext,
  academicYearId: string,
  view: View,
): Promise<void> {
  const table = scopedTableFor('timetable')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const predicate = planPredicate(
    await readPlan(conn, context, 'timetable.read', 'timetable'),
    table,
  )
  const where =
    view.kind === 'section'
      ? sql`timetable_entries.section_id = ${view.sectionId}::uuid`
      : sql`timetable_entries.staff_id = ${view.staffId}::uuid`
  const cells = await queryRows<{ ok: number }>(
    conn,
    sql`SELECT 1 AS ok FROM timetable_entries WHERE ${predicate}
          AND timetable_entries.academic_year_id = ${academicYearId}::uuid AND ${where}
        LIMIT 1`,
  )
  if (cells.length > 0) return

  const decision =
    view.kind === 'section'
      ? await decideResource(conn, context, 'sections.read', 'section', view.sectionId)
      : await decideResource(conn, context, 'staff.read_directory', 'staff', view.staffId)
  if (!decision.allowed) {
    throw new ApiFailure(
      decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND',
    )
  }
}

/**
 * The week on screen, as a spreadsheet or a document. Exporting a timetable is
 * reading it in another format, so it carries the read permission rather than
 * an export permission of its own: a teacher exports their own week, and an
 * office role exports any week it may already read.
 *
 * The view is decided before the job is written, the same way the grid read
 * decides it, and the producer decides it all over again when it draws the
 * file: the access that justified the job is never evidence of the access that
 * produces it.
 */
export function registerTimetableExportRoute(
  app: FastifyInstance,
  deps: ModuleDependencies,
): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/timetable/export',
    permission: 'timetable.read',
    body: TimetableExportRequest,
    response: ExportJobSummary,
    successStatus: 202,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const academicYearId = requireUuidValue(body.academicYearId)
        await assertYear(conn, context.schoolId, academicYearId)
        const view: View =
          body.view.kind === 'section'
            ? { kind: 'section' as const, sectionId: requireUuidValue(body.view.sectionId) }
            : { kind: 'teacher' as const, staffId: requireUuidValue(body.view.staffId) }
        // Decided before anything is written: a week this caller may not read
        // answers like a class or a person who is not there, exactly as the
        // profile exports do, rather than leaving a failed job behind.
        await assertViewReadable(conn, context, academicYearId, view)

        const jobId = await insertExportJob(conn, context, {
          kind: 'timetable',
          permission: 'timetable.read',
          criteria: { academicYearId, format: body.format, view },
          summary: 'Requested a weekly timetable as a file.',
          safeChanges: { format: body.format, view: view.kind },
        })
        // A week is always small, so the file is made in this request and the
        // answer already names something to download.
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: 1 })
      }),
  })
}
