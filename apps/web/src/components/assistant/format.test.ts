import type { AssistantThreadSummary } from '@erp/contracts'
import { describe, expect, it } from 'vitest'
import { collectSources, compactAge, groupThreads, parseBlocks, tagColor, toolActivityLabel, turnBody, valueText, viewToolPart } from './format'

// Thursday 25 September 2026, 15:00 local time.
const NOW = new Date(2026, 8, 25, 15, 0, 0)
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function thread(id: string, lastMessageAt: string): AssistantThreadSummary {
  return { id, title: `Thread ${id}`, createdAt: lastMessageAt, lastMessageAt }
}

describe('compactAge', () => {
  it('reads like Linear: minutes, hours, days, then weeks', () => {
    expect(compactAge(ago(20 * 1000), NOW)).toBe('now')
    expect(compactAge(ago(21 * MIN), NOW)).toBe('21m')
    expect(compactAge(ago(21 * HOUR), NOW)).toBe('21h')
    expect(compactAge(ago(2 * DAY), NOW)).toBe('2d')
    expect(compactAge(ago(8 * DAY), NOW)).toBe('1w')
    expect(compactAge(ago(15 * DAY), NOW)).toBe('2w')
  })
})

describe('groupThreads', () => {
  it('groups by calendar day and week, newest first, and drops empty groups', () => {
    const groups = groupThreads([
      thread('older', ago(20 * DAY)),
      thread('today', ago(21 * MIN)),
      thread('yesterday', new Date(2026, 8, 24, 20, 0).toISOString()),
      thread('this-week', new Date(2026, 8, 22, 9, 0).toISOString()), // Monday
      thread('last-week', new Date(2026, 8, 17, 9, 0).toISOString()),
      thread('today-earlier', new Date(2026, 8, 25, 0, 30).toISOString()),
    ], NOW)

    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'This week', 'Last week', 'Older'])
    expect(groups[0]!.items.map((i) => i.thread.id)).toEqual(['today', 'today-earlier'])
    expect(groups[0]!.items[0]!.age).toBe('21m')
    expect(groups[1]!.items[0]!.age).toBe('19h')
    expect(groups[4]!.items[0]!.age).toBe('2w')
  })

  it('leaves out groups with nothing in them', () => {
    expect(groupThreads([thread('a', ago(3 * DAY))], NOW).map((g) => g.label)).toEqual(['This week'])
    expect(groupThreads([], NOW)).toEqual([])
  })
})

describe('valueText', () => {
  it('formats each value by its type', () => {
    expect(valueText({ type: 'text', value: 'Riya Sharma' })).toBe('Riya Sharma')
    expect(valueText({ type: 'number', value: 1234567 })).toBe('12,34,567')
    expect(valueText({ type: 'money', paise: 125050 })).toBe('₹1,250.50')
    expect(valueText({ type: 'money', paise: 1250000 })).toBe('₹12,500')
    expect(valueText({ type: 'date', value: '2026-09-25' })).toBe('25 Sept 2026')
    expect(valueText({ type: 'percent', value: 92.456 })).toBe('92.5%')
    expect(valueText({ type: 'percent', value: 100 })).toBe('100.0%')
    expect(valueText({ type: 'tag', value: 'Absent' })).toBe('Absent')
    expect(valueText({ type: 'empty' })).toBe('—')
    expect(valueText({ type: 'datetime', value: '2026-09-25T05:12:00.000Z' })).toMatch(/2026/)
  })

  it('colours the common statuses and leaves the rest grey', () => {
    expect(tagColor('Absent')).toBe('red')
    expect(tagColor('present')).toBe('green')
    expect(tagColor('Late')).toBe('yellow')
    expect(tagColor('A1')).toBe('grey')
  })
})

describe('tool parts', () => {
  const ok = { status: 'ok', card: { kind: 'figures', title: 'Attendance', items: [{ label: 'Present', value: { type: 'percent', value: 91 } }] }, source: { label: 'Attendance, 9 A, 25 Sep', href: '/attendance?sectionId=s1&date=2026-09-25' }, forModel: { present: 30 } }

  it('says what a running tool is doing, from its name', () => {
    expect(toolActivityLabel('section_attendance_day')).toBe('Looking up attendance…')
    expect(toolActivityLabel('find_section')).toBe('Finding classes…')
    expect(toolActivityLabel('student_fee_statement')).toBe('Looking up fees…')
    expect(toolActivityLabel('mystery_tool')).toBe('Looking up mystery tool…')
  })

  it('shows a card for ok, nothing for not available, and one line for a failure', () => {
    expect(viewToolPart({ type: 'tool-x', state: 'input-streaming' })).toEqual({ kind: 'working' })
    expect(viewToolPart({ type: 'tool-x', state: 'output-available', output: ok })).toMatchObject({ kind: 'card', card: { kind: 'figures' } })
    expect(viewToolPart({ type: 'tool-x', state: 'output-available', output: { status: 'not_available', forModel: 'no' } })).toEqual({ kind: 'nothing' })
    expect(viewToolPart({ type: 'tool-x', state: 'output-available', output: { status: 'failed' } })).toEqual({ kind: 'failed' })
    expect(viewToolPart({ type: 'tool-x', state: 'output-available', output: { status: 'ok', card: { kind: 'nonsense' } } })).toEqual({ kind: 'failed' })
    expect(viewToolPart({ type: 'tool-x', state: 'output-error' })).toEqual({ kind: 'failed' })
  })

  it('collects each source once', () => {
    const second = { ...ok, source: { label: 'Fees, Riya Sharma', href: '/fees/students/st-1' } }
    const sources = collectSources([
      { type: 'text' },
      { type: 'tool-a', state: 'output-available', output: ok },
      { type: 'tool-b', state: 'output-available', output: second },
      { type: 'tool-c', state: 'output-available', output: ok },
      { type: 'tool-d', state: 'output-available', output: { status: 'not_available', source: { label: 'Hidden', href: '/x' } } },
    ])
    expect(sources.map((s) => s.label)).toEqual(['Attendance, 9 A, 25 Sep', 'Fees, Riya Sharma'])
  })
})

describe('turnBody', () => {
  it('sends only the newest question and its id', () => {
    expect(turnBody([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'First' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Answer' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: '  Who was absent?  ' }] },
    ])).toEqual({ messageId: 'u2', text: 'Who was absent?' })
  })
})

describe('parseBlocks', () => {
  it('understands paragraphs, line breaks and both kinds of list', () => {
    expect(parseBlocks('Two pupils were absent.\nBoth in 9 A.\n\n- Riya\n- Kabir\n\n1. First\n2. Second')).toEqual([
      { kind: 'paragraph', lines: ['Two pupils were absent.', 'Both in 9 A.'] },
      { kind: 'bullets', items: ['Riya', 'Kabir'] },
      { kind: 'numbers', items: ['First', 'Second'], start: 1 },
    ])
  })
})
