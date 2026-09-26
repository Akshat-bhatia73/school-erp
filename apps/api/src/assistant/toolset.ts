import { tool, type ToolSet } from 'ai'
import type { z } from 'zod'
import {
  ASSISTANT_MAX_TOOL_CALLS,
  AssistantProposalPreview,
  type AssistantProposal,
  type AssistantProposalToolOutput,
  type AssistantToolOutput,
} from '@erp/contracts'
import type { AnyReadTool, ReadToolOutcome, ToolCallContext } from './tools/types.ts'
import type { AnyProposeTool, PrepareOutcome, ProposalDraft } from './proposals/types.ts'
import { getByPath } from './inject.ts'
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

/**
 * The AI SDK tool set for the change tools (24b). A change tool never writes:
 * `prepare` reads through the same routes as the person and returns a draft;
 * this reads the draft's check route once more, keeps a digest of its answer
 * and saves the proposal. The browser draws it as an editable card and only
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
          const outcome = await (
            definition as unknown as {
              prepare(input: unknown, context: ToolCallContext): Promise<PrepareOutcome<AssistantProposalPreview>>
            }
          ).prepare(parsed.data, context)
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
          const check = await getByPath(context.get, draft.checkPath)
          if (!check.ok) {
            if (check.status === 403 || check.status === 404) {
              ledger.refused += 1
              return { status: 'not_available' }
            }
            ledger.failed += 1
            return { status: 'failed' }
          }
          const proposal = await save(definition, { ...draft, preview: preview.data }, digestOf(check.body))
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
