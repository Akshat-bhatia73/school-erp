import { tool, type ToolSet } from 'ai'
import type { z } from 'zod'
import { ASSISTANT_MAX_TOOL_CALLS, type AssistantToolOutput } from '@erp/contracts'
import type { AnyReadTool, ReadToolOutcome, ToolCallContext } from './tools/types.ts'

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
