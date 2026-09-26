import type { FastifyInstance } from 'fastify'
import {
  AssistantProposalStates,
  ConfirmAssistantProposalRequest,
  ConfirmAssistantProposalResponse,
  type AssistantProposalPreview,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { seal } from '../../modules/shared/crypto.ts'
import { assertUuidParam, requireFound } from '../../modules/shared/errors.ts'
import { protectedRoute } from '../../modules/shared/route.ts'
import type { TenantConnection } from '../../modules/shared/audit.ts'
import { getByPath, routeGetter, routeWriter, type WriteAnswer } from '../inject.ts'
import { ownThread } from '../threads.ts'
import { switchedOff } from '../limits.ts'
import type { AssistantDependencies } from '../turn.ts'
import { proposeToolNamed } from './registry.ts'
import type { AnyProposeTool } from './types.ts'
import {
  decide,
  digestOf,
  expireLapsed,
  ownProposal,
  previewOf,
  proposalOf,
  stableJson,
  threadProposals,
  type Decision,
  type ProposalRow,
} from './store.ts'

/** Said on a card when the record moved after the assistant read it. */
export const STALE_OUTCOME = 'This changed after the assistant read it. Ask again to get a fresh copy.'
/** Said on a card when the write route refused the person. */
export const REFUSED_OUTCOME = 'You cannot make this change.'
const GONE_OUTCOME = 'This change can no longer be made from here.'
const FAILED_OUTCOME = 'The change could not be saved. Nothing was changed.'

/**
 * A preview the person must fix before it can be written: the tool's own
 * plain sentence, sent as the message of a 400 INVALID_REQUEST. The proposal
 * stays open so the card can be corrected and confirmed again.
 */
export class ProposalProblem extends Error {
  constructor(readonly problem: string) {
    super('proposal problem')
    this.name = 'ProposalProblem'
  }
}

type Conn = Pick<TenantConnection, 'client'>

/** The tool behind a proposal: the test list when one is given, else the registry. */
function toolFor(deps: AssistantDependencies, name: string): AnyProposeTool | undefined {
  if (deps.assistantProposeTools) return deps.assistantProposeTools.find((tool) => tool.name === name)
  return proposeToolNamed(name)
}

/** What a refused write means on the card. */
function refusedWrite(answer: Extract<WriteAnswer, { ok: false }>): Decision {
  if (answer.code === 'ACCESS_DENIED' || answer.code === 'RESOURCE_NOT_FOUND') {
    return { status: 'failed', outcome: REFUSED_OUTCOME }
  }
  // Someone else saved first: the same as a record that moved.
  if (answer.code === 'VERSION_CONFLICT') return { status: 'stale', outcome: STALE_OUTCOME }
  return { status: 'failed', outcome: answer.message ?? FAILED_OUTCOME }
}

interface ConfirmInput {
  readonly deps: AssistantDependencies
  readonly context: RequestContext
  readonly conn: Conn
  readonly row: ProposalRow
  readonly edited: AssistantProposalPreview
  readonly get: ReturnType<typeof routeGetter>
  readonly write: ReturnType<typeof routeWriter>
}

/**
 * Confirm one open proposal, in order: the tool still exists; the edited
 * preview is the same change as the original with only its editable fields
 * moved; the tool turns it into one write; the check route answers exactly
 * as it did when the proposal was made; then the write goes to the real
 * route as the person. Returns the edited preview as it was written, or
 * throws when nothing may be written at all.
 */
async function confirm(input: ConfirmInput): Promise<{ row: ProposalRow; shown?: AssistantProposalPreview }> {
  const { deps, context, conn, row, get, write } = input
  const key = deps.config.DATA_ENCRYPTION_KEY
  const tool = toolFor(deps, row.tool_name)
  if (!tool) return { row: await decide(conn, context, row, { status: 'failed', outcome: GONE_OUTCOME }) }

  const schema = tool.preview as unknown as { safeParse(value: unknown): { success: true; data: AssistantProposalPreview } | { success: false } }
  const original = schema.safeParse(previewOf(row, key).preview)
  const edited = schema.safeParse(input.edited)
  if (!original.success || !edited.success) throw new ApiFailure('INVALID_REQUEST')
  if (edited.data.kind !== original.data.kind || edited.data.kind !== row.kind) throw new ApiFailure('INVALID_REQUEST')

  const same = tool as unknown as {
    sameTarget(original: AssistantProposalPreview, edited: AssistantProposalPreview): boolean
    write(preview: AssistantProposalPreview): { method: 'POST' | 'PUT' | 'PATCH'; path: string; body: unknown } | { problem: string }
    describeDone(preview: AssistantProposalPreview): string
  }
  if (!same.sameTarget(original.data, edited.data)) throw new ApiFailure('INVALID_REQUEST')
  const request = same.write(edited.data)
  if ('problem' in request) throw new ProposalProblem(request.problem)

  // The record as it stands now must be the record the proposal was made
  // from; anything else is somebody else's change, which is never overwritten.
  const check = await getByPath(get, row.check_path)
  if (!check.ok) {
    if (check.status === 403 || check.status === 404) {
      return { row: await decide(conn, context, row, { status: 'failed', outcome: REFUSED_OUTCOME }) }
    }
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
  if (digestOf(check.body) !== row.check_digest) {
    return { row: await decide(conn, context, row, { status: 'stale', outcome: STALE_OUTCOME }) }
  }

  const answer = await write(request)
  if (!answer.ok) return { row: await decide(conn, context, row, refusedWrite(answer)) }
  const updated = await decide(conn, context, row, {
    status: 'done',
    outcome: same.describeDone(edited.data),
    writeRequestId: answer.requestId,
    edited: stableJson(edited.data) !== stableJson(original.data),
    confirmedPreviewSealed: seal(JSON.stringify(edited.data), key),
  })
  return { row: updated, shown: edited.data }
}

/**
 * The proposal routes (24b): the states of a conversation's proposals, and
 * the person's Confirm and Discard. They write no audit row of their own: a
 * confirmed change is written by the real route, which writes its own, and
 * the proposal keeps that request's id. See docs/assistant/ARCHITECTURE.md
 * section 5.
 *
 * They live in a scope of their own so a tool's plain-English problem ("Add
 * a reason for changing a saved register.") can be the message of a 400;
 * every other error goes on to the application's handler unchanged.
 */
export function registerAssistantProposalRoutes(app: FastifyInstance, deps: AssistantDependencies): void {
  const key = deps.config.DATA_ENCRYPTION_KEY

  void app.register(async (scope) => {
    scope.setErrorHandler((error, request, reply) => {
      if (!(error instanceof ProposalProblem)) throw error
      const message = error.problem.trim().slice(0, 500)
      request.sentErrorCode = 'INVALID_REQUEST'
      request.log.warn({ requestId: request.id, code: 'INVALID_REQUEST' }, 'request failed')
      return reply.status(400).send({
        error: {
          code: 'INVALID_REQUEST',
          message: message.length > 0 ? message : 'Some details are missing or invalid.',
          requestId: request.id,
        },
      })
    })

    protectedRoute(scope, deps, {
      method: 'GET',
      path: '/api/schools/:schoolId/assistant/threads/:threadId/proposals',
      permission: 'ai_assistant.use',
      response: AssistantProposalStates,
      handler: async ({ context, param }) => {
        const threadId = assertUuidParam(param('threadId'))
        return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
          requireFound(await ownThread(conn, context, threadId))
          await expireLapsed(conn, context, threadId)
          const rows = await threadProposals(conn, context, threadId)
          return { items: rows.map((row) => proposalOf(row, key)) }
        })
      },
    })

    protectedRoute(scope, deps, {
      method: 'POST',
      path: '/api/schools/:schoolId/assistant/proposals/:proposalId/confirm',
      // The write route decides the real permission when the change is sent.
      permission: 'ai_assistant.use',
      body: ConfirmAssistantProposalRequest,
      response: ConfirmAssistantProposalResponse,
      handler: async ({ context, body, param, request }) => {
        const proposalId = assertUuidParam(param('proposalId'))
        const get = routeGetter(request, context.schoolId)
        const write = routeWriter(request, context.schoolId)
        return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
          // Locked to the end: a second click waits here and then finds the
          // proposal already decided, so a change is written once.
          const row = requireFound(await ownProposal(conn, context, proposalId, true))
          if (row.lapsed) return { proposal: proposalOf(await decide(conn, context, row, { status: 'expired' }), key) }
          if (row.status !== 'open') return { proposal: proposalOf(row, key) }
          // Switched off since the proposal was made: nothing is written, and
          // the proposal stays open until it expires or is switched back on.
          if ((await switchedOff(conn, context, deps.config)) !== null) throw new ApiFailure('FEATURE_DISABLED')
          const result = await confirm({ deps, context, conn, row, edited: body.preview, get, write })
          return { proposal: proposalOf(result.row, key, result.shown) }
        })
      },
    })

    protectedRoute(scope, deps, {
      method: 'POST',
      path: '/api/schools/:schoolId/assistant/proposals/:proposalId/dismiss',
      permission: 'ai_assistant.use',
      response: ConfirmAssistantProposalResponse,
      handler: async ({ context, param }) => {
        const proposalId = assertUuidParam(param('proposalId'))
        return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
          const row = requireFound(await ownProposal(conn, context, proposalId, true))
          if (row.lapsed) return { proposal: proposalOf(await decide(conn, context, row, { status: 'expired' }), key) }
          if (row.status !== 'open') return { proposal: proposalOf(row, key) }
          return { proposal: proposalOf(await decide(conn, context, row, { status: 'dismissed' }), key) }
        })
      },
    })
  })
}
