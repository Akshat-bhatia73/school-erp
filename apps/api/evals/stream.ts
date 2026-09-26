import type { AssistantProposalPreview } from '@erp/contracts'
import type { ToolCallRecord, TurnRecord } from './types.ts'

/** The data lines of a UI message stream, parsed. */
export function streamChunks(body: string): Record<string, unknown>[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => JSON.parse(line.slice('data: '.length)) as Record<string, unknown>)
}

/**
 * One turn as the browser sees it: the tool calls with their inputs and
 * outputs, the words, and the proposal cards. A failed turn's sentence
 * arrives as an `error` chunk and is kept as words, as the screen shows it.
 */
export function parseTurn(httpStatus: number, body: string): TurnRecord {
  if (httpStatus !== 200) return { httpStatus, calls: [], text: '', proposals: [], errored: true }
  const chunks = streamChunks(body)
  const calls = new Map<string, { toolCallId: string; tool: string; input: unknown; output: unknown }>()
  let text = ''
  let errored = false
  for (const chunk of chunks) {
    const id = typeof chunk.toolCallId === 'string' ? chunk.toolCallId : ''
    switch (chunk.type) {
      case 'tool-input-available':
        calls.set(id, { toolCallId: id, tool: String(chunk.toolName), input: chunk.input, output: undefined })
        break
      case 'tool-output-available': {
        const call = calls.get(id)
        if (call) call.output = chunk.output
        break
      }
      case 'tool-output-error':
      case 'tool-input-error': {
        const call = calls.get(id) ?? { toolCallId: id, tool: String(chunk.toolName ?? ''), input: chunk.input, output: undefined }
        call.output = { status: 'failed' }
        calls.set(id, call)
        break
      }
      case 'text-delta':
        text += typeof chunk.delta === 'string' ? chunk.delta : ''
        break
      case 'error':
        errored = true
        text += `${text === '' ? '' : '\n'}${typeof chunk.errorText === 'string' ? chunk.errorText : ''}`
        break
      default:
        break
    }
  }
  const list: ToolCallRecord[] = [...calls.values()]
  const proposals = list.flatMap((call) => {
    const output = call.output as { status?: string; proposal?: { id: string; kind: string; preview: AssistantProposalPreview } } | undefined
    return output?.status === 'ok' && output.proposal ? [output.proposal] : []
  })
  return { httpStatus, calls: list, text: text.trim(), proposals, errored }
}
