import {
  GradeList,
  SectionDetail,
  SectionList,
  type AttendanceMark,
  type ErrorReason,
} from '@erp/contracts'
import type { ToolCallContext } from '../tools/types.ts'
import { className, fetchParsed, seg } from '../tools/present.ts'
import type { PrepareOutcome } from './types.ts'

/**
 * What the change tools share: matching the names a person says to the rows a
 * route answered, the plain sentences for a register or paper that is shut,
 * and the comparison that tells an edited preview from a different change.
 * Nothing here reads data of its own; every lookup is a route called as the
 * person.
 */

// ---------------------------------------------------------------------------
// Words.

/** "Riya, Kabir and Aarav", with "and 3 more" past five. */
export function listed(names: readonly string[], max = 5): string {
  const shown = names.slice(0, max)
  const rest = names.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  if (shown.length <= 1) return shown.join('')
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

const MARK_WORDS: Readonly<Record<AttendanceMark, string>> = {
  present: 'present',
  absent: 'absent',
  late: 'late',
  leave: 'on leave',
  half_day: 'half day',
}

/** "14 present, 2 absent, 1 late": only the marks that are there, in a fixed order. */
export function markCounts(marks: readonly AttendanceMark[]): string {
  const counts = new Map<AttendanceMark, number>()
  for (const mark of marks) counts.set(mark, (counts.get(mark) ?? 0) + 1)
  return (Object.keys(MARK_WORDS) as AttendanceMark[])
    .filter((mark) => (counts.get(mark) ?? 0) > 0)
    .map((mark) => `${counts.get(mark)} ${MARK_WORDS[mark]}`)
    .join(', ')
}

export function countByMark(marks: readonly AttendanceMark[]): Record<AttendanceMark, number> {
  const counts: Record<AttendanceMark, number> = { present: 0, absent: 0, late: 0, leave: 0, half_day: 0 }
  for (const mark of marks) counts[mark] += 1
  return counts
}

/** "26 Sep", for a done sentence. */
export function shortDate(iso: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [, month, day] = iso.split('-')
  const name = months[Number(month) - 1]
  return name ? `${Number(day)} ${name}` : iso
}

/** A reason the person typed, or nothing when it is too short to be one. */
export function typedReason(reason: string | undefined): string | undefined {
  const text = reason?.trim()
  return text !== undefined && text.length >= 3 ? text : undefined
}

/**
 * Why a register or a paper is shut, in the same words the screens use. A
 * route gives a reason only to a person who holds the key, so a reason here
 * means the person may make this kind of change, just not on this day.
 */
const SHUT: Partial<Record<ErrorReason, string>> = {
  attendance_date_outside_year: 'That date is not in an academic year, so there is no register for it.',
  attendance_not_a_school_day: 'There is no school on that day, so there is nothing to mark.',
  attendance_date_in_future: 'That day has not happened yet. The register opens on the day itself.',
  attendance_marking_window_closed: 'The day for marking that register has passed. The office can still correct it.',
  exam_not_started: 'That exam has not started yet. Marks can be entered from its first day.',
  exam_recheck_deadline_passed: 'The re-check deadline for that exam has passed. Only the office can change these marks now.',
}

/**
 * The outcome for a window that lets the person do neither: the sentence for
 * its reason, or "not available" when the route gave none, because then the
 * person holds neither key on this record and a screen would show no control.
 */
export function shutOutcome(window: {
  readonly recordBlockedBy?: ErrorReason | undefined
  readonly correctBlockedBy?: ErrorReason | undefined
}): PrepareOutcome<never> {
  const reason = window.recordBlockedBy ?? window.correctBlockedBy
  const text = reason === undefined ? undefined : SHUT[reason]
  return text === undefined ? { status: 'not_available' } : { status: 'invalid', problem: text }
}

export function invalid(problem: string): PrepareOutcome<never> {
  return { status: 'invalid', problem: problem.length <= 500 ? problem : `${problem.slice(0, 499)}…` }
}

// ---------------------------------------------------------------------------
// Matching a person on a list.

/** Lower case, single spaces, no punctuation: "  Riya  S. " is "riya s". */
export function normalName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface PersonCandidate<T> {
  readonly item: T
  readonly name: string
  /** Admission number or employee code. */
  readonly code?: string | undefined
  readonly rollNumber?: number | undefined
}

export type PersonMatch<T> =
  | { readonly status: 'one'; readonly item: T }
  | { readonly status: 'none' }
  | { readonly status: 'many'; readonly names: readonly string[] }

function described<T>(candidate: PersonCandidate<T>): string {
  if (candidate.rollNumber !== undefined) return `${candidate.name} (roll ${candidate.rollNumber})`
  if (candidate.code !== undefined) return `${candidate.name} (${candidate.code})`
  return candidate.name
}

/**
 * One person on a list from what somebody called them. The first test that
 * finds anybody decides: the whole name, then the admission number or
 * employee code, then a roll number, then every word said being the start of
 * a different word of the name ("Riya", "riya s", "Sharma").
 */
export function matchPerson<T>(said: string, candidates: readonly PersonCandidate<T>[]): PersonMatch<T> {
  const wanted = normalName(said)
  if (wanted === '') return { status: 'none' }
  const compact = said.trim().toLowerCase()
  const words = wanted.split(' ')
  const tests: ((candidate: PersonCandidate<T>) => boolean)[] = [
    (candidate) => normalName(candidate.name) === wanted,
    (candidate) => candidate.code !== undefined && candidate.code.trim().toLowerCase() === compact,
    (candidate) => /^\d+$/.test(wanted) && candidate.rollNumber === Number(wanted),
    (candidate) => {
      const parts = normalName(candidate.name).split(' ')
      const used = new Set<number>()
      return words.every((word) => {
        const index = parts.findIndex((part, at) => !used.has(at) && part.startsWith(word))
        if (index < 0) return false
        used.add(index)
        return true
      })
    },
  ]
  for (const test of tests) {
    const found = candidates.filter(test)
    if (found.length === 1) return { status: 'one', item: found[0]!.item }
    if (found.length > 1) return { status: 'many', names: found.map(described) }
  }
  return { status: 'none' }
}

/** The plain problem for a name that matched nobody or more than one person. */
export function personProblem(said: string, match: Exclude<PersonMatch<unknown>, { status: 'one' }>, where: string): string {
  if (match.status === 'none') return `Nobody called ${said} is on ${where}.`
  return `More than one person on ${where} could be ${said}: ${listed(match.names)}. Say which one.`
}

// ---------------------------------------------------------------------------
// Finding a section.

/** "9A", "9 A" and "Class 9 A" all fold to the same key, as find_sections does. */
export function foldSection(value: string): string {
  return value.toLowerCase().replace(/^class\s+/, '').replace(/[^a-z0-9]/g, '')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type FoundSection =
  | { readonly ok: true; readonly id: string; readonly label: string }
  | { readonly ok: false; readonly outcome: PrepareOutcome<never> }

/**
 * A section of the current year from a name such as "9A", "Class 9 A" or
 * "Nursery A", among the sections the person can see, or from its id.
 */
export async function findSection(context: ToolCallContext, said: string): Promise<FoundSection> {
  const listedSections = await fetchParsed(context, SectionList, '/sections', { academicYearId: context.academicYearId ?? undefined })
  if (!listedSections.ok) return { ok: false, outcome: listedSections.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' } }
  const gradeList = await fetchParsed(context, GradeList, '/grades')
  const grades = new Map(gradeList.ok ? gradeList.body.map((grade) => [grade.id, grade]) : [])
  const named = listedSections.body.map((section) => {
    const grade = grades.get(section.gradeId)
    return { section, grade, label: className(grade, section) ?? section.name }
  })

  const trimmed = said.trim()
  if (UUID.test(trimmed)) {
    const known = named.find(({ section }) => section.id === trimmed.toLowerCase())
    if (known) return { ok: true, id: known.section.id, label: known.label }
    // A section of another year, or one the list does not show: its own page decides.
    const detail = await fetchParsed(context, SectionDetail, `/sections/${seg(trimmed)}`)
    if (!detail.ok) return { ok: false, outcome: detail.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' } }
    return { ok: true, id: detail.body.id, label: className(grades.get(detail.body.gradeId), detail.body) ?? detail.body.name }
  }

  const wanted = foldSection(trimmed)
  const exact = named.filter(({ section, grade, label }) =>
    [label, `${grade?.shortName ?? ''}${section.name}`].some((candidate) => foldSection(candidate) === wanted),
  )
  if (exact.length === 1) return { ok: true, id: exact[0]!.section.id, label: exact[0]!.label }
  if (exact.length > 1) {
    return { ok: false, outcome: invalid(`More than one class is called ${trimmed}: ${listed(exact.map((row) => row.label))}. Say which one.`) }
  }
  const near = named.filter(({ label }) => wanted !== '' && foldSection(label).includes(wanted))
  const hint = (near.length > 0 ? near : named).map((row) => row.label)
  return {
    ok: false,
    outcome: invalid(
      hint.length === 0
        ? `No class called ${trimmed} was found.`
        : `No class called ${trimmed} was found. Classes you can see include ${listed(hint)}.`,
    ),
  }
}

// ---------------------------------------------------------------------------
// Comparing previews.

/** Deep equality of plain JSON values, whatever order the keys are in. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const other = b as unknown[]
    return a.length === other.length && a.every((value, index) => sameJson(value, other[index]))
  }
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (!sameJson(left[key], right[key])) return false
  }
  return true
}

/** A copy of an object without the named keys, to compare what a card may not edit. */
export function without<T extends object>(value: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)))
}
