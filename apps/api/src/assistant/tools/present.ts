import { z } from 'zod'
import {
  ASSISTANT_MAX_ROWS,
  CalendarDate,
  Id,
  type AssistantCard,
  type AssistantFact,
  type AssistantSource,
  type AssistantValue,
} from '@erp/contracts'
import { refusal, type AnyReadTool, type ReadToolDefinition, type ReadToolOutcome, type ToolCallContext } from './types.ts'

/**
 * Small helpers every read tool shares: calling a route and checking its body,
 * typed card values, capped tables and app paths. Nothing here reads data of
 * its own; a tool only ever sees what its route answered.
 */

// ---------------------------------------------------------------------------
// Inputs. Ids go into a path, so they keep the contract's safe alphabet.

export const IdInput = (description: string) => Id.describe(description)
export const DateInput = (description: string) => CalendarDate.describe(`${description} YYYY-MM-DD.`)
export const MonthInput = (description: string) =>
  z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).describe(`${description} YYYY-MM.`)
export const YearInput = () =>
  Id.optional().describe('The academic year id. Leave out for the current year.')

/** A path segment from an already-checked id. */
export const seg = (value: string): string => encodeURIComponent(value)

// ---------------------------------------------------------------------------
// Calling a route.

export type Fetched<T> = { readonly ok: true; readonly body: T } | { readonly ok: false; readonly outcome: ReadToolOutcome }

/**
 * GET one route as the person and parse its body with the route's own
 * response contract. The route already checked it; parsing gives the types.
 */
export async function fetchParsed<S extends z.ZodType>(
  context: ToolCallContext,
  schema: S,
  path: string,
  query?: Readonly<Record<string, string | number | boolean | undefined>>,
): Promise<Fetched<z.infer<S>>> {
  const answer = await context.get(path, query)
  if (!answer.ok) return { ok: false, outcome: refusal(answer) }
  const parsed = schema.safeParse(answer.body)
  if (!parsed.success) return { ok: false, outcome: { status: 'failed' } }
  return { ok: true, body: parsed.data }
}

/** The year a tool works in: the one asked for, else the current one. */
export function yearFor(input: { readonly academicYearId?: string | undefined }, context: ToolCallContext): string | null {
  return input.academicYearId ?? context.academicYearId
}

/** What a tool says when it needs a year and there is none to default to. */
export const NO_YEAR: ReadToolOutcome = {
  status: 'ok',
  forModel: { needs: 'academicYearId', hint: 'There is no current academic year. Ask which year, or call list_academic_years.' },
}

export function ok(forModel: unknown, card?: AssistantCard, source?: AssistantSource): ReadToolOutcome {
  return { status: 'ok', forModel, ...(card ? { card } : {}), ...(source ? { source } : {}) }
}

// ---------------------------------------------------------------------------
// Values. Money stays in paise and dates stay ISO; the browser formats them.

export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export const EMPTY: AssistantValue = { type: 'empty' }

export function text(value: string | null | undefined): AssistantValue {
  return value ? { type: 'text', value: clip(value, 2000) } : EMPTY
}

export function num(value: number | null | undefined): AssistantValue {
  return value === null || value === undefined ? EMPTY : { type: 'number', value }
}

export function money(paise: number | null | undefined): AssistantValue {
  return paise === null || paise === undefined ? EMPTY : { type: 'money', paise: Math.round(paise) }
}

export function date(value: string | null | undefined): AssistantValue {
  return value ? { type: 'date', value } : EMPTY
}

export function datetime(value: string | null | undefined): AssistantValue {
  return value ? { type: 'datetime', value } : EMPTY
}

export function percent(value: number | null | undefined): AssistantValue {
  return value === null || value === undefined ? EMPTY : { type: 'percent', value }
}

export function tag(value: string | null | undefined): AssistantValue {
  return value ? { type: 'tag', value: clip(value, 60) } : EMPTY
}

export function fact(label: string, value: AssistantValue): AssistantFact {
  return { label: clip(label, 80), value }
}

/** Paise as rupees for the model, which reads numbers better than paise. */
export function rupees(paise: number): number {
  return Math.round(paise) / 100
}

/** "half_day" as "Half day". */
export function humanise(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "25 Sep 2026", for a source label only. Cards carry the ISO date. */
export function dateLabel(iso: string): string {
  const [year, month, day] = iso.split('-')
  const name = MONTHS[Number(month) - 1]
  return name ? `${Number(day)} ${name} ${year}` : iso
}

/** "Sep 2026" from "2026-09". */
export function monthLabel(month: string): string {
  const [year, number] = month.split('-')
  const name = MONTHS[Number(number) - 1]
  return name ? `${name} ${year}` : month
}

/** Day of the week of an ISO date: 0 is Sunday, 1 Monday ... 6 Saturday. */
export function dayOfWeek(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay()
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** A class and its section as people say it: "Six A". */
export function className(grade: { readonly name: string } | undefined, section: { readonly name: string } | undefined): string | undefined {
  if (!grade && !section) return undefined
  if (!grade) return section!.name
  if (!section) return grade.name
  return `${grade.name} ${section.name}`
}

// ---------------------------------------------------------------------------
// Cards and sources.

export function recordCard(input: {
  readonly entity: 'student' | 'staff' | 'section' | 'guardian' | 'school' | 'other'
  readonly title: string
  readonly subtitle?: string | undefined
  readonly tags?: readonly (string | undefined)[]
  readonly facts: readonly (AssistantFact | undefined)[]
  readonly href?: string | undefined
}): AssistantCard {
  const tags = (input.tags ?? []).filter((value): value is string => Boolean(value)).map((value) => clip(value, 60))
  const facts = input.facts.filter((value): value is AssistantFact => value !== undefined && value.value.type !== 'empty')
  return {
    kind: 'record',
    entity: input.entity,
    title: clip(input.title, 160),
    ...(input.subtitle ? { subtitle: clip(input.subtitle, 200) } : {}),
    tags: tags.slice(0, 8),
    facts: facts.slice(0, 24),
    ...(input.href ? { href: input.href } : {}),
  }
}

export interface TableColumn {
  readonly key: string
  readonly label: string
  readonly align?: 'start' | 'end'
}

export interface TableRow {
  readonly cells: Record<string, AssistantValue>
  readonly href?: string | undefined
}

/**
 * A list as a table, never longer than the assistant's row limit. `total` is
 * how many rows exist; when it is more than the rows shown the card says so.
 */
export function tableCard(input: {
  readonly title: string
  readonly columns: readonly TableColumn[]
  readonly rows: readonly TableRow[]
  readonly total?: number | undefined
}): AssistantCard {
  const rows = input.rows.slice(0, ASSISTANT_MAX_ROWS)
  const total = input.total ?? input.rows.length
  return {
    kind: 'table',
    title: clip(input.title, 160),
    columns: input.columns.slice(0, 8).map((column) => ({
      key: column.key,
      label: clip(column.label, 60),
      ...(column.align ? { align: column.align } : {}),
    })),
    rows: rows.map((row) => ({ cells: row.cells, ...(row.href ? { href: row.href } : {}) })),
    ...(total > rows.length ? { total } : {}),
  }
}

export function figuresCard(
  title: string,
  items: readonly ({ readonly label: string; readonly value: AssistantValue; readonly hint?: string | undefined } | undefined)[],
): AssistantCard | undefined {
  const shown = items.filter((item): item is NonNullable<typeof item> => item !== undefined).slice(0, 8)
  if (shown.length === 0) return undefined
  return {
    kind: 'figures',
    title: clip(title, 160),
    items: shown.map((item) => ({
      label: clip(item.label, 80),
      value: item.value,
      ...(item.hint ? { hint: clip(item.hint, 120) } : {}),
    })),
  }
}

/** An app path with its search params; empty values are left out. */
export function appPath(path: string, search?: Readonly<Record<string, string | number | undefined | null>>): string {
  const params = Object.entries(search ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null && entry[1] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  return params.length === 0 ? path : `${path}?${params.join('&')}`
}

export function source(label: string, href: string): AssistantSource {
  return { label: clip(label, 160), href }
}

/** At most the row limit of a list, for the model as for the card. */
export function capped<T>(items: readonly T[]): { readonly items: readonly T[]; readonly total: number; readonly more: boolean } {
  return { items: items.slice(0, ASSISTANT_MAX_ROWS), total: items.length, more: items.length > ASSISTANT_MAX_ROWS }
}

/** A person's name in a list, cut to what a list shows. */
export function nameOf(first: string, last?: string | undefined): string {
  return last ? `${first} ${last}` : first
}

/** The row limit, as a page size for a paged route. */
export const PAGE_SIZE = ASSISTANT_MAX_ROWS

/**
 * A module's tools as the registry holds them. A definition with a typed input
 * is not assignable to AnyReadTool as written, so the list is widened here,
 * once, after each definition has been checked against its own input.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolList(...tools: readonly ReadToolDefinition<any>[]): readonly AnyReadTool[] {
  return tools as unknown as readonly AnyReadTool[]
}
