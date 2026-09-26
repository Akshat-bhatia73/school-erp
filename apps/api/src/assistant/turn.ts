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
  type SystemModelMessage,
  type UIMessage,
} from 'ai'
import {
  ASSISTANT_MAX_TOOL_CALLS,
  type AssistantTurnRequest,
  type AssistantUnavailableReason,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { AuthorizationError } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../http/errors.ts'
import { reportError } from '../observability.ts'
import { seal } from '../modules/shared/crypto.ts'
import { writeAudit } from '../modules/shared/audit.ts'
import type { ModuleDependencies } from '../modules/shared/route.ts'
import type { AnyReadTool, ToolCallContext } from './tools/types.ts'
import { availability } from './limits.ts'
import { instructionsFor } from './prompt.ts'
import { assistantModel } from './model.ts'
import {
  HIDDEN_RESULT,
  hideUnoffered,
  keepMessage,
  keptMessages,
  offeredProposeTools,
  offeredTools,
  ownThread,
  titleFrom,
  type KeptMessage,
} from './threads.ts'
import { buildProposeToolSet, buildToolSet, ToolLedger, type SaveProposal } from './toolset.ts'
import { routeGetter } from './inject.ts'
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

/** The messages of a thread the model sees again with a new question, at most. */
const HISTORY_MESSAGES = 20
/**
 * And at most about this many tokens of them, counted roughly as four
 * characters a token. The oldest go first; the new question always stays.
 */
export const HISTORY_TOKEN_BUDGET = 24_000
/** The longest answer the model may write to one question, in tokens. */
export const MAX_OUTPUT_TOKENS = 1500
/** How long a turn holds its conversation; longer than the turn may run, so a crashed turn's hold runs out. */
const ANSWERING_LEASE_MINUTES = 5
/** A usage row still 'started' this long after it began belongs to a turn that died; it is settled as failed. */
const STARTED_STALE_MINUTES = 10
/** Told to the model, for this question only, when older messages were left out. */
const TRIMMED_NOTE =
  'Earlier messages in this conversation are not shown to you. If the question depends on them, ask the person to repeat what you need.'
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

/**
 * The messages the model reads again: the newest ones that fit
 * HISTORY_TOKEN_BUDGET, sized roughly as their JSON length over four. The
 * last message, the new question, always stays, and the copy starts at a
 * question so it never opens halfway through an answer. `trimmed` says
 * whether anything was left out.
 */
export function trimToBudget<T extends { readonly role: string }>(
  messages: readonly T[],
  budget = HISTORY_TOKEN_BUDGET,
): { messages: T[]; trimmed: boolean } {
  const sizes = messages.map((message) => Math.ceil(JSON.stringify(message).length / 4))
  let start = 0
  let total = sizes.reduce((sum, size) => sum + size, 0)
  while (start < messages.length - 1 && total > budget) {
    total -= sizes[start]!
    start += 1
  }
  if (start > 0) {
    while (start < messages.length - 1 && messages[start]!.role !== 'user') start += 1
  }
  return { messages: messages.slice(start), trimmed: start > 0 }
}

interface TurnInput {
  readonly context: RequestContext
  readonly body: AssistantTurnRequest
  readonly threadId: string
  readonly request: FastifyRequest
  readonly reply: FastifyReply
}

/**
 * Where a "Try again" picks up: the index of the retried question in the
 * kept history, when it is the newest question there and carries the same
 * words; null for anything else, which is refused as a repeat.
 */
export function retryPoint(
  history: readonly Pick<KeptMessage, 'id' | 'role' | 'parts'>[],
  body: { readonly messageId: string; readonly text: string },
): number | null {
  let at = -1
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]!.role === 'user') {
      at = index
      break
    }
  }
  if (at < 0) return null
  const newest = history[at]!
  const words = newest.parts.map((part) => (part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
  return newest.id === body.messageId && words === body.text ? at : null
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
    // One answer at a time per conversation: a second tab asking while the
    // first answer is still being written is told to wait, and nothing is
    // counted for it. The row lock makes two starting at once take turns here.
    const lease = await conn.client.query<{ busy: boolean }>(
      `SELECT COALESCE(answering_until > now(), false) AS busy FROM assistant_threads
        WHERE school_id = $1 AND membership_id = $2 AND id = $3 FOR UPDATE`,
      [context.schoolId, context.membershipId, threadId],
    )
    if (lease.rows[0]?.busy) throw new ApiFailure('NOT_ALLOWED_YET', undefined, 'assistant_still_answering')
    // One question at a time per school from here to the commit, so the
    // counts below and the row that follows them cannot interleave.
    await conn.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `assistant_usage:${context.schoolId}`,
    ])
    // A turn that died before it could finish (the function was stopped, the
    // database was unreachable twice) left its row 'started'. It still counts
    // as a question asked; it is settled here as failed so the counts by
    // outcome stay true.
    await conn.client.query(
      `UPDATE assistant_usage SET status = 'failed', finished_at = now()
        WHERE school_id = $1 AND status = 'started'
          AND created_at < now() - make_interval(mins => $2)`,
      [context.schoolId, STARTED_STALE_MINUTES],
    )
    const allowed = await availability(conn, context, deps.config)
    if (!allowed.available) throw refusalFor(allowed.reason)

    const repeated = await conn.client.query(
      `SELECT 1 FROM assistant_messages WHERE school_id = $1 AND thread_id = $2 AND message_key = $3`,
      [context.schoolId, threadId, body.messageId],
    )
    const history = await keptMessages(conn, context, threadId, key, HISTORY_MESSAGES)
    // A question already kept may only come again as "Try again": the newest
    // question in the conversation, word for word. It is answered afresh from
    // the conversation as it stood when it was asked, and not kept twice.
    const retried = repeated.rows.length > 0 ? retryPoint(history, body) : null
    if (repeated.rows.length > 0 && retried === null) throw new ApiFailure('INVALID_REQUEST')

    const usage = await conn.client.query<{ id: string }>(
      `INSERT INTO assistant_usage (school_id, membership_id, role_keys, school_day, model)
       VALUES ($1, $2, $3::text[], $4::date, $5) RETURNING id`,
      [context.schoolId, context.membershipId, [...context.roleKeys], allowed.schoolDay, modelId],
    )
    const usageId = usage.rows[0]?.id
    if (!usageId) throw new ApiFailure('SERVICE_UNAVAILABLE')
    await conn.client.query(
      `UPDATE assistant_threads SET answering_until = now() + make_interval(mins => $4)
        WHERE school_id = $1 AND membership_id = $2 AND id = $3`,
      [context.schoolId, context.membershipId, threadId, ANSWERING_LEASE_MINUTES],
    )

    // Where each proposal in the conversation stands now, for the model's copy.
    const proposals = new Map(
      (await threadProposals(conn, context, threadId)).map((row) => [row.id, forModelOf(row, key)] as const),
    )
    const question: KeptMessage = { id: body.messageId, role: 'user', parts: [{ type: 'text', text: body.text }] }
    if (retried === null) await keepMessage(conn, context, threadId, question, key)
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
      messages: [...history.slice(0, retried ?? history.length).map(({ id, role, parts }) => ({ id, role, parts })), question],
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

  /** One attempt at finishing: the answer, the usage row, the hold on the conversation and the audit row. */
  const finishOnce = (status: UsageStatus, answer?: UIMessage): Promise<void> =>
    withTenantTransaction(deps.pools.runtime, context, async (conn) => {
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
            SET status = $3, model = $4, tool_calls = $5, refused_calls = $6, failed_calls = $7,
                input_tokens = $8, output_tokens = $9, finished_at = now()
          WHERE school_id = $1 AND id = $2`,
        [
          context.schoolId,
          setup.usageId,
          status,
          modelId,
          ledger.calls,
          ledger.refused,
          ledger.failed,
          tokens.input,
          tokens.output,
        ],
      )
      await conn.client.query(
        `UPDATE assistant_threads SET answering_until = NULL
          WHERE school_id = $1 AND membership_id = $2 AND id = $3`,
        [context.schoolId, context.membershipId, threadId],
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
          failed: ledger.failed,
          model: modelId,
          inputTokens: tokens.input,
          outputTokens: tokens.output,
          status,
        },
      })
    })

  /**
   * Keep the answer, finish the usage row, let go of the conversation and
   * write the one audit row, all in one transaction. Runs once, and tries that
   * transaction a second time if the first fails.
   */
  const finish = async (status: UsageStatus, answer?: UIMessage): Promise<void> => {
    if (finished) return
    finished = true
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await finishOnce(status, answer)
        return
      } catch (error) {
        lastError = error
      }
    }
    // The turn id and the error's kind only: never a prompt, an answer or a
    // tool result. The row stays 'started' and the next turn in the school
    // settles it; the conversation's hold runs out by itself.
    request.log.error({ requestId: request.id, turnId: setup.usageId }, 'assistant turn could not be finished')
    reportError(new Error(`assistant turn ${setup.usageId} could not be finished (${errorKind(lastError)})`), {
      requestId: request.id,
      route: 'assistant turn',
    })
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
    // The model's copy tells it where each earlier proposal stands now (done,
    // stale, dismissed…); what the browser keeps and gets back is unchanged.
    // An old result from a tool the person is no longer offered is replaced
    // by one plain sentence, so a permission taken away also takes away what
    // it once showed. That sentence is plain text: with no tool of that name
    // on offer, the SDK sends it as it is.
    const replayed = hideUnoffered(
      replayProposals(setup.messages, setup.proposals),
      new Set(Object.keys(offered)),
      HIDDEN_RESULT,
    )
    const history = trimToBudget(replayed)
    const messages = await convertToModelMessages(history.messages as unknown as UIMessage[], {
      tools: offered,
      ignoreIncompleteToolCalls: true,
    })
    const rules = instructionsFor({
      displayName: request.verified?.user.name ?? 'a member of the school',
      roleKeys: context.roleKeys,
      schoolName: setup.schoolName,
      today: setup.today,
      academicYearName: setup.academicYearName,
    })
    const instructions: string | SystemModelMessage[] = history.trimmed
      ? [
          { role: 'system', content: rules },
          { role: 'system', content: TRIMMED_NOTE },
        ]
      : rules

    // Stops when the person closes the page, and after about four minutes.
    const stop = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) stop.abort()
    })
    const abortSignal = AbortSignal.any([stop.signal, AbortSignal.timeout(TURN_TIMEOUT_MS)])

    const result = streamText({
      model,
      instructions,
      messages,
      tools: offered,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
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

/** A provider's own error code: one word of capitals, letters and underscores ("RESOURCE_EXHAUSTED"). */
const PROVIDER_CODE = /^[A-Za-z][A-Za-z_]{2,39}$/
/** A provider's request id, for asking the provider about one call. */
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9:._-]{1,128}$/
const REQUEST_ID_HEADERS = ['x-request-id', 'x-vercel-id', 'x-goog-request-id', 'request-id'] as const

/**
 * Why the model provider refused, for the log: its HTTP status, its own error
 * code when it is one short word, and its request id. Never its message or
 * any other free text, which could quote what it was sent.
 */
export function providerFailure(error: unknown): {
  providerStatus?: number
  providerCode?: string
  providerRequestId?: string
} {
  const last = RetryError.isInstance(error) ? error.lastError : error
  if (!APICallError.isInstance(last)) return {}
  let code: string | undefined
  try {
    const body = JSON.parse(last.responseBody ?? '') as { error?: { status?: unknown; code?: unknown; type?: unknown } }
    code = [body.error?.status, body.error?.code, body.error?.type].find(
      (value): value is string => typeof value === 'string' && PROVIDER_CODE.test(value),
    )
  } catch {
    code = undefined
  }
  const headers = last.responseHeaders ?? {}
  const requestId = REQUEST_ID_HEADERS.map((name) => headers[name]).find(
    (value): value is string => typeof value === 'string' && PROVIDER_REQUEST_ID.test(value),
  )
  return {
    ...(last.statusCode === undefined ? {} : { providerStatus: last.statusCode }),
    ...(code === undefined ? {} : { providerCode: code }),
    ...(requestId === undefined ? {} : { providerRequestId: requestId }),
  }
}
