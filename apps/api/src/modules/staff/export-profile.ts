import type { FastifyInstance } from 'fastify'
import { StaffExportJob, StaffProfileExportRequest } from '@erp/contracts'
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
 * One staff record as a document. The same shape as the student profile
 * export: the path names the record, the body carries nothing, and the
 * producer decides each block again when it draws the page.
 */
export function registerStaffProfileExportRoute(
  app: FastifyInstance,
  deps: ModuleDependencies,
): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/staff/:staffId/export-profile',
    permission: 'staff.export',
    body: StaffProfileExportRequest,
    response: StaffExportJob,
    successStatus: 202,
    handler: async ({ context, param }) => {
      const staffId = assertUuidParam(param('staffId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A person this caller may not export answers like a person who is not
        // there, so the route cannot be used to probe the directory.
        const decision = await decideResource(conn, context, 'staff.export', 'staff', staffId)
        if (!decision.allowed) {
          throw new ApiFailure(
            decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND',
          )
        }

        const jobId = await insertExportJob(conn, context, {
          kind: 'staff_profile',
          permission: 'staff.export',
          criteria: { staffId },
          summary: 'Requested one staff record as a document.',
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: 1 })
      })
    },
  })
}
