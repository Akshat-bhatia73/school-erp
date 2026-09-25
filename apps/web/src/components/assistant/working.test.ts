import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { showsNothingYet } from './format'

const answer = (parts: UIMessage['parts']): UIMessage => ({ id: 'a', role: 'assistant', parts })

describe('the working line', () => {
  it('shows before the answer has anything to show', () => {
    expect(showsNothingYet(undefined)).toBe(true)
    expect(showsNothingYet({ id: 'q', role: 'user', parts: [{ type: 'text', text: 'Who is absent?' }] })).toBe(true)
    expect(showsNothingYet(answer([]))).toBe(true)
    expect(showsNothingYet(answer([{ type: 'step-start' }]))).toBe(true)
  })

  it('shows between a finished lookup and the next step', () => {
    expect(showsNothingYet(answer([
      { type: 'tool-find_sections', toolCallId: 'c1', state: 'output-available', input: {}, output: { status: 'ok' } },
    ] as UIMessage['parts']))).toBe(true)
  })

  it('hides while a lookup is asked for or words are streaming', () => {
    expect(showsNothingYet(answer([
      { type: 'tool-find_sections', toolCallId: 'c1', state: 'input-available', input: {} },
    ] as UIMessage['parts']))).toBe(false)
    expect(showsNothingYet(answer([{ type: 'text', text: 'Here', state: 'streaming' }]))).toBe(false)
  })
})
