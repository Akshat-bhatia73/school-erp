import { tool, type ToolSet } from 'ai'
import type { z } from 'zod'
import {
  ASSISTANT_MAX_TOOL_CALLS,
  AssistantProposalPreview,
  type AssistantProposal,
  type AssistantProposalToolOutput,
  type AssistantToolOutput,
} from '@erp/contracts'
import type { AnyReadTool, ReadToolOutcome, RouteAnswer, ToolCallContext } from './tools/types.ts'
import type { AnyProposeTool, PrepareOutcome, ProposalDraft } from './proposals/types.ts'
import { digestOf, isCheckPath } from './proposals/store.ts'

/**
 * What happened to the tool calls of one turn, in order. It holds tool names
 * and counts only, which is all the audit row and the usage row may carry.
 */
export class ToolLedger {
  readonly names: string[] = []
  refused = 0
  failed = 0

  get calls(): number {
    return this.names.length
  }
}

const NOT_AVAILABLE = 'Not available to you.'
const FAILED = 'That lookup failed.'

function outputOf(outcome: ReadToolOutcome): AssistantToolOutput {
  if (outcome.status !== 'ok') return { status: outcome.status }
  return {
    status: 'ok',
    ...(outcome.card === undefined ? {} : { card: outcome.card }),
    ...(outcome.source === undefined ? {} : { source: outcome.source }),
    forModel: outcome.forModel,
  }
}

/**
 * The AI SDK tool set for a list of read tools. Each tool parses the model's
 * input against the definition, runs it as the person (through `context.get`)
 * and returns the output kept in the conversation and drawn by the browser.
 * The model reads only `forModel`, or one plain sentence when the route said
 * no or failed, including when an old conversation is replayed.
 *
 * Without a context and a ledger the tools only describe themselves, which is
 * what replaying a kept conversation needs.
 */
export function buildToolSet(
  tools: readonly AnyReadTool[],
  run?: { readonly context: ToolCallContext; readonly ledger: ToolLedger },
): ToolSet {
  const set: ToolSet = {}
  for (const definition of tools) {
    const input = definition.input as unknown as z.ZodType<unknown>
    set[definition.name] = tool<unknown, AssistantToolOutput, Record<string, never>>({
      description: definition.description,
      inputSchema: input,
      execute: async (raw: unknown): Promise<AssistantToolOutput> => {
        if (!run) return { status: 'failed' }
        const { context, ledger } = run
        // The step limit ends the turn; this keeps a step with many calls in
        // it from going past the same limit.
        if (ledger.calls >= ASSISTANT_MAX_TOOL_CALLS) {
          ledger.failed += 1
          return { status: 'failed' }
        }
        ledger.names.push(definition.name)
        const parsed = input.safeParse(raw)
        if (!parsed.success) {
          ledger.failed += 1
          return { status: 'failed' }
        }
        let outcome: ReadToolOutcome
        try {
          outcome = await (definition as unknown as { run(input: unknown, context: ToolCallContext): Promise<ReadToolOutcome> }).run(
            parsed.data,
            context,
          )
        } catch {
          outcome = { status: 'failed' }
        }
        if (outcome.status === 'not_available') ledger.refused += 1
        if (outcome.status === 'failed') ledger.failed += 1
        return outputOf(outcome)
      },
      toModelOutput: ({ output }) => {
        if (output.status === 'ok') return { type: 'json', value: (output.forModel ?? null) as never }
        return { type: 'text', value: output.status === 'not_available' ? NOT_AVAILABLE : FAILED }
      },
    })
  }
  return set
}

const NOT_PREPARED = 'That could not be prepared.'

/**
 * Keeps a prepared proposal: the framework's part, which a change tool never
 * sees. Given the draft and the digest of its check route's answer, it seals
 * and saves the row and returns the proposal as the browser draws it.
 */
export type SaveProposal = (
  tool: AnyProposeTool,
  draft: ProposalDraft<AssistantProposalPreview>,
  checkDigest: string,
) => Promise<AssistantProposal>

/** A GET as one string, path then query in name order, so two spellings of one read compare equal. */
function readKey(path: string, query?: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const names = Object.keys(query ?? {})
    .filter((name) => query?.[name] !== undefined)
    .sort()
  if (names.length === 0) return path
  const search = new URLSearchParams(names.map((name) => [name, String(query?.[name])]))
  return `${path}?${search.toString()}`
}

/** The same key for a check path kept with its query in one string. */
function checkKey(pathWithQuery: string): string {
  const at = pathWithQuery.indexOf('?')
  if (at < 0) return pathWithQuery
  return readKey(pathWithQuery.slice(0, at), Object.fromEntries(new URLSearchParams(pathWithQuery.slice(at + 1))))
}

/**
 * The digest of the check route's answer that the preview was built from.
 * The tool's own reads are recorded while it prepares, so the digest is of
 * the very answer the preview came from, never of a later read that could
 * show someone else's newer save. Null when the tool never read its check
 * route, or read it twice and got two answers.
 */
function digestOfRead(reads: ReadonlyMap<string, RouteAnswer[]>, checkPath: string): string | null {
  const answers = reads.get(checkKey(checkPath)) ?? []
  if (answers.length === 0 || answers.some((answer) => !answer.ok)) return null
  const digests = new Set(answers.map((answer) => digestOf(answer.ok ? answer.body : null)))
  return digests.size === 1 ? [...digests][0]! : null
}

/**
 * The AI SDK tool set for the change tools (24b). A change tool never writes:
 * `prepare` reads through the same routes as the person and returns a draft;
 * this keeps a digest of the check route's answer the tool read and saves the
 * proposal. The browser draws it as an editable card and only
 * the person's Confirm makes the change. The model reads only `forModel`, or
 * one plain sentence when nothing could be proposed.
 *
 * A change tool's call counts against the same per-question cap as a read.
 */
export function buildProposeToolSet(
  tools: readonly AnyProposeTool[],
  run?: { readonly context: ToolCallContext; readonly ledger: ToolLedger; readonly save: SaveProposal },
): ToolSet {
  const set: ToolSet = {}
  for (const definition of tools) {
    const input = definition.input as unknown as z.ZodType<unknown>
    set[definition.name] = tool<unknown, AssistantProposalToolOutput, Record<string, never>>({
      description: definition.description,
      inputSchema: input,
      execute: async (raw: unknown): Promise<AssistantProposalToolOutput> => {
        if (!run) return { status: 'failed' }
        const { context, ledger, save } = run
        if (ledger.calls >= ASSISTANT_MAX_TOOL_CALLS) {
          ledger.failed += 1
          return { status: 'failed' }
        }
        ledger.names.push(definition.name)
        const parsed = input.safeParse(raw)
        if (!parsed.success) {
          ledger.failed += 1
          return { status: 'failed' }
        }
        try {
          const reads = new Map<string, RouteAnswer[]>()
          const recording: ToolCallContext = {
            ...context,
            get: async (path, query) => {
              const answer = await context.get(path, query)
              const key = readKey(path, query)
              reads.set(key, [...(reads.get(key) ?? []), answer])
              return answer
            },
          }
          const outcome = await (
            definition as unknown as {
              prepare(input: unknown, context: ToolCallContext): Promise<PrepareOutcome<AssistantProposalPreview>>
            }
          ).prepare(parsed.data, recording)
          if (outcome.status === 'not_available') {
            ledger.refused += 1
            return { status: 'not_available' }
          }
          if (outcome.status === 'invalid') return { status: 'invalid', problem: outcome.problem.slice(0, 500) }
          if (outcome.status === 'failed') {
            ledger.failed += 1
            return { status: 'failed' }
          }
          const { draft } = outcome
          // The preview must be one the confirm route can parse again, of
          // this tool's own kind, read from a route it can read again.
          const preview = (definition.preview as unknown as z.ZodType<AssistantProposalPreview>).safeParse(draft.preview)
          if (
            !preview.success ||
            !AssistantProposalPreview.safeParse(preview.data).success ||
            preview.data.kind !== definition.kind ||
            draft.kind !== definition.kind ||
            !isCheckPath(draft.checkPath)
          ) {
            ledger.failed += 1
            return { status: 'failed' }
          }
          const digest = digestOfRead(reads, draft.checkPath)
          if (digest === null) {
            ledger.failed += 1
            return { status: 'failed' }
          }
          const proposal = await save(definition, { ...draft, preview: preview.data }, digest)
          return {
            status: 'ok',
            proposal,
            forModel: { proposalId: proposal.id, title: proposal.title, summary: draft.forModel },
          }
        } catch {
          ledger.failed += 1
          return { status: 'failed' }
        }
      },
      toModelOutput: ({ output }) => {
        if (output.status === 'ok') return { type: 'json', value: (output.forModel ?? null) as never }
        if (output.status === 'invalid') return { type: 'text', value: output.problem ?? NOT_PREPARED }
        return { type: 'text', value: output.status === 'not_available' ? NOT_AVAILABLE : NOT_PREPARED }
      },
    })
  }
  return set
}
