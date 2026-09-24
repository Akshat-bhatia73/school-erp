import type { FastifyInstance } from 'fastify'
import { MessageExportJob } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { insertExportJob } from '../../exports/jobs.ts'
import { createAndMaybeProduce } from '../../exports/run.ts'
import { ApiFailure, assertUuidParam, protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import { decideMessage, readsAsSender, recipientPlan } from './shared-reads.ts'
import { sql } from 'drizzle-orm'

/**
 * The delivery record of one message as a file. The route only decides that
 * this caller may export the message and counts the rows; the producer reads
 * the recipient rows again under the same person's own plans when it makes
 * the bytes.
 */
export function registerMessageExportRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages/:messageId/export',
    permission: 'communication.export',
    response: MessageExportJob,
    successStatus: 202,
    handler: async ({ context, param }) => {
      const messageId = assertUuidParam(param('messageId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A message this caller may not export answers exactly like one that
        // is not there, so holding the permission never reveals what exists.
        const message = await decideMessage(conn, context, 'communication.export', messageId)
        if (!(await readsAsSender(conn, context, message))) throw new ApiFailure('RESOURCE_NOT_FOUND')

        const predicate = await recipientPlan(conn, context)
        const counted = await conn.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM message_recipients
               WHERE ${predicate} AND message_recipients.message_id = ${messageId}::uuid`,
        )
        const rows = Number(counted.rows[0]?.count ?? 0)

        const jobId = await insertExportJob(conn, context, {
          kind: 'message_delivery',
          permission: 'communication.export',
          criteria: { messageId },
          summary: "Requested a message's delivery record as a file.",
          safeChanges: { messageId, rows },
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: rows })
      })
    },
  })
}
