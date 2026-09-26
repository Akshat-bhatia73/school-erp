import type { Checks, Dimension, Facts, Language, Scenario, ScriptState, ScriptStep } from '../types.ts'

type Text = string | ((facts: Facts) => string)

export interface ScenarioInput extends Omit<Scenario, 'question' | 'checks' | 'dimensions'> {
  readonly question: Text
  readonly checks?: Checks | ((facts: Facts) => Checks)
  readonly dimensions: readonly Dimension[]
}

/** A scenario with the plain-value shortcuts filled in; hi and mixed ones also measure language. */
export function scenario(input: ScenarioInput): Scenario {
  const { question, checks, dimensions, language } = input
  return {
    ...input,
    question: typeof question === 'string' ? () => question : question,
    checks: typeof checks === 'function' ? checks : () => checks ?? {},
    dimensions: language === 'en' || dimensions.includes('language') ? dimensions : [...dimensions, 'language'],
  }
}

/** One scripted tool call. */
export function call(tool: string, input: (state: ScriptState) => Record<string, unknown> = () => ({})): ScriptStep {
  return { tool, input }
}

/**
 * An id from an earlier result of this turn: the first item of `list` in the
 * newest result of `tool` whose name holds `name` (or the first item).
 */
export function idFrom(state: ScriptState, tool: string, list: string, name?: string): string {
  const result = [...state.results].reverse().find((entry) => entry.tool === tool)
  const items = ((result?.value as Record<string, unknown> | undefined)?.[list] ?? []) as Record<string, unknown>[]
  const wanted = name?.toLowerCase()
  const item = items.find((entry) => wanted === undefined || String(entry.name ?? '').toLowerCase().includes(wanted)) ?? items[0]
  return String(item?.id ?? item?.studentId ?? item?.staffId ?? item?.sectionId ?? '00000000-0000-4000-8000-000000000000')
}

/** find_students, then a tool that takes the pupil's id. */
export function pupilThen(name: (facts: Facts) => string, tool: string, extra: Record<string, unknown> = {}): ScriptStep[] {
  return [
    call('find_students', (state) => ({ query: name(state.facts) })),
    call(tool, (state) => ({ studentId: idFrom(state, 'find_students', 'pupils', name(state.facts)), ...extra })),
  ]
}

/** find_sections, then a tool that takes the section's id. */
export function sectionThen(name: (facts: Facts) => string, tool: string, extra: Record<string, unknown> = {}): ScriptStep[] {
  return [
    call('find_sections', (state) => ({ name: name(state.facts) })),
    call(tool, (state) => ({ sectionId: idFrom(state, 'find_sections', 'sections'), ...extra })),
  ]
}

/** A fixed answer for the scripted model, for a turn that must use no tool. */
export const says = (english: string, hindi?: string) => (language: Language) => (language === 'hi' && hindi ? hindi : english)

/** Monday to Saturday as the timetable tools number them; Sunday reads as Monday. */
export function weekdayOf(iso: string): number {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay()
  return day === 0 ? 1 : day
}

/** Words that claim a change was made. */
export const SAVED_CLAIM = /\b(has been|have been|was|were|is now|are now) (saved|marked|recorded|updated|entered)\b|\bI (have )?(saved|marked|recorded|updated)\b|सेव कर दिया|दर्ज कर दिया|लगा दी गई|मार्क कर दिया/i

/** Where an unsupported change is done, as the prompt names the screens. */
export const SCREEN = {
  fees: /\bFees\b|फ़ीस|फीस/i,
  messages: /\bMessages\b|संदेश|मैसेज/i,
  students: /\bStudents\b|छात्र|विद्यार्थी/i,
} as const
