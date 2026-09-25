/**
 * Task 24 contracts: the assistant.
 *
 * The assistant is the person using it. It reads through the same routes the
 * screens call, signed in as that person, and it never writes by itself. See
 * docs/assistant/ARCHITECTURE.md.
 *
 * Nothing here depends on the AI SDK. A conversation's messages are kept in
 * the SDK's own UI message shape, so this package describes only what the
 * server and the browser must agree on: the cards a tool result is drawn as,
 * the sources under an answer, the threads, the switches and the limits.
 */
import { z } from 'zod'
import { CalendarDate, Id, Timestamp, Version } from './common.ts'
import { AllowedActions } from './responses.ts'

// ---------------------------------------------------------------------------
// Limits that never change per school.

/** The longest question a person may type. */
export const ASSISTANT_QUESTION_MAX = 2000
/** Tool calls one question may use. */
export const ASSISTANT_MAX_TOOL_CALLS = 8
/** Rows one list tool call may return. */
export const ASSISTANT_MAX_ROWS = 50
/** Conversation text is deleted this many days after it was written. */
export const ASSISTANT_KEEP_DAYS = 30

// ---------------------------------------------------------------------------
// Cards. A tool result reaches the browser as one card, built on the server
// from the route's already-checked response. Values carry their type and the
// browser formats them (formatINR, formatDate), so the server never guesses
// how a screen shows a number.

export const AssistantValue = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), value: z.string().max(2000) }),
  z.strictObject({ type: z.literal('number'), value: z.number() }),
  /** Money in integer paise, as everywhere else. */
  z.strictObject({ type: z.literal('money'), paise: z.number().int() }),
  z.strictObject({ type: z.literal('date'), value: CalendarDate }),
  z.strictObject({ type: z.literal('datetime'), value: Timestamp }),
  /** 0 to 100. */
  z.strictObject({ type: z.literal('percent'), value: z.number() }),
  /** A short status drawn as an outline pill: "Absent", "Paid", "A1". */
  z.strictObject({ type: z.literal('tag'), value: z.string().min(1).max(60) }),
  z.strictObject({ type: z.literal('empty') }),
])
export type AssistantValue = z.infer<typeof AssistantValue>

/** A path inside the web app, never an absolute URL. */
export const AppPath = z.string().min(1).max(500).regex(/^\/(?!\/)[^\s]*$/)

export const AssistantFact = z.strictObject({
  label: z.string().min(1).max(80),
  value: AssistantValue,
})
export type AssistantFact = z.infer<typeof AssistantFact>

export const AssistantRecordCard = z.strictObject({
  kind: z.literal('record'),
  entity: z.enum(['student', 'staff', 'section', 'guardian', 'school', 'other']),
  title: z.string().min(1).max(160),
  subtitle: z.string().max(200).optional(),
  tags: z.array(z.string().min(1).max(60)).max(8),
  facts: z.array(AssistantFact).max(24),
  href: AppPath.optional(),
})

export const AssistantTableColumn = z.strictObject({
  key: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  align: z.enum(['start', 'end']).optional(),
})

export const AssistantTableCard = z.strictObject({
  kind: z.literal('table'),
  title: z.string().min(1).max(160),
  columns: z.array(AssistantTableColumn).min(1).max(8),
  rows: z.array(
    z.strictObject({
      cells: z.record(z.string(), AssistantValue),
      href: AppPath.optional(),
    }),
  ).max(ASSISTANT_MAX_ROWS),
  /** How many rows exist in total when the route said; more than rows.length means there is more. */
  total: z.number().int().min(0).optional(),
})

export const AssistantFiguresCard = z.strictObject({
  kind: z.literal('figures'),
  title: z.string().min(1).max(160),
  items: z.array(
    z.strictObject({
      label: z.string().min(1).max(80),
      value: AssistantValue,
      hint: z.string().max(120).optional(),
    }),
  ).min(1).max(8),
})

export const AssistantCard = z.discriminatedUnion('kind', [
  AssistantRecordCard,
  AssistantTableCard,
  AssistantFiguresCard,
])
export type AssistantCard = z.infer<typeof AssistantCard>

/** Where an answer came from: built from the tool calls the server made, never by the model. */
export const AssistantSource = z.strictObject({
  label: z.string().min(1).max(160),
  href: AppPath,
})
export type AssistantSource = z.infer<typeof AssistantSource>

/**
 * What every read tool returns to the browser. `not_available` covers a
 * refusal and a missing record alike, exactly as the route answers the
 * screen; `failed` is anything else. The part the model reads is carried
 * beside this and stripped for the model only, see the tool framework.
 */
export const AssistantToolResult = z.strictObject({
  status: z.enum(['ok', 'not_available', 'failed']),
  card: AssistantCard.optional(),
  source: AssistantSource.optional(),
})
export type AssistantToolResult = z.infer<typeof AssistantToolResult>

// ---------------------------------------------------------------------------
// Threads and messages.

export const AssistantThreadSummary = z.strictObject({
  id: Id,
  title: z.string().min(1).max(120),
  createdAt: Timestamp,
  lastMessageAt: Timestamp,
})
export type AssistantThreadSummary = z.infer<typeof AssistantThreadSummary>

export const AssistantThreadList = z.strictObject({
  items: z.array(AssistantThreadSummary).max(500),
})
export type AssistantThreadList = z.infer<typeof AssistantThreadList>

/**
 * One kept message, in the AI SDK's UI message shape. Parts are described
 * loosely here because their shape belongs to the SDK; the browser checks the
 * tool parts it draws against AssistantToolResult.
 */
export const AssistantStoredMessage = z.strictObject({
  id: Id,
  role: z.enum(['user', 'assistant']),
  parts: z.array(z.looseObject({ type: z.string().min(1).max(80) })).max(200),
  createdAt: Timestamp,
})
export type AssistantStoredMessage = z.infer<typeof AssistantStoredMessage>

export const AssistantThread = AssistantThreadSummary.extend({
  messages: z.array(AssistantStoredMessage).max(400),
})
export type AssistantThread = z.infer<typeof AssistantThread>

export const CreateAssistantThreadResponse = z.strictObject({ id: Id })

/** The body of one question. The server holds the history; the browser sends only the new words. */
export const AssistantTurnRequest = z.strictObject({
  /** The id the browser gave the user message, so the kept copy matches the one on screen. */
  messageId: Id,
  text: z.string().trim().min(1).max(ASSISTANT_QUESTION_MAX),
})
export type AssistantTurnRequest = z.infer<typeof AssistantTurnRequest>

// ---------------------------------------------------------------------------
// Can this person use it right now, and why not.

export const AssistantUnavailableReason = z.enum([
  /** ASSISTANT_ENABLED is off, or no model is configured. */
  'service_off',
  /** The school has not switched it on. */
  'school_off',
  /** An owner or principal restricted this person. */
  'restricted',
  /** A pupil whose guardian has not agreed, or withdrew. */
  'no_consent',
  /** Today's questions for this person are used up. */
  'daily_limit',
  /** This month's questions for the school are used up. */
  'monthly_limit',
])
export type AssistantUnavailableReason = z.infer<typeof AssistantUnavailableReason>

export const AssistantStatus = z.strictObject({
  available: z.boolean(),
  reason: AssistantUnavailableReason.optional(),
  questionsLeftToday: z.number().int().min(0),
  /** Suggested first questions for this person's roles. */
  suggestions: z.array(z.string().min(1).max(160)).max(6),
})
export type AssistantStatus = z.infer<typeof AssistantStatus>

// ---------------------------------------------------------------------------
// The school's settings, and usage counts. Never anyone's words.

export const AssistantSettingsValues = z.strictObject({
  enabled: z.boolean(),
  /** Questions per staff member per day. */
  dailyQuestionsStaff: z.number().int().min(0).max(500),
  /** Questions per parent or pupil per day. */
  dailyQuestionsFamily: z.number().int().min(0).max(500),
  /** Questions for the whole school per calendar month. */
  monthlyQuestions: z.number().int().min(0).max(100000),
})
export type AssistantSettingsValues = z.infer<typeof AssistantSettingsValues>

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettingsValues = {
  enabled: false,
  dailyQuestionsStaff: 50,
  dailyQuestionsFamily: 20,
  monthlyQuestions: 3000,
}

export const AssistantSettings = AssistantSettingsValues.extend({
  /** 1 while the school has never saved them. */
  version: Version,
  allowedActions: AllowedActions,
})
export type AssistantSettings = z.infer<typeof AssistantSettings>

export const UpdateAssistantSettingsRequest = AssistantSettingsValues.extend({ expectedVersion: Version })
export type UpdateAssistantSettingsRequest = z.infer<typeof UpdateAssistantSettingsRequest>

export const AssistantUsage = z.strictObject({
  /** The calendar month in the school's timezone, YYYY-MM. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  questions: z.number().int().min(0),
  monthlyQuestions: z.number().int().min(0),
  byRole: z.array(
    z.strictObject({
      role: z.enum(['owner', 'principal', 'admin', 'accountant', 'teacher', 'parent', 'student']),
      questions: z.number().int().min(0),
      people: z.number().int().min(0),
    }),
  ).max(7),
})
export type AssistantUsage = z.infer<typeof AssistantUsage>
