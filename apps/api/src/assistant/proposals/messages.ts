import { z } from 'zod'
import {
  AudienceOptions,
  MESSAGE_BODY_MAX,
  MESSAGE_SCHEDULE_MAX_DAYS,
  MESSAGE_SCHEDULE_MIN_MINUTES,
  MESSAGE_TITLE_MAX,
  MessageDetail,
  MessageList,
  MessagePreview,
  MessageRecipients,
  MessageWithdrawPreview,
  StudentSearchResults,
  unknownPlaceholders,
  type CreateMessageRequest,
  type MessageAudienceInput,
  type MessageAudienceView,
  type MessageSendChoice,
  type MessageSummary,
  type StudentBasic,
  type UpdateMessageRequest,
  type WithdrawMessageRequest,
} from '@erp/contracts'
import type { ToolCallContext } from '../tools/types.ts'
import {
  appPath,
  className,
  clip,
  fetchParsed,
  inEnglishLetters,
  nameOf,
  notInEnglishLetters,
  seg,
} from '../tools/present.ts'
import { proposeTool, type PrepareOutcome } from './types.ts'
import { invalid, listed, matchPerson, normalName, sameJson, typedReason, without } from './match.ts'

/**
 * Notices through the assistant (24c): writing a new one, changing one of the
 * person's drafts or scheduled messages, and withdrawing one they sent.
 *
 * The model writes the words and names the audience as people say it; the
 * tool matches the audience against the audiences the person may send to
 * (the same route the Messages screen asks). Saving and sending are one write:
 * the message routes take `send`, so a Confirm never leaves a draft behind a
 * refused send. A time is said on the school's clock and sent as a moment.
 */

// ---------------------------------------------------------------------------
// The school's clock.

/** The school's clock when the turn does not say. */
const INDIA = 'Asia/Kolkata'

/** A time zone Intl knows, else India's. */
export function knownZone(timeZone: string | undefined): string {
  if (timeZone === undefined) return INDIA
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone })
    return timeZone
  } catch {
    return INDIA
  }
}

/** A moment's fields on a zone's clock. */
function zoneParts(ms: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(ms))
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value)
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') }
}

/** A zone's offset from UTC at one moment, in minutes. */
function offsetAt(ms: number, timeZone: string): number {
  const local = zoneParts(ms, timeZone)
  return (Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - Math.floor(ms / 60_000) * 60_000) / 60_000
}

/** "8", "8:30", "08:30", "8 am", "8:30pm", "20:30" as hours and minutes, or null. */
export function parseTime(said: string): { hour: number; minute: number } | null {
  const found = /^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(said.trim())
  if (!found) return null
  let hour = Number(found[1])
  const minute = found[2] === undefined ? 0 : Number(found[2])
  const half = found[3]?.toLowerCase().replace(/\./g, '')
  if (minute > 59) return null
  if (half !== undefined) {
    if (hour < 1 || hour > 12) return null
    hour = (hour % 12) + (half === 'pm' ? 12 : 0)
  }
  return hour <= 23 ? { hour, minute } : null
}

/**
 * A date and a time on the school's clock as a moment, ISO in UTC. The
 * offset is the zone's own on that day, found twice so a clock change
 * between now and then is followed.
 */
export function schoolTimeToUtc(date: string, time: { hour: number; minute: number }, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const local = Date.UTC(year!, month! - 1, day!, time.hour, time.minute)
  const first = local - offsetAt(local, timeZone) * 60_000
  return new Date(local - offsetAt(first, timeZone) * 60_000).toISOString()
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A moment as the school's clock shows it: "28 Sep, 8:00 am". */
export function schoolTimeLabel(iso: string, timeZone: string): string {
  const local = zoneParts(Date.parse(iso), knownZone(timeZone))
  const minute = String(local.minute).padStart(2, '0')
  const half = local.hour < 12 ? 'am' : 'pm'
  return `${local.day} ${MONTHS[local.month - 1]}, ${local.hour % 12 === 0 ? 12 : local.hour % 12}:${minute} ${half}`
}

const WHEN = z
  .enum(['now', 'at', 'draft'])
  .describe('now: send it at once. at: send it at the date and time given. draft: save it as a draft to send later.')
const DATE = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe("With when 'at': the day on the school's calendar, YYYY-MM-DD. Leave out for today.")
const TIME = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .describe("With when 'at': the time on the school's clock, such as \"08:00\" or \"4:30 pm\".")

type SendInput = { readonly when: 'now' | 'at' | 'draft'; readonly date?: string | undefined; readonly time?: string | undefined }

/** The send choice for what the model said, or a plain problem. */
function sendChoice(input: SendInput, context: ToolCallContext, nowMs = Date.now()): { send: MessageSendChoice; label: string } | { problem: string } {
  if (input.when === 'now') return { send: { when: 'now' }, label: 'now' }
  if (input.when === 'draft') return { send: { when: 'draft' }, label: 'as a draft' }
  if (input.time === undefined) return { problem: 'Say what time it should go out, or send it now.' }
  const time = parseTime(input.time)
  if (!time) return { problem: `${input.time} is not a time. Say it like "08:00" or "4:30 pm".` }
  const zone = knownZone(context.timeZone)
  const date = input.date ?? context.today
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    return { problem: `${date} is not a date.` }
  }
  const sendAt = schoolTimeToUtc(date, time, zone)
  const moment = Date.parse(sendAt)
  if (moment < nowMs + MESSAGE_SCHEDULE_MIN_MINUTES * 60_000) {
    return {
      problem: `That time has passed or is less than ${MESSAGE_SCHEDULE_MIN_MINUTES} minutes away. Choose a later time, or send it now.`,
    }
  }
  if (moment > nowMs + MESSAGE_SCHEDULE_MAX_DAYS * 86_400_000) {
    return { problem: `A message can be scheduled at most ${MESSAGE_SCHEDULE_MAX_DAYS} days ahead.` }
  }
  return { send: { when: 'at', sendAt }, label: `at ${schoolTimeLabel(sendAt, zone)} (school time)` }
}

// ---------------------------------------------------------------------------
// The words.

const TITLE = z.string().trim().min(1).max(MESSAGE_TITLE_MAX)
const BODY = z.string().trim().min(1).max(MESSAGE_BODY_MAX)

/** Placeholders a notice to this audience may use, in braces, for the problem sentence. */
function allowedPlaceholders(kind: MessageAudienceInput['kind']): string {
  return kind === 'pupil' ? '{school}, {pupil_name}, {pupil_first_name} and {class}' : '{school}'
}

/** A problem when the words use a placeholder this audience cannot fill. */
function placeholderProblem(title: string, body: string, kind: MessageAudienceInput['kind']): string | null {
  const unknown = unknownPlaceholders(`${title}\n${body}`, 'notice', kind)
  if (unknown.length === 0) return null
  return `The words use ${listed(unknown.map((name) => `{${name}}`))}, which a notice to this audience cannot fill. It may use only ${allowedPlaceholders(kind)}, or write the words out in full.`
}

// ---------------------------------------------------------------------------
// Audiences.

/** "Class 9", "class-9", "Grade 9", "std 9" and "9" fold alike; "9 A" and "9A" too. */
export function foldClass(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/^(the\s+)?(classes|class|grades|grade|standards|standard|std\.?)\s*/, '')
    .replace(/[^a-z0-9]/g, '')
}

/** Filler around an audience: "the parents of 9A", "9A parents", "all of Class 9". */
function strippedAudience(said: string): string {
  return said
    .trim()
    .replace(/^(to\s+)?(the\s+)?((parents|families|guardians|pupils|students|children)\s+(of|in)\s+)/i, '')
    .replace(/\s+(parents|families|guardians|pupils|students|children)$/i, '')
    .replace(/^all\s+(of\s+)?(?=class|grade|std)/i, '')
    .trim()
}

const WHOLE_SCHOOL =
  /^(the\s+)?(whole|entire|full|all)\s+(of\s+the\s+)?school$|^(the\s+)?school$|^everyone$|^(all|every)\s+(the\s+)?(pupils|students|parents|families|children|classes)$/i
const ALL_STAFF = /^(all\s+)?(the\s+)?(staff|teachers|teaching staff|staff members|employees|all teachers)$/i

interface ResolvedAudience {
  /** Without `recipients`: the tool adds the one asked for. */
  readonly audience: MessageAudienceInput
  readonly label: string
}

type AudienceFound = { readonly ok: true; readonly found: ResolvedAudience } | { readonly ok: false; readonly outcome: PrepareOutcome<never> }

/** What the person may send to, in words, for a problem. */
function optionsInWords(options: AudienceOptions, sections: readonly { label: string }[]): string {
  const names = [
    ...(options.school ? ['the whole school'] : []),
    ...(options.staff ? ['all staff'] : []),
    ...options.grades.map((grade) => grade.name),
    ...sections.map((section) => section.label),
  ]
  if (names.length === 0) return 'You cannot send a notice to any class.'
  return `You can send to ${listed(names, 8)}${options.pupils ? ', or to one pupil' : ''}.`
}

/**
 * The audience a person named, among those the audiences route says they may
 * send to: the school, the staff, a class, a range of classes or a section.
 */
function matchAudience(said: string, options: AudienceOptions, academicYearId: string | null): AudienceFound {
  // A section of the current year first, then of a year being set up.
  const sections = options.sections
    .map((section) => ({ ...section, label: `${section.grade.name} ${section.name}` }))
    .sort((a, b) => Number(b.academicYearId === academicYearId) - Number(a.academicYearId === academicYearId))
  const refuse = (problem: string): AudienceFound => ({ ok: false, outcome: invalid(`${problem} ${optionsInWords(options, sections)}`) })
  const text = strippedAudience(said)
  if (notInEnglishLetters(text)) return { ok: false, outcome: invalid(inEnglishLetters(text, "the class's name")) }

  if (WHOLE_SCHOOL.test(text)) {
    return options.school
      ? { ok: true, found: { audience: { kind: 'school' }, label: 'The whole school' } }
      : refuse('You cannot send to the whole school.')
  }
  if (ALL_STAFF.test(text)) {
    return options.staff
      ? { ok: true, found: { audience: { kind: 'staff' }, label: 'All staff' } }
      : refuse('You cannot send to all staff.')
  }

  const gradeCalled = (name: string) => options.grades.findIndex((grade) => foldClass(grade.name) === foldClass(name))
  const range = /^(.+?)\s*(?:\bto\b|\btill\b|\buntil\b|\bthrough\b|–|—|-(?=\s*\d))\s*(.+)$/i.exec(text)
  if (range) {
    const [first, last] = [gradeCalled(range[1]!), gradeCalled(range[2]!)]
    if (first < 0 || last < 0) return refuse(`You cannot send to ${said.trim()}.`)
    // The grades come in the school's class order, so the ends can be put right.
    const [from, to] = first <= last ? [options.grades[first]!, options.grades[last]!] : [options.grades[last]!, options.grades[first]!]
    if (from.id === to.id) return { ok: true, found: { audience: { kind: 'grade', gradeId: from.id }, label: from.name } }
    return {
      ok: true,
      found: { audience: { kind: 'grade_range', fromGradeId: from.id, toGradeId: to.id }, label: `${from.name} to ${to.name}` },
    }
  }

  const wanted = foldClass(text)
  const section = sections.filter((option) => [option.label, `${option.grade.name}${option.name}`].some((name) => foldClass(name) === wanted))
  const current = section.filter((option) => option.academicYearId === section[0]?.academicYearId)
  if (current.length === 1) {
    return { ok: true, found: { audience: { kind: 'section', sectionId: current[0]!.id }, label: current[0]!.label } }
  }
  if (current.length > 1) return { ok: false, outcome: invalid(`More than one class is called ${said.trim()}. Say which one.`) }
  const grade = gradeCalled(text)
  if (grade >= 0) {
    const found = options.grades[grade]!
    return { ok: true, found: { audience: { kind: 'grade', gradeId: found.id }, label: found.name } }
  }
  return refuse(`You cannot send to ${said.trim()}.`)
}

/** One pupil the person may send to, by name or admission number. */
async function matchPupil(context: ToolCallContext, said: string, options: AudienceOptions): Promise<AudienceFound> {
  if (!options.pupils) return { ok: false, outcome: invalid('You cannot send a notice to one pupil.') }
  if (notInEnglishLetters(said)) return { ok: false, outcome: invalid(inEnglishLetters(said)) }
  // The search takes a name or its first word, as a person types it into the screen's picker.
  let found: StudentBasic[] = []
  for (const term of [...new Set([said.trim(), said.trim().split(/\s+/)[0]!])]) {
    const searched = await fetchParsed(context, StudentSearchResults, '/students/search', { q: term })
    if (!searched.ok) return { ok: false, outcome: searched.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' } }
    found = searched.body
    if (found.length > 0) break
  }
  // A teacher sends only to pupils of the sections they may send to, as the picker narrows it.
  const sectionIds = options.school ? null : new Set(options.sections.map((section) => section.id))
  const candidates = found
    .filter((pupil) => pupil.status === 'active' && !pupil.anonymised)
    .filter((pupil) => sectionIds === null || (pupil.enrollment !== undefined && sectionIds.has(pupil.enrollment.section.id)))
    .map((pupil) => ({ item: pupil, name: nameOf(pupil.firstName, pupil.lastName), code: pupil.admissionNumber }))
  const match = matchPerson(said, candidates)
  if (match.status === 'none') return { ok: false, outcome: invalid(`No pupil you can send to is called ${said.trim()}.`) }
  if (match.status === 'many') {
    return { ok: false, outcome: invalid(`More than one pupil could be ${said.trim()}: ${listed(match.names)}. Say which one.`) }
  }
  const pupil = match.item
  const where = className(pupil.enrollment?.grade, pupil.enrollment?.section)
  const name = nameOf(pupil.firstName, pupil.lastName)
  return { ok: true, found: { audience: { kind: 'pupil', studentId: pupil.id }, label: where ? `${name}, ${where}` : name } }
}

/** An audience made of pupils, which may go to families, pupils or both. */
function isPupilAudience(kind: MessageAudienceInput['kind']): boolean {
  return kind !== 'staff'
}

function withRecipients(audience: MessageAudienceInput, recipients: MessageRecipients): MessageAudienceInput {
  return audience.kind === 'staff' ? audience : { ...audience, recipients }
}

/** The audience a person chose, rebuilt from how a message shows it; null for one only the school uses. */
function audienceInputOf(view: MessageAudienceView): MessageAudienceInput | null {
  const recipients = view.recipients ?? 'families'
  switch (view.kind) {
    case 'school':
      return { kind: 'school', recipients }
    case 'staff':
      return { kind: 'staff' }
    case 'grade':
      return view.gradeId ? { kind: 'grade', gradeId: view.gradeId, recipients } : null
    case 'grade_range':
      return view.gradeId && view.toGradeId ? { kind: 'grade_range', fromGradeId: view.gradeId, toGradeId: view.toGradeId, recipients } : null
    case 'section':
      return view.sectionId ? { kind: 'section', sectionId: view.sectionId, recipients } : null
    case 'pupil':
      return view.studentId ? { kind: 'pupil', studentId: view.studentId, recipients } : null
    case 'staff_member':
      return null
  }
}

const RECIPIENT_WORDS: Readonly<Record<MessageRecipients, string>> = {
  families: 'their families',
  students: 'the pupils themselves',
  both: 'the pupils and their families',
}

// ---------------------------------------------------------------------------
// Finding one of the person's messages.

/** Words that say which message without being part of its title. */
const FILLER = new Set(['the', 'a', 'an', 'my', 'notice', 'message', 'draft', 'scheduled', 'about', 'on', 'for', 'to', 'of', 'that', 'one'])

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function described(item: MessageSummary, timeZone: string): string {
  const title = `"${clip(item.title || 'Untitled', 60)}"`
  if (item.status === 'scheduled' && item.sendAt) return `${title} (scheduled for ${schoolTimeLabel(item.sendAt, timeZone)})`
  if (item.status === 'sent' && item.sentAt) return `${title} (sent ${schoolTimeLabel(item.sentAt, timeZone)})`
  return `${title} (${item.status})`
}

type MessageFound = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly outcome: PrepareOutcome<never> }

/**
 * One message of the given statuses that the person may act on (its
 * allowedActions carry communication.send), by its id or words of its title.
 * An exact title wins; else every word said must be in the title.
 */
async function findMessage(
  context: ToolCallContext,
  said: string,
  statuses: readonly ('draft' | 'scheduled' | 'sent')[],
  what: string,
): Promise<MessageFound> {
  const items: MessageSummary[] = []
  for (const status of statuses) {
    const listedMessages = await fetchParsed(context, MessageList, '/messages', { status, kind: 'notice', author: 'anyone', page: 1, pageSize: 100 })
    if (!listedMessages.ok) {
      return { ok: false, outcome: listedMessages.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' } }
    }
    items.push(...listedMessages.body.items)
  }
  const mine = items.filter((item) => item.allowedActions.includes('communication.send'))
  const trimmed = said.trim()
  if (UUID.test(trimmed)) {
    const byId = mine.find((item) => item.id === trimmed.toLowerCase())
    return byId ? { ok: true, id: byId.id } : { ok: false, outcome: { status: 'not_available' } }
  }
  const wanted = normalName(trimmed)
  const exact = mine.filter((item) => normalName(item.title) === wanted || item.title.trim() === trimmed)
  if (exact.length === 1) return { ok: true, id: exact[0]!.id }
  const words = wanted.split(' ').filter((word) => word !== '' && !FILLER.has(word))
  const matching =
    exact.length > 1
      ? exact
      : words.length === 0
        ? []
        : mine.filter((item) => {
            const title = normalName(item.title)
            return words.every((word) => title.includes(word)) || item.title.includes(trimmed)
          })
  if (matching.length === 1) return { ok: true, id: matching[0]!.id }
  if (matching.length > 1) {
    return { ok: false, outcome: invalid(`More than one ${what} could be "${trimmed}": ${listed(matching.map((item) => described(item, knownZone(context.timeZone))))}. Say which one.`) }
  }
  if (mine.length === 0) return { ok: false, outcome: invalid(`You have no ${what} that you may change.`) }
  return {
    ok: false,
    outcome: invalid(`No ${what} of yours is called "${trimmed}". The latest are ${listed(mine.slice(0, 5).map((item) => described(item, knownZone(context.timeZone))))}.`),
  }
}

/**
 * The part of a message's detail read that must not move before a write: its
 * version, status, words, time and audience. The delivery figures move while
 * a sent message is delivered and read, so they are left out.
 */
function messageCheckView(body: unknown): unknown {
  const parsed = MessageDetail.safeParse(body)
  if (!parsed.success) return body
  const { id, version, status, title, body: words, sendAt, sentAt, withdrawnAt, audience } = parsed.data
  return { id, version, status, title, body: words, sendAt, sentAt, withdrawnAt, audience }
}

async function readMessage(context: ToolCallContext, id: string): Promise<{ ok: true; checkPath: string; detail: MessageDetail } | { ok: false; outcome: PrepareOutcome<never> }> {
  const checkPath = `/messages/${seg(id)}`
  const found = await fetchParsed(context, MessageDetail, checkPath)
  if (!found.ok) return { ok: false, outcome: found.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' } }
  return { ok: true, checkPath, detail: found.body }
}

/**
 * Who a done notice went to, for its outcome. The outcome is a plain column
 * of the proposal row, so it names neither the message's words nor a pupil:
 * a class is named, one pupil is not.
 */
function doneAudience(preview: MessagePreview): string {
  if (preview.audience.kind === 'pupil') {
    const recipients = preview.audience.recipients ?? 'families'
    return recipients === 'students' ? 'one pupil' : recipients === 'both' ? 'one pupil and their family' : "one pupil's family"
  }
  return preview.audienceLabel.replace(/^The /, 'the ').replace(/^All /, 'all ')
}

/** "Picnic on Friday" in quotes, cut for a card title. */
function quoted(title: string, max = 80): string {
  return `"${clip(title, max)}"`
}

// ---------------------------------------------------------------------------
// A new notice.

const NewInput = z.object({
  audience: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Who it is for, as people say it: "9A" or "Class 9 A" for one section, "Class 9" for a whole class, "Classes 6 to 8" for a range, "the whole school", "all staff". Leave out when it is for one pupil.',
    ),
  pupil: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("For one pupil's family (or the pupil): the pupil's name or admission number, in English letters. Leave audience out then."),
  recipients: MessageRecipients.optional().describe(
    'For pupils: families (the default), students (the pupils themselves, Class 9 to 12 with a login) or both. Leave out unless the person said.',
  ),
  title: TITLE.describe('A short title, in the language the person asked for, else the language of their question.'),
  body: BODY.describe(
    'The notice itself, in the same language. Only facts the person gave or a tool returned: never invent a date, time, place or amount.',
  ),
  when: WHEN,
  date: DATE.optional(),
  time: TIME.optional(),
})
type NewInput = z.infer<typeof NewInput>

export const proposeMessage = proposeTool<NewInput, MessagePreview>({
  name: 'propose_message',
  description:
    'Proposes a new notice to a section, a class, a range of classes, the whole school, all staff or one pupil\'s family: sent now, at a time, or saved as a draft. You write the title and words. Nothing is sent: the person checks the card and presses Confirm.',
  kind: 'message',
  permission: 'communication.send',
  input: NewInput,
  preview: MessagePreview,
  async prepare(input, context) {
    if ((input.audience === undefined) === (input.pupil === undefined)) {
      return invalid('Say who the notice is for: a class, the whole school, all staff, or one pupil.')
    }
    const checkPath = '/messages/audiences'
    const options = await fetchParsed(context, AudienceOptions, checkPath)
    if (!options.ok) return options.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' }
    const matched =
      input.pupil !== undefined
        ? await matchPupil(context, input.pupil, options.body)
        : matchAudience(input.audience!, options.body, context.academicYearId)
    if (!matched.ok) return matched.outcome
    const { audience, label } = matched.found
    const pupilAudience = isPupilAudience(audience.kind)
    const recipients = input.recipients ?? 'families'
    const problem = placeholderProblem(input.title, input.body, audience.kind)
    if (problem !== null) return invalid(problem)
    const choice = sendChoice(input, context)
    if ('problem' in choice) return invalid(choice.problem)

    const preview: MessagePreview = {
      kind: 'message',
      messageId: null,
      version: null,
      currentStatus: null,
      audience: pupilAudience ? withRecipients(audience, recipients) : audience,
      audienceLabel: clip(label, 160),
      pupilAudience,
      timeZone: knownZone(context.timeZone),
      current: null,
      proposed: { title: input.title, body: input.body, send: choice.send },
    }
    const verb = choice.send.when === 'now' ? 'Send' : choice.send.when === 'at' ? 'Schedule' : 'Draft'
    return {
      status: 'ok',
      draft: {
        kind: 'message',
        title: `${verb} a notice to ${clip(label, 120)}`,
        preview,
        checkPath,
        forModel: {
          summary: `${verb === 'Draft' ? 'Saving' : verb === 'Send' ? 'Sending' : 'Scheduling'} "${input.title}" to ${label} ${choice.label}.`,
          to: label,
          ...(pupilAudience ? { recipients: RECIPIENT_WORDS[recipients] } : {}),
          when: choice.label,
        },
        href: appPath('/messages'),
      },
    }
  },
  sameTarget(original, edited) {
    // The words, the time and, for pupils, who of them it goes to are the card's to change.
    const fixed = (preview: MessagePreview) => ({
      ...without(preview, ['proposed', 'audience']),
      audience: preview.pupilAudience ? without(preview.audience, ['recipients']) : preview.audience,
    })
    return sameJson(fixed(original), fixed(edited))
  },
  write(preview) {
    const { title, body, send } = preview.proposed
    const problem = placeholderProblem(title, body, preview.audience.kind)
    if (problem !== null) return { problem }
    if (preview.messageId === null) {
      const request: CreateMessageRequest = { audience: preview.audience, title, body, send }
      return { method: 'POST', path: '/messages', body: request }
    }
    if (preview.version === null || preview.current === null || preview.currentStatus === null) return { problem: 'That message could not be read.' }
    const titleChanged = title !== preview.current.title
    const bodyChanged = body !== preview.current.body
    // Nothing to do to its state: a draft kept a draft, a scheduled message kept at its time.
    const sameState =
      (preview.currentStatus === 'draft' && send.when === 'draft') ||
      (preview.currentStatus === 'scheduled' && send.when === 'at' && send.sendAt === preview.current.sendAt)
    const recipientsChanged =
      preview.pupilAudience && 'recipients' in preview.audience && (preview.audience.recipients ?? 'families') !== preview.current.recipients
    if (!titleChanged && !bodyChanged && sameState && !recipientsChanged) return { problem: 'Nothing has changed.' }
    const request: UpdateMessageRequest = {
      expectedVersion: preview.version,
      ...(titleChanged ? { title } : {}),
      ...(bodyChanged ? { body } : {}),
      ...(recipientsChanged ? { audience: preview.audience } : {}),
      ...(sameState ? {} : { send }),
    }
    return { method: 'PATCH', path: `/messages/${seg(preview.messageId)}`, body: request }
  },
  describeDone(preview) {
    const send = preview.proposed.send
    if (send.when === 'now') return `Sent the notice to ${doneAudience(preview)}.`
    if (send.when === 'at') return `Scheduled the notice for ${schoolTimeLabel(send.sendAt, preview.timeZone)}.`
    return 'Saved the notice as a draft.'
  },
})

// ---------------------------------------------------------------------------
// A change to a draft or a scheduled message.

const ChangeInput = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_TITLE_MAX)
    .describe('Which of the person\'s drafts or scheduled messages: words of its title, such as "picnic", or its id from list_messages.'),
  title: TITLE.optional().describe('A new title. Leave out to keep it.'),
  body: BODY.optional().describe('New words for the whole message. Leave out to keep them. Never invent a fact the person did not give.'),
  recipients: MessageRecipients.optional().describe('For pupils: families, students or both. Leave out to keep it.'),
  when: WHEN.optional().describe('now: send it at once. at: send it at the date and time given. draft: keep it as, or take it back to, a draft. Leave out to keep it as it is.'),
  date: DATE.optional(),
  time: TIME.optional(),
})
type ChangeInput = z.infer<typeof ChangeInput>

export const proposeMessageChange = proposeTool<ChangeInput, MessagePreview>({
  name: 'propose_message_change',
  description:
    "Proposes a change to one of the person's draft or scheduled notices: new words, a new time, back to a draft, or send it now. Find it by words of its title. Nothing changes until the person presses Confirm on the card.",
  kind: 'message',
  permission: 'communication.send',
  input: ChangeInput,
  preview: MessagePreview,
  async prepare(input, context) {
    if (input.title === undefined && input.body === undefined && input.recipients === undefined && input.when === undefined) {
      return invalid('Say what to change: the title, the words, when it goes, or who of the pupils it goes to.')
    }
    const found = await findMessage(context, input.message, ['draft', 'scheduled'], 'draft or scheduled message')
    if (!found.ok) return found.outcome
    const read = await readMessage(context, found.id)
    if (!read.ok) return read.outcome
    const { detail, checkPath } = read
    if ((detail.status !== 'draft' && detail.status !== 'scheduled') || !detail.allowedActions.includes('communication.send')) {
      return invalid(`${quoted(detail.title)} can no longer be changed: it is ${detail.status}.`)
    }
    const audience = audienceInputOf(detail.audience)
    if (audience === null) return { status: 'not_available' }
    const pupilAudience = isPupilAudience(audience.kind)
    if (input.recipients !== undefined && !pupilAudience) return invalid('A message to all staff goes to the staff; there are no families or pupils to choose.')
    const title = input.title ?? detail.title
    const body = input.body ?? detail.body
    const problem = placeholderProblem(title, body, audience.kind)
    if (problem !== null) return invalid(problem)

    let send: MessageSendChoice
    let whenLabel: string
    if (input.when === undefined) {
      send = detail.status === 'scheduled' && detail.sendAt ? { when: 'at', sendAt: detail.sendAt } : { when: 'draft' }
      whenLabel = send.when === 'at' ? `still at ${schoolTimeLabel(send.sendAt, knownZone(context.timeZone))} (school time)` : 'still a draft'
    } else {
      const choice = sendChoice({ when: input.when, date: input.date, time: input.time }, context)
      if ('problem' in choice) return invalid(choice.problem)
      send = choice.send
      whenLabel = choice.label
    }
    const recipients = input.recipients ?? detail.audience.recipients ?? 'families'
    const sameState =
      (detail.status === 'draft' && send.when === 'draft') || (detail.status === 'scheduled' && send.when === 'at' && send.sendAt === detail.sendAt)
    if (title === detail.title && body === detail.body && sameState && recipients === (detail.audience.recipients ?? 'families')) {
      return invalid(`${quoted(detail.title)} already says that and goes ${whenLabel.replace(/^still /, '')}.`)
    }

    const changes = [
      ...(title !== detail.title ? ['new title'] : []),
      ...(body !== detail.body ? ['new words'] : []),
      ...(recipients !== (detail.audience.recipients ?? 'families') ? [`to ${RECIPIENT_WORDS[recipients]}`] : []),
      ...(sameState ? [] : [send.when === 'now' ? 'send it now' : send.when === 'at' ? `send it ${whenLabel}` : 'back to a draft']),
    ]
    const preview: MessagePreview = {
      kind: 'message',
      messageId: detail.id,
      version: detail.version,
      currentStatus: detail.status,
      audience: pupilAudience ? withRecipients(audience, recipients) : audience,
      audienceLabel: clip(detail.audience.label, 160),
      pupilAudience,
      timeZone: knownZone(context.timeZone),
      current: {
        title: detail.title,
        body: detail.body,
        sendAt: detail.sendAt ?? null,
        recipients: pupilAudience ? (detail.audience.recipients ?? 'families') : null,
      },
      proposed: { title, body, send },
    }
    return {
      status: 'ok',
      draft: {
        kind: 'message',
        title: `Change ${quoted(detail.title)}`,
        preview,
        checkPath,
        forModel: {
          summary: `Changing ${quoted(detail.title)} to ${detail.audience.label}: ${changes.join(', ')}.`,
          was: detail.status,
          when: whenLabel,
          ...(pupilAudience ? { recipients: RECIPIENT_WORDS[recipients] } : {}),
        },
        href: `/messages/${seg(detail.id)}`,
      },
    }
  },
  sameTarget: (original, edited) => proposeMessage.sameTarget(original, edited),
  write: (preview) => proposeMessage.write(preview),
  describeDone(preview) {
    const send = preview.proposed.send
    if (send.when === 'now') return `Sent the message to ${doneAudience(preview)}.`
    if (send.when === 'at') {
      return preview.currentStatus === 'scheduled' && send.sendAt === preview.current?.sendAt
        ? `Saved the changes, still scheduled for ${schoolTimeLabel(send.sendAt, preview.timeZone)}.`
        : `Scheduled the message for ${schoolTimeLabel(send.sendAt, preview.timeZone)}.`
    }
    return preview.currentStatus === 'scheduled' ? 'Took the message back to a draft.' : 'Saved the message as a draft.'
  },
  checkView: messageCheckView,
})

// ---------------------------------------------------------------------------
// Withdrawing a sent message.

const WithdrawInput = z.object({
  message: z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_TITLE_MAX)
    .describe('Which sent notice: words of its title, such as "picnic", or its id from list_messages.'),
  reason: z
    .string()
    .trim()
    .min(3)
    .max(500)
    .optional()
    .describe('Why it is withdrawn, only if the person said. The card asks for it otherwise.'),
})
type WithdrawInput = z.infer<typeof WithdrawInput>

export const proposeMessageWithdraw = proposeTool<WithdrawInput, MessageWithdrawPreview>({
  name: 'propose_message_withdraw',
  description:
    'Proposes taking back a notice the person sent: it leaves every inbox (an email already sent cannot be recalled). Find it by words of its title. The card asks for the reason; nothing happens until the person presses Confirm.',
  kind: 'message_withdraw',
  permission: 'communication.send',
  input: WithdrawInput,
  preview: MessageWithdrawPreview,
  async prepare(input, context) {
    const found = await findMessage(context, input.message, ['sent'], 'sent message')
    if (!found.ok) return found.outcome
    const read = await readMessage(context, found.id)
    if (!read.ok) return read.outcome
    const { detail, checkPath } = read
    if (detail.status !== 'sent' || detail.sentAt === undefined || !detail.allowedActions.includes('communication.send')) {
      return invalid(`${quoted(detail.title)} cannot be withdrawn: it is ${detail.status}.`)
    }
    const reason = typedReason(input.reason)
    const preview: MessageWithdrawPreview = {
      kind: 'message_withdraw',
      messageId: detail.id,
      version: detail.version,
      title: detail.title,
      audienceLabel: clip(detail.audience.label, 160),
      sentAt: detail.sentAt,
      recipients: detail.counts?.recipients ?? 0,
      ...(reason === undefined ? {} : { reason }),
    }
    return {
      status: 'ok',
      draft: {
        kind: 'message_withdraw',
        title: `Withdraw ${quoted(detail.title)}`,
        preview,
        checkPath,
        forModel: {
          summary: `Withdrawing ${quoted(detail.title)}, sent to ${detail.audience.label}.`,
          recipients: preview.recipients,
          needsReason: reason === undefined,
        },
        href: `/messages/${seg(detail.id)}`,
      },
    }
  },
  sameTarget: (original, edited) => sameJson(without(original, ['reason']), without(edited, ['reason'])),
  write(preview) {
    const reason = typedReason(preview.reason)
    if (reason === undefined) return { problem: 'Add a reason for withdrawing the message.' }
    const body: WithdrawMessageRequest = { expectedVersion: preview.version, reason }
    return { method: 'POST', path: `/messages/${seg(preview.messageId)}/withdraw`, body }
  },
  describeDone: () => 'Withdrew the message.',
  checkView: messageCheckView,
})

/** The pure parts, for the tests. */
export const messageToolParts = { sendChoice, matchAudience, messageCheckView }
