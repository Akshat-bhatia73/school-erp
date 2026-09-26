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
import { CalendarDate, Id, Reason, Timestamp, Version } from './common.ts'
import { AllowedActions } from './responses.ts'
import { AttendanceMark } from './module-attendance.ts'
import { ExamComponent, ExamReasonKind, MarkValue } from './module-exams.ts'
import { CoScholasticGrades, ReportCardKind } from './module-report-cards.ts'

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

/**
 * The output of a read tool as it is kept and streamed: the result above plus
 * `forModel`, the plain JSON the model reads (the SDK's toModelOutput sends
 * only that part to the model, including when an old conversation is replayed).
 * The browser ignores `forModel`.
 */
export const AssistantToolOutput = AssistantToolResult.extend({
  forModel: z.unknown().optional(),
})
export type AssistantToolOutput = z.infer<typeof AssistantToolOutput>

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

// ---------------------------------------------------------------------------
// Proposals (24b). A change tool never writes. It returns a proposal: an
// editable preview of the change and nothing else. The person edits the
// preview on a card and presses Confirm; the server then builds the write
// from the edited preview, checks the record has not changed since it was
// read, and calls the real write route as the person. See ARCHITECTURE.md
// section 5.

/** Minutes a proposal stays open. */
export const ASSISTANT_PROPOSAL_MINUTES = 30

export const AssistantProposalKind = z.enum([
  'attendance_day',
  'staff_attendance_day',
  'exam_marks',
  'co_scholastic',
])
export type AssistantProposalKind = z.infer<typeof AssistantProposalKind>

export const AssistantProposalStatus = z.enum([
  /** Waiting for the person. */
  'open',
  /**
   * Confirmed and being written now. It settles to done, stale or failed
   * within seconds; one left here by a crash is settled the next time anyone
   * looks, from the write's own audit row.
   */
  'confirming',
  /** Confirmed and written. */
  'done',
  /** The person discarded it. */
  'dismissed',
  /** Nobody confirmed it within ASSISTANT_PROPOSAL_MINUTES. */
  'expired',
  /** The record changed after it was read, so nothing was written. */
  'stale',
  /** The write route refused or failed; nothing was written. */
  'failed',
])
export type AssistantProposalStatus = z.infer<typeof AssistantProposalStatus>

/**
 * Whether a change is the first entry or a change to what is already saved.
 * A change to saved attendance or marks needs a reason, which the card asks
 * for; the write route decides who may make it.
 */
export const AssistantProposalMode = z.enum(['first_entry', 'correction'])
export type AssistantProposalMode = z.infer<typeof AssistantProposalMode>

const PersonName = z.string().min(1).max(160)
const RowLimit = 200

/**
 * The previews. Everything in one is fixed by the server except the fields
 * named `proposed…`, `reason` and `reasonKind`, which the person may edit.
 * `current…` is what is saved now, so the card can show old beside new.
 */
export const AttendanceDayPreview = z.strictObject({
  kind: z.literal('attendance_day'),
  mode: AssistantProposalMode,
  sectionId: Id,
  sectionName: z.string().min(1).max(120),
  date: CalendarDate,
  rows: z.array(z.strictObject({
    studentId: Id,
    name: PersonName,
    rollNumber: z.number().int().min(0).nullable(),
    current: AttendanceMark.nullable(),
    proposed: AttendanceMark,
    /**
     * The revision of the saved mark the preview was read from, 0 when there
     * was none: sent with the write so a mark saved since is never
     * overwritten. Missing only on proposals made before it existed.
     */
    revision: z.number().int().nonnegative().optional(),
  })).min(1).max(RowLimit),
  reason: Reason.optional(),
})
export type AttendanceDayPreview = z.infer<typeof AttendanceDayPreview>

export const StaffAttendanceDayPreview = z.strictObject({
  kind: z.literal('staff_attendance_day'),
  mode: AssistantProposalMode,
  date: CalendarDate,
  rows: z.array(z.strictObject({
    staffId: Id,
    name: PersonName,
    designation: z.string().max(120).nullable(),
    current: AttendanceMark.nullable(),
    proposed: AttendanceMark,
    /**
     * The revision of the saved mark the preview was read from, 0 when there
     * was none: sent with the write so a mark saved since is never
     * overwritten. Missing only on proposals made before it existed.
     */
    revision: z.number().int().nonnegative().optional(),
  })).min(1).max(500),
  reason: Reason.optional(),
})
export type StaffAttendanceDayPreview = z.infer<typeof StaffAttendanceDayPreview>

export const ExamMarksPreview = z.strictObject({
  kind: z.literal('exam_marks'),
  mode: AssistantProposalMode,
  paperId: Id,
  /**
   * Which write the marks go through: the marks sheet (the subject teacher, or
   * the office, before the re-check deadline) or the office's correction after
   * it, which always needs a reason kind and a reason.
   */
  route: z.enum(['marks_sheet', 'office_correction']),
  /** "Half-yearly, Mathematics, 9 A". */
  title: z.string().min(1).max(200),
  components: z.array(z.strictObject({
    component: ExamComponent,
    label: z.string().min(1).max(60),
    maxMarks: z.number().positive(),
  })).min(1).max(4),
  rows: z.array(z.strictObject({
    studentId: Id,
    name: PersonName,
    rollNumber: z.number().int().min(0).nullable(),
    cells: z.array(z.strictObject({
      component: ExamComponent,
      current: MarkValue.nullable(),
      /** Null leaves the cell as it is. */
      proposed: MarkValue.nullable(),
      /** The saved cell's revision, 0 when empty; as on the attendance rows. */
      revision: z.number().int().nonnegative().optional(),
    })).min(1).max(4),
  })).min(1).max(RowLimit),
  reasonKind: ExamReasonKind.optional(),
  reason: Reason.optional(),
})
export type ExamMarksPreview = z.infer<typeof ExamMarksPreview>

export const CoScholasticPreview = z.strictObject({
  kind: z.literal('co_scholastic'),
  sectionId: Id,
  sectionName: z.string().min(1).max(120),
  card: ReportCardKind,
  rows: z.array(z.strictObject({
    studentId: Id,
    name: PersonName,
    rollNumber: z.number().int().min(0).nullable(),
    /** The saved entry's version, 0 when nothing is saved: the save route's expectedVersion. */
    version: z.number().int().nonnegative(),
    current: CoScholasticGrades,
    proposed: CoScholasticGrades,
    currentRemarks: z.string().max(1000).nullable(),
    proposedRemarks: z.string().trim().max(1000).nullable(),
  })).min(1).max(RowLimit),
})
export type CoScholasticPreview = z.infer<typeof CoScholasticPreview>

export const AssistantProposalPreview = z.discriminatedUnion('kind', [
  AttendanceDayPreview,
  StaffAttendanceDayPreview,
  ExamMarksPreview,
  CoScholasticPreview,
])
export type AssistantProposalPreview = z.infer<typeof AssistantProposalPreview>

/** A proposal as the browser draws it. */
export const AssistantProposal = z.strictObject({
  id: Id,
  kind: AssistantProposalKind,
  /** "Mark 9 A for 26 Sep 2026". */
  title: z.string().min(1).max(200),
  status: AssistantProposalStatus,
  expiresAt: Timestamp,
  preview: AssistantProposalPreview,
  /** Plain words for a stale or failed proposal, or what was saved. */
  outcome: z.string().max(500).optional(),
  /** Where to see the record, once done. */
  href: AppPath.optional(),
  /** When it was confirmed, dismissed or found stale or failed. */
  decidedAt: Timestamp.optional(),
})
export type AssistantProposal = z.infer<typeof AssistantProposal>

/** A change tool's output: a proposal instead of a card. */
export const AssistantProposalToolOutput = z.strictObject({
  status: z.enum(['ok', 'not_available', 'failed', 'invalid']),
  proposal: AssistantProposal.optional(),
  /** For `invalid`: what the model asked for that cannot be proposed, in plain words. */
  problem: z.string().max(500).optional(),
  forModel: z.unknown().optional(),
})
export type AssistantProposalToolOutput = z.infer<typeof AssistantProposalToolOutput>

/** Confirming sends the preview as the person left it. */
export const ConfirmAssistantProposalRequest = z.strictObject({
  preview: AssistantProposalPreview,
})
export type ConfirmAssistantProposalRequest = z.infer<typeof ConfirmAssistantProposalRequest>

/** The proposal after the attempt: done, stale, failed or expired, with the reason in `outcome`. */
export const ConfirmAssistantProposalResponse = z.strictObject({
  proposal: AssistantProposal,
})
export type ConfirmAssistantProposalResponse = z.infer<typeof ConfirmAssistantProposalResponse>

/** The current state of every proposal in a thread, so a reopened conversation shows what happened. */
export const AssistantProposalStates = z.strictObject({
  items: z.array(AssistantProposal).max(200),
})
export type AssistantProposalStates = z.infer<typeof AssistantProposalStates>
