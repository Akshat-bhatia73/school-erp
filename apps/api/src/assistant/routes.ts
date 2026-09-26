import type { FastifyInstance } from 'fastify'
import { AssistantStatus, AssistantTurnRequest } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { assertUuidParam } from '../modules/shared/errors.ts'
import { protectedRoute, protectedStreamRoute } from '../modules/shared/route.ts'
import { availability } from './limits.ts'
import { suggestionsFor } from './prompt.ts'
import { registerAssistantSettingsRoutes } from './settings.ts'
import { registerAssistantThreadRoutes } from './threads.ts'
import { registerAssistantProposalRoutes } from './proposals/routes.ts'
import { runTurn, type AssistantDependencies } from './turn.ts'

export type { AssistantDependencies }

/**
 * The assistant's routes (Task 24). They read no school table of their own:
 * a question's tools call the ordinary protected routes as the person. What
 * lives here is the person's own conversations and the changes proposed in
 * them, the switches and the counts. A confirmed change goes to the real
 * write route as the person.
 * See docs/assistant/ARCHITECTURE.md.
 */
export function registerAssistantRoutes(app: FastifyInstance, deps: AssistantDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/assistant/status',
    permission: 'ai_assistant.use',
    response: AssistantStatus,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const allowed = await availability(conn, context, deps.config)
        return {
          available: allowed.available,
          ...(allowed.reason === undefined ? {} : { reason: allowed.reason }),
          questionsLeftToday: allowed.questionsLeftToday,
          suggestions: suggestionsFor(context.roleKeys),
        }
      }),
  })

  registerAssistantThreadRoutes(app, deps)
  registerAssistantProposalRoutes(app, deps)

  protectedStreamRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/assistant/threads/:threadId/turns',
    permission: 'ai_assistant.use',
    body: AssistantTurnRequest,
    handler: async ({ context, body, param, request, reply }) =>
      runTurn(deps, {
        context,
        body,
        threadId: assertUuidParam(param('threadId')),
        request,
        reply,
      }),
  })

  registerAssistantSettingsRoutes(app, deps)
}
