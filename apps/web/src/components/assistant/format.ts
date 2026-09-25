/**
 * Pure helpers for the assistant screen: how a card value reads, how old a conversation is, how
 * the history is grouped, what a tool is doing, and which sources an answer came from. Nothing
 * here touches the network, so the tests can check each rule on its own.
 */
import {
  AssistantToolOutput,
  type AssistantCard,
  type AssistantSource,
  type AssistantThreadSummary,
  type AssistantTurnRequest,
  type AssistantUnavailableReason,
  type AssistantValue,
} from '@erp/contracts'
import type { UIMessage } from 'ai'
import type { TagColor } from '@/components/shared/tag'
import { formatDate, formatPaise, humanize } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Values

/** One card value as plain words. Money travels as paise; a percent keeps one decimal. */
export function valueText(value: AssistantValue): string {
  switch (value.type) {
    case 'text': return value.value
    case 'number': return new Intl.NumberFormat('en-IN').format(value.value)
    case 'money': return formatPaise(value.paise)
    case 'date': return formatDate(value.value)
    case 'datetime': return formatDateTime(value.value)
    case 'percent': return `${value.value.toFixed(1)}%`
    case 'tag': return value.value
    case 'empty': return '—'
  }
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Statuses read the same colour everywhere; anything else stays a calm grey pill. */
const TAG_COLORS: ReadonlyArray<[RegExp, TagColor]> = [
  [/^(absent|unpaid|overdue|failed|fail|not paid|withdrawn|left)$/i, 'red'],
  [/^(present|paid|passed|pass|active|on|done|published)$/i, 'green'],
  [/^(late|half day|leave|on leave|partly paid|part paid|pending|excused|draft)$/i, 'yellow'],
  [/^(holiday|not marked)$/i, 'blue'],
]

export function tagColor(value: string): TagColor {
  const trimmed = value.trim()
  return TAG_COLORS.find(([pattern]) => pattern.test(trimmed))?.[1] ?? 'grey'
}

// ---------------------------------------------------------------------------
// History

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** A compact age like Linear's: 21m, 21h, 2d, 2w. */
export function compactAge(iso: string, now: Date = new Date()): string {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime())
  if (diff < MINUTE) return 'now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m`
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h`
  const days = Math.floor(diff / DAY)
  if (days < 7) return `${days}d`
  return `${Math.floor(days / 7)}w`
}

export type HistoryGroupLabel = 'Today' | 'Yesterday' | 'This week' | 'Last week' | 'Older'

export interface HistoryGroup {
  label: HistoryGroupLabel
  items: Array<{ thread: AssistantThreadSummary; age: string }>
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** The Monday that starts the week holding `d`, at midnight. */
function startOfWeek(d: Date): Date {
  const day = startOfDay(d)
  const sinceMonday = (day.getDay() + 6) % 7
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - sinceMonday)
}

/**
 * Conversations grouped by when they were last used, newest first, in the person's own calendar:
 * Today, Yesterday, This week (from Monday), Last week, Older. Empty groups are left out.
 */
export function groupThreads(threads: readonly AssistantThreadSummary[], now: Date = new Date()): HistoryGroup[] {
  const today = startOfDay(now)
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const thisWeek = startOfWeek(now)
  const lastWeek = new Date(thisWeek.getFullYear(), thisWeek.getMonth(), thisWeek.getDate() - 7)
  const order: HistoryGroupLabel[] = ['Today', 'Yesterday', 'This week', 'Last week', 'Older']
  const groups = new Map<HistoryGroupLabel, HistoryGroup['items']>()

  const sorted = [...threads].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
  for (const thread of sorted) {
    const at = new Date(thread.lastMessageAt)
    const label: HistoryGroupLabel = at >= today ? 'Today'
      : at >= yesterday ? 'Yesterday'
      : at >= thisWeek ? 'This week'
      : at >= lastWeek ? 'Last week'
      : 'Older'
    const items = groups.get(label) ?? []
    items.push({ thread, age: compactAge(thread.lastMessageAt, now) })
    groups.set(label, items)
  }
  return order.filter((label) => groups.has(label)).map((label) => ({ label, items: groups.get(label)! }))
}

// ---------------------------------------------------------------------------
// Tool parts

/** What a tool call is about, from its name: `section_attendance_day` is about attendance. */
const TOPICS: ReadonlyArray<[RegExp, string]> = [
  [/attendance|register/, 'attendance'],
  [/report_card/, 'report cards'],
  [/fee|due|receipt|payment|concession/, 'fees'],
  [/mark|result|exam|paper|grade_band/, 'exam results'],
  [/timetable|period|substitut|free_teacher|load/, 'the timetable'],
  [/staff|teacher/, 'staff'],
  [/guardian|parent|sibling|family/, 'families'],
  [/student|pupil|enrol|admission/, 'pupils'],
  [/section|class|grade/, 'classes'],
  [/subject/, 'subjects'],
  [/message|notice|inbox|audience|template/, 'messages'],
  [/holiday/, 'holidays'],
  [/academic_year/, 'academic years'],
  [/dashboard|figure|summary/, 'school figures'],
  [/school/, 'the school'],
]

/** The quiet line shown while a tool runs: "Looking up attendance…", "Finding classes…". */
export function toolActivityLabel(toolName: string): string {
  const name = toolName.toLowerCase()
  const topic = TOPICS.find(([pattern]) => pattern.test(name))?.[1] ?? humanize(name).toLowerCase()
  const finding = /^(find|search)_|_search$|^search$/.test(name)
  return `${finding ? 'Finding' : 'Looking up'} ${topic}…`
}

/** The pieces of a tool part this screen needs, however the SDK shaped the rest. */
export interface ToolPartLike {
  type: string
  state?: string
  output?: unknown
}

export type ToolPartView =
  | { kind: 'working' }
  | { kind: 'card'; card?: AssistantCard; source?: AssistantSource }
  | { kind: 'failed' }
  | { kind: 'nothing' }

/**
 * How one tool part is drawn. A running call is one activity line; a finished one is its card;
 * a refusal shows nothing (the model says it cannot see that); anything broken is one muted line.
 */
export function viewToolPart(part: ToolPartLike): ToolPartView {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return { kind: 'working' }
    case 'output-available': {
      const parsed = AssistantToolOutput.safeParse(part.output)
      if (!parsed.success) return { kind: 'failed' }
      if (parsed.data.status === 'not_available') return { kind: 'nothing' }
      if (parsed.data.status === 'failed') return { kind: 'failed' }
      return { kind: 'card', card: parsed.data.card, source: parsed.data.source }
    }
    case 'output-error':
      return { kind: 'failed' }
    default:
      return { kind: 'nothing' }
  }
}

export function isToolPart(part: { type: string }): boolean {
  return part.type.startsWith('tool-') || part.type === 'dynamic-tool'
}

/** Every source the answer's tool calls reported, once each (the same page twice is one link). */
export function collectSources(parts: readonly ToolPartLike[]): AssistantSource[] {
  const seen = new Map<string, AssistantSource>()
  for (const part of parts) {
    if (!isToolPart(part)) continue
    const view = viewToolPart(part)
    if (view.kind === 'card' && view.source && !seen.has(view.source.href)) seen.set(view.source.href, view.source)
  }
  return [...seen.values()]
}

// ---------------------------------------------------------------------------
// Screen words and message pieces

/** Why the assistant cannot be used right now, in plain words. */
export const UNAVAILABLE_TEXT: Readonly<Record<AssistantUnavailableReason, string>> = {
  service_off: 'The assistant is not available right now.',
  school_off: 'Your school has not switched the assistant on.',
  restricted: 'The assistant has been switched off for you. Ask the school office if you need it.',
  no_consent: 'A parent or guardian needs to allow the assistant first. They can do it from their home page.',
  daily_limit: "You have used today's questions. Try again tomorrow.",
  monthly_limit: "Your school has used this month's questions.",
}

/** Everything the person typed in one message, as one string. */
export function messageText(message: Pick<UIMessage, 'parts'>): string {
  return message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

/** The body of one question: the server keeps the history, so only the newest words travel. */
export function turnBody(messages: readonly UIMessage[]): AssistantTurnRequest {
  const last = [...messages].reverse().find((message) => message.role === 'user')
  if (!last) throw new Error('There is no question to send.')
  return { messageId: last.id, text: messageText(last).trim() }
}

/** "Showing 50 of 312" when the route said there are more; otherwise how many rows there are. */
export function tableFooter(card: Extract<AssistantCard, { kind: 'table' }>): string {
  const shown = card.rows.length
  if (card.total !== undefined && card.total > shown) return `Showing ${shown} of ${card.total}`
  return `${shown} ${shown === 1 ? 'row' : 'rows'}`
}

/** A piece of an answer: the model's words are only ever read as these, never as HTML. */
export type AnswerBlock =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'numbers'; items: string[]; start: number }

const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBER = /^\s*(\d{1,3})[.)]\s+(.*)$/

export function parseBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = []
  const push = (block: AnswerBlock) => blocks.push(block)
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const last = blocks[blocks.length - 1]
    if (line.trim() === '') {
      // A blank line ends whatever was open; the next line starts a new block.
      if (last && !(last.kind === 'paragraph' && last.lines.length === 0)) push({ kind: 'paragraph', lines: [] })
      continue
    }
    const bullet = BULLET.exec(line)
    const number = bullet ? null : NUMBER.exec(line)
    if (bullet) {
      if (last?.kind === 'bullets') last.items.push(bullet[1]!)
      else push({ kind: 'bullets', items: [bullet[1]!] })
    } else if (number) {
      if (last?.kind === 'numbers') last.items.push(number[2]!)
      else push({ kind: 'numbers', items: [number[2]!], start: Number(number[1]) })
    } else if (last?.kind === 'paragraph') {
      last.lines.push(line)
    } else {
      push({ kind: 'paragraph', lines: [line] })
    }
  }
  return blocks.filter((block) => block.kind !== 'paragraph' || block.lines.length > 0)
}
