import type { FastifyInstance } from 'fastify'
import { StudentExportJob, StudentProfileExportRequest } from '@erp/contracts'
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

/**
 * One student's record as a document. The record is named in the path and the
 * body carries nothing, so the only thing this route decides is whether this
 * caller may export this student; the producer decides every field again when
 * it draws the page.
 */
export function registerStudentProfileExportRoute(
  app: FastifyInstance,
  deps: ModuleDependencies,
): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/students/:studentId/export-profile',
    permission: 'students.export',
    body: StudentProfileExportRequest,
    response: StudentExportJob,
    successStatus: 202,
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // The route gate only proves the caller exports somebody. A student
        // they may not export answers exactly like one who is not there, so
        // holding the permission never reveals which students exist.
        const decision = await decideResource(
          conn,
          context,
          'students.export',
          'student',
          studentId,
        )
        if (!decision.allowed) {
          throw new ApiFailure(
            decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND',
          )
        }

        // One audit row for the request, written by the helper below. The
        // production writes none, and the download writes its own.
        const jobId = await insertExportJob(conn, context, {
          kind: 'student_profile',
          permission: 'students.export',
          criteria: { studentId },
          summary: 'Requested one student record as a document.',
        })
        // A single record is always small, so the file is made here and the
        // answer already names something to download.
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: 1 })
      })
    },
  })
}
