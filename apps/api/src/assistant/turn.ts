import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import {
  APICallError,
  RetryError,
  consumeStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type UIMessage,
} from 'ai'
import {
  ASSISTANT_MAX_TOOL_CALLS,
  type AssistantTurnRequest,
  type AssistantUnavailableReason,
  type PermissionKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { AuthorizationError } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../http/errors.ts'
import { reportError } from '../observability.ts'
import { seal } from '../modules/shared/crypto.ts'
import { writeAudit } from '../modules/shared/audit.ts'
import type { ModuleDependencies } from '../modules/shared/route.ts'
import { READ_TOOLS, toolsFor } from './tools/registry.ts'
import type { AnyReadTool, ToolCallContext } from './tools/types.ts'
import { availability } from './limits.ts'
import { instructionsFor } from './prompt.ts'
import { assistantModel } from './model.ts'
import { keepMessage, keptMessages, ownThread, titleFrom, type KeptMessage } from './threads.ts'
import { buildProposeToolSet, buildToolSet, ToolLedger, type SaveProposal } from './toolset.ts'
import { routeGetter } from './inject.ts'
import { PROPOSE_TOOLS, proposeToolsFor } from './proposals/registry.ts'
import type { AnyProposeTool } from './proposals/types.ts'
import { forModelOf, replayProposals, saveProposal, threadProposals } from './proposals/store.ts'

export interface AssistantDependencies extends ModuleDependencies {
  /**
   * Tests only: a scripted model in place of the real one. Never set in
   * production, where the model comes from ASSISTANT_PROVIDER and ASSISTANT_MODEL.
   */
  readonly assistantModel?: LanguageModel
  /** Tests only: the read tools on offer in place of the registry's. */
  readonly assistantTools?: readonly AnyReadTool[]
  /** Tests only: the change tools on offer, and confirmable, in place of the registry's. */
  readonly assistantProposeTools?: readonly AnyProposeTool[]
}

/** The messages of a thread the model sees again with a new question. */
const HISTORY_MESSAGES = 20
/** About four minutes, then the answer stops and says so. */
const TURN_TIMEOUT_MS = 240_000
/** What the browser shows when a turn fails. Never the error itself. */
const FAILED_TEXT = 'Something went wrong while answering. Please try again.'
const BUSY_TEXT = 'The assistant is busy right now. Please try again in a few minutes.'

type UsageStatus = 'answered' | 'failed' | 'stopped'

function refusalFor(reason: AssistantUnavailableReason | undefined): ApiFailure {
  if (reason === 'daily_limit' || reason === 'monthly_limit') return new ApiFailure('RATE_LIMITED')
  return new ApiFailure('FEATURE_DISABLED')
}

function modelName(model: LanguageModel): string {
  return typeof model === 'string' ? model : `${model.provider}/${model.modelId}`
}

/** The tools this person is offered: those whose route permission they hold somewhere. */
function offeredTools(deps: AssistantDependencies, capabilities: ReadonlySet<PermissionKey>): readonly AnyReadTool[] {
  if (deps.assistantTools) return deps.assistantTools.filter((tool) => capabilities.has(tool.permission))
  return toolsFor(capabilities)
}

/** The change tools this person is offered: those whose write permission they hold somewhere. */
function offeredProposeTools(
  deps: AssistantDependencies,
  capabilities: ReadonlySet<PermissionKey>,
): readonly AnyProposeTool[] {
  if (deps.assistantProposeTools) return deps.assistantProposeTools.filter((tool) => capabilities.has(tool.permission))
  return proposeToolsFor(capabilities)
}

interface TurnInput {
  readonly context: RequestContext
  readonly body: AssistantTurnRequest
  readonly threadId: string
  readonly request: FastifyRequest
  readonly reply: FastifyReply
}

/**
 * One question. The switches are read again here, the question is counted
 * before it is answered (so two at once cannot both slip under a limit), the
 * words are sealed before they are kept, and the answer is streamed as the AI
 * SDK's UI message stream. When it ends, however it ends, the answer is kept,
 * the usage row is finished and exactly one audit row is written, holding tool
 * names and counts and never the words.
 */
export async function runTurn(deps: AssistantDependencies, input: TurnInput): Promise<Response> {
  const { context, body, threadId, request, reply } = input
  const key = deps.config.DATA_ENCRYPTION_KEY
  const chosen = assistantModel(deps.config)
  const model: LanguageModel = deps.assistantModel ?? chosen.model
  const modelId = modelName(model)

  const setup = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    const thread = await ownThread(conn, context, threadId)
    if (!thread) throw new ApiFailure('RESOURCE_NOT_FOUND')
    // One question at a time per school from here to the commit, so the
    // counts below and the row that follows them cannot interleave.
    await conn.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `assistant_usage:${context.schoolId}`,
    ])
    const allowed = await availability(conn, context, deps.config)
    if (!allowed.available) throw refusalFor(allowed.reason)

    const repeated = await conn.client.query(
      `SELECT 1 FROM assistant_messages WHERE school_id = $1 AND thread_id = $2 AND message_key = $3`,
      [context.schoolId, threadId, body.messageId],
    )
    if (repeated.rows.length > 0) throw new ApiFailure('INVALID_REQUEST')

    const usage = await conn.client.query<{ id: string }>(
      `INSERT INTO assistant_usage (school_id, membership_id, role_keys, school_day, model)
       VALUES ($1, $2, $3::text[], $4::date, $5) RETURNING id`,
      [context.schoolId, context.membershipId, [...context.roleKeys], allowed.schoolDay, modelId],
    )
    const usageId = usage.rows[0]?.id
    if (!usageId) throw new ApiFailure('SERVICE_UNAVAILABLE')

    const history = await keptMessages(conn, context, threadId, key, HISTORY_MESSAGES)
    // Where each proposal in the conversation stands now, for the model's copy.
    const proposals = new Map(
      (await threadProposals(conn, context, threadId)).map((row) => [row.id, forModelOf(row, key)] as const),
    )
    const question: KeptMessage = { id: body.messageId, role: 'user', parts: [{ type: 'text', text: body.text }] }
    await keepMessage(conn, context, threadId, question, key)
    if (thread.title_sealed === null) {
      await conn.client.query(
        `UPDATE assistant_threads SET title_sealed = $4
          WHERE school_id = $1 AND membership_id = $2 AND id = $3`,
        [context.schoolId, context.membershipId, threadId, seal(titleFrom(body.text), key)],
      )
    }

    const school = await conn.client.query<{ name: string; year_id: string | null; year_name: string | null }>(
      `SELECT s.name, y.id AS year_id, y.name AS year_name
         FROM schools s
         LEFT JOIN LATERAL (
           SELECT id, name FROM academic_years
            WHERE school_id = s.id AND status = 'current'
            ORDER BY start_date DESC, id LIMIT 1) y ON true
        WHERE s.id = $1`,
      [context.schoolId],
    )
    const row = school.rows[0]
    if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')
    return {
      usageId,
      today: allowed.schoolDay,
      messages: [...history.map(({ id, role, parts }) => ({ id, role, parts })), question],
      proposals,
      schoolName: row.name,
      academicYearId: row.year_id,
      academicYearName: row.year_name,
    }
  })

  const ledger = new ToolLedger()
  const tokens = { input: 0, output: 0 }
  let errored = false
  let finished = false

  /** Keep the answer, finish the usage row, write the one audit row. Runs once. */
  const finish = async (status: UsageStatus, answer?: UIMessage): Promise<void> => {
    if (finished) return
    finished = true
    try {
      await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        if (answer && answer.parts.length > 0) {
          const id = /^[A-Za-z0-9_-]{1,128}$/.test(answer.id) ? answer.id : randomUUID()
          await keepMessage(
            conn,
            context,
            threadId,
            { id, role: 'assistant', parts: answer.parts as unknown as Record<string, unknown>[] },
            key,
          )
        }
        await conn.client.query(
          `UPDATE assistant_usage
              SET status = $3, model = $4, tool_calls = $5, refused_calls = $6,
                  input_tokens = $7, output_tokens = $8, finished_at = now()
            WHERE school_id = $1 AND id = $2`,
          [context.schoolId, setup.usageId, status, modelId, ledger.calls, ledger.refused, tokens.input, tokens.output],
        )
        await writeAudit(conn, context, {
          action: 'ai_assistant.use',
          targetType: 'assistant_turn',
          targetId: setup.usageId,
          summary: 'Asked the assistant a question.',
          safeChanges: {
            tools: [...ledger.names],
            toolCalls: ledger.calls,
            refused: ledger.refused,
            model: modelId,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
            status,
          },
        })
      })
    } catch (error) {
      // The turn id and the error's kind only: never a prompt, an answer or a
      // tool result.
      request.log.error({ requestId: request.id, turnId: setup.usageId }, 'assistant turn could not be finished')
      reportError(new Error(`assistant turn ${setup.usageId} could not be finished (${errorKind(error)})`), {
        requestId: request.id,
        route: 'assistant turn',
      })
    }
  }

  try {
    const capabilities = new Set(await deps.authz.capabilities(context))
    const toolContext: ToolCallContext = {
      schoolId: context.schoolId,
      today: setup.today,
      academicYearId: setup.academicYearId,
      get: routeGetter(request, context.schoolId),
    }
    // A proposal is saved in its own short transaction, in this thread and
    // as this person; the change tool itself never touches the database.
    const save: SaveProposal = (tool, draft, checkDigest) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) =>
        saveProposal(conn, context, { threadId, tool, draft, checkDigest }, key),
      )
    const offered = {
      ...buildToolSet(offeredTools(deps, capabilities), { context: toolContext, ledger }),
      ...buildProposeToolSet(offeredProposeTools(deps, capabilities), { context: toolContext, ledger, save }),
    }
    // Replaying a kept conversation needs every tool's model output, including
    // tools this person is no longer offered, so the model reads only the
    // trimmed part of an old result.
    const described = {
      ...buildToolSet(deps.assistantTools ?? READ_TOOLS),
      ...buildProposeToolSet(deps.assistantProposeTools ?? PROPOSE_TOOLS),
      ...offered,
    }
    // The model's copy tells it where each earlier proposal stands now (done,
    // stale, dismissed…); what the browser keeps and gets back is unchanged.
    const messages = await convertToModelMessages(
      replayProposals(setup.messages, setup.proposals) as unknown as UIMessage[],
      { tools: described, ignoreIncompleteToolCalls: true },
    )

    // Stops when the person closes the page, and after about four minutes.
    const stop = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) stop.abort()
    })
    const abortSignal = AbortSignal.any([stop.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)])

    const result = streamText({
      model,
      instructions: instructionsFor({
        displayName: request.verified?.user.name ?? 'a member of the school',
        roleKeys: context.roleKeys,
        schoolName: setup.schoolName,
        today: setup.today,
        academicYearName: setup.academicYearName,
      }),
      messages,
      tools: offered,
      stopWhen: isStepCount(ASSISTANT_MAX_TOOL_CALLS),
      // One retry, not the default two: a provider that said "too many" a
      // second ago says it again, and each retry spends the per-minute quota.
      maxRetries: 1,
      // The last step, or once the calls are spent, has no tools, so the turn
      // ends with words rather than an unanswered call.
      prepareStep: ({ stepNumber }) =>
        stepNumber >= ASSISTANT_MAX_TOOL_CALLS - 1 || ledger.calls >= ASSISTANT_MAX_TOOL_CALLS
          ? { activeTools: [] }
          : undefined,
      providerOptions: chosen.providerOptions,
      abortSignal,
      onStepEnd: (step) => {
        tokens.input += step.usage.inputTokens ?? 0
        tokens.output += step.usage.outputTokens ?? 0
      },
      onError: ({ error }) => {
        errored = true
        request.log.warn(
          { requestId: request.id, turnId: setup.usageId, kind: errorKind(error), ...providerFailure(error) },
          'assistant turn failed',
        )
      },
    })

    let failure: string | undefined
    const stream = toUIMessageStream({
      stream: result.stream,
      tools: offered,
      originalMessages: setup.messages as unknown as UIMessage[],
      generateMessageId: () => randomUUID(),
      onError: (error) => {
        failure = providerFailure(error).providerStatus === 429 ? BUSY_TEXT : FAILED_TEXT
        return failure
      },
      onEnd: async ({ responseMessage, isAborted, outcome }) => {
        const status: UsageStatus = isAborted
          ? 'stopped'
          : errored || outcome.status === 'failed'
            ? 'failed'
            : 'answered'
        // A failed answer is kept with the sentence the person saw, so it
        // reads the same when the conversation is opened again.
        const kept = status === 'failed' && failure !== undefined && responseMessage
          ? { ...responseMessage, parts: [...responseMessage.parts, { type: 'text' as const, text: failure }] }
          : responseMessage
        await finish(status, kept)
      },
    })

    // The copy is read to the end even if the person leaves, so onEnd always
    // runs and the turn is always finished.
    return createUIMessageStreamResponse({ stream, consumeSseStream: consumeStream })
  } catch (error) {
    await finish('failed')
    request.log.error({ requestId: request.id, turnId: setup.usageId, kind: errorKind(error) }, 'assistant turn did not start')
    // A refusal keeps its own code (a member suspended a moment ago is
    // ACCESS_DENIED); anything else is the service's fault.
    if (error instanceof ApiFailure || error instanceof AuthorizationError) throw error
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
}

/** The error's class name, never its message, which may quote the question. */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}

/**
 * Why the model provider refused, for the log: its HTTP status and its own
 * short reason ("Quota exceeded…", "API key not valid…"). The provider's
 * error body describes the call, never the question, so no words leave here;
 * it is cut short all the same.
 */
function providerFailure(error: unknown): { providerStatus?: number; providerReason?: string } {
  const last = RetryError.isInstance(error) ? error.lastError : error
  if (!APICallError.isInstance(last)) return {}
  let reason: string | undefined
  try {
    const body = JSON.parse(last.responseBody ?? '') as { error?: { status?: unknown; message?: unknown } }
    const status = typeof body.error?.status === 'string' ? body.error.status : ''
    const message = typeof body.error?.message === 'string' ? body.error.message : ''
    reason = `${status} ${message}`.trim()
  } catch {
    reason = last.message
  }
  return {
    ...(last.statusCode === undefined ? {} : { providerStatus: last.statusCode }),
    ...(reason ? { providerReason: reason.slice(0, 300) } : {}),
  }
}
