/**
 * The scripted model for `--scripted`: it calls the tools the scenario's
 * script names, with inputs built from what earlier calls returned, and then
 * answers from their output. It exercises the runner, the real tools and
 * routes, and the checks without a model key. It measures nothing about a
 * model's judgement: a pass here means the harness works.
 */
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { Facts, Language, Script, ScriptState } from './types.ts'

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}

/** What the runner sets before each turn. */
export interface ScriptedTurn {
  readonly script: Script | undefined
  readonly facts: Facts
  readonly language: Language
}

interface PromptPart {
  readonly type: string
  readonly text?: string
  readonly toolName?: string
  readonly output?: { readonly type: string; readonly value: unknown }
}
interface PromptMessage {
  readonly role: string
  readonly content: string | readonly PromptPart[]
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The leaves of a tool result as "path: value", ids left out, for a plain listing. */
function leaves(value: unknown, path = ''): string[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return UUID.test(value) ? [] : [`${path}: ${value}`]
  if (typeof value === 'number' || typeof value === 'boolean') return [`${path}: ${String(value)}`]
  if (Array.isArray(value)) return value.flatMap((item, index) => leaves(item, `${path}[${index}]`))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !/Id$|^id$/.test(key))
      .flatMap(([key, item]) => leaves(item, path === '' ? key : `${path}.${key}`))
  }
  return []
}

/** A plain listing of what the tools returned: grounded by construction. */
export function listResults(state: ScriptState, language: Language): string {
  const lines: string[] = []
  for (const result of state.results) {
    if (typeof result.value === 'string') {
      lines.push(result.value)
      if (result.tool.startsWith('propose_')) lines.push(language === 'hi' ? 'आप किसकी बात कर रहे हैं?' : 'Could you tell me which one you mean?')
      continue
    }
    const value = result.value as { proposalId?: string; summary?: unknown } | null
    if (result.tool.startsWith('propose_') && value?.proposalId) {
      lines.push(`${leaves(value.summary).join('; ')}. The card is ready to check and confirm.`)
      continue
    }
    // Totals and flags before the rows, so a long list cannot push them out.
    const all = leaves(result.value)
    lines.push([...all.filter((line) => !line.includes('[')), ...all.filter((line) => line.includes('['))].join('; '))
  }
  const body = lines.join('\n').slice(0, 6000)
  if (language === 'hi') return `मुझे यह मिला:\n${body}`
  return body === '' ? 'I have nothing to show for that.' : body
}

/** The scripted model. `turn()` is read at every step, so one model serves the whole run. */
export function scriptedModel(turn: () => ScriptedTurn | undefined): MockLanguageModelV4 {
  let calls = 0
  return new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'eval',
    doStream: async (options) => {
      const current = turn()
      const prompt = options.prompt as unknown as readonly PromptMessage[]
      const newest = prompt.findLastIndex((message) => message.role === 'user')
      const results = prompt
        .slice(newest + 1)
        .filter((message) => message.role === 'tool')
        .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((part) => part.type === 'tool-result')
        .map((part) => ({ tool: part.toolName ?? '', value: part.output?.value }))
      const state: ScriptState = { facts: current?.facts as Facts, results, prompt: JSON.stringify(prompt) }
      const step = current?.script?.steps[results.length]
      if (current && step) {
        calls += 1
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'tool-call' as const, toolCallId: `scripted-${calls}`, toolName: step.tool, input: JSON.stringify(step.input(state)) },
              { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage },
            ],
          }),
        }
      }
      const words = current?.script?.say?.(state) ?? listResults(state, current?.language ?? 'en')
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 't' },
            { type: 'text-delta' as const, id: 't', delta: words },
            { type: 'text-end' as const, id: 't' },
            { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
          ],
        }),
      }
    },
  })
}
