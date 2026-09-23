import type { FastifyInstance } from 'fastify'
import { ExamExportJob, ExamMarksRegisterExportRequest } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { insertExportJob } from '../../exports/jobs.ts'
import { createAndMaybeProduce } from '../../exports/run.ts'
import { assertUuidParam, protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import { decideExam } from './common.ts'
import { readSheet } from './reads.ts'

/**
 * The marks register file of one paper. The route only decides that this
 * caller may export the paper and counts the roster; the producer reads the
 * sheet again under the same person's own plans when it makes the bytes.
 */
export function registerExamExportRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/exams/papers/:paperId/export',
    permission: 'exams.export',
    body: ExamMarksRegisterExportRequest,
    response: ExamExportJob,
    successStatus: 202,
    handler: async ({ context, param }) => {
      const paperId = assertUuidParam(param('paperId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A paper this caller may not export answers exactly like one that is
        // not there, so holding the permission never reveals what exists.
        await decideExam(conn, context, 'exams.export', paperId)

        // The same reader the producer uses counts the roster.
        const sheet = await readSheet(conn, context, paperId)
        const rows = sheet.rows.length

        const jobId = await insertExportJob(conn, context, {
          kind: 'exam_marks_register',
          permission: 'exams.export',
          criteria: { paperId },
          summary: "Requested a paper's marks register as a file.",
          safeChanges: { paperId, rows },
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: rows })
      })
    },
  })
}
