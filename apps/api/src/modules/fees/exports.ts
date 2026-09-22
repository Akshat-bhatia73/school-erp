import type { FastifyInstance } from 'fastify'
import {
  FEE_EXPORT_MAX_DAYS,
  FeeCollectionsExportRequest,
  FeeDuesExportRequest,
  FeeExportJob,
  FeeReceiptExportRequest,
} from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { insertExportJob } from '../../exports/jobs.ts'
import { createAndMaybeProduce } from '../../exports/run.ts'
import {
  ApiFailure,
  assertUuidParam,
  decideResource,
  protectedRoute,
  type ModuleDependencies,
} from '../shared/index.ts'
import { listReceipts, type FeeConnection } from './receipts.ts'
import { readDues } from './statement.ts'

/**
 * The three fee files: one receipt as a document, the dues list, and the
 * collection register. A route only decides that this caller may ask for the
 * file and counts roughly how big it would be; the producer reads every row
 * again under the same person's own plans when it makes the bytes.
 */

/** Whole days between two calendar dates, both ends counted. */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(start) || Number.isNaN(end)) throw new ApiFailure('INVALID_REQUEST')
  return Math.floor((end - start) / 86_400_000) + 1
}

/** The year, when it is this school's. Another school's year is not there. */
async function requireYear(conn: FeeConnection, schoolId: string, academicYearId: string): Promise<void> {
  const found = await conn.client.query(
    `SELECT 1 FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, academicYearId],
  )
  if (found.rowCount === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
}

/**
 * A class or a section named in a filter must belong to this school. It is a
 * filter and not the record being asked for, so a stranger's id is a refused
 * request rather than a missing record.
 */
async function requireFilterRecord(
  conn: FeeConnection,
  schoolId: string,
  table: 'grades' | 'sections',
  id: string | undefined,
): Promise<void> {
  if (id === undefined) return
  const found = await conn.client.query(
    `SELECT 1 FROM ${table} WHERE school_id = $1 AND id = $2`,
    [schoolId, id],
  )
  if (found.rowCount === 0) throw new ApiFailure('INVALID_REQUEST')
}

export function registerFeeExportRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  // One receipt as a document. Printing a receipt is reading it in another
  // format, so it carries the read permission rather than the export one: a
  // parent prints their own child's receipt and nobody else's.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/receipts/:receiptId/export',
    permission: 'fees.read',
    body: FeeReceiptExportRequest,
    response: FeeExportJob,
    successStatus: 202,
    handler: async ({ context, param }) => {
      const receiptId = assertUuidParam(param('receiptId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A ledger row this caller may not read answers exactly like one that
        // is not there, so holding the permission never reveals what exists.
        const decision = await decideResource(conn, context, 'fees.read', 'fee', receiptId)
        if (!decision.allowed) {
          throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
        }

        const jobId = await insertExportJob(conn, context, {
          kind: 'fee_receipt',
          permission: 'fees.read',
          criteria: { receiptId },
          summary: 'Requested a fee receipt as a document.',
        })
        // One record is always small, so the file is made in this request.
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: 1 })
      })
    },
  })

  // The dues list of one year, as the school sees it on screen.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/dues/export',
    permission: 'fees.export',
    body: FeeDuesExportRequest,
    response: FeeExportJob,
    successStatus: 202,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await requireYear(conn, context.schoolId, body.academicYearId)
        await requireFilterRecord(conn, context.schoolId, 'grades', body.gradeId)
        await requireFilterRecord(conn, context.schoolId, 'sections', body.sectionId)

        // How many pupils the file would hold, counted through this caller's
        // own plans by the very reader the producer will use.
        const counted = await readDues(conn, context, {
          academicYearId: body.academicYearId,
          ...(body.gradeId === undefined ? {} : { gradeId: body.gradeId }),
          ...(body.sectionId === undefined ? {} : { sectionId: body.sectionId }),
          show: body.show,
          page: 1,
          pageSize: 1,
        })

        const jobId = await insertExportJob(conn, context, {
          kind: 'fee_dues',
          permission: 'fees.export',
          criteria: { ...body },
          summary: 'Requested the fee dues list as a file.',
          safeChanges: { format: body.format, show: body.show, rows: counted.total },
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: counted.total })
      }),
  })

  // The collection register between two dates.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/receipts/export',
    permission: 'fees.export',
    body: FeeCollectionsExportRequest,
    response: FeeExportJob,
    successStatus: 202,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A register covers at most a year, so one request can never ask the
        // server to walk the whole ledger of a school.
        if (daysBetween(body.from, body.to) > FEE_EXPORT_MAX_DAYS) throw new ApiFailure('INVALID_REQUEST')

        const counted = await listReceipts(
          conn,
          context,
          {
            from: body.from,
            to: body.to,
            ...(body.mode === undefined ? {} : { mode: body.mode }),
          },
          { page: 1, pageSize: 1 },
        )

        const jobId = await insertExportJob(conn, context, {
          kind: 'fee_collections',
          permission: 'fees.export',
          criteria: { ...body },
          summary: 'Requested the fee collection register as a file.',
          safeChanges: { format: body.format, rows: counted.total },
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: counted.total })
      }),
  })
}
