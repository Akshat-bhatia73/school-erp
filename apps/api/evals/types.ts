/**
 * The shape of the assistant's evaluation set. A scenario is one question a
 * real person in the seeded Sunrise school could ask, who asks it, and what a
 * good answer must and must not do. See docs/assistant/EVALS.md.
 */
import type pg from 'pg'
import type { AssistantProposalKind, AssistantProposalPreview } from '@erp/contracts'

/** Who asks. Each is one seeded login (evals/facts.ts). */
export type EvalRole = 'owner' | 'principal' | 'admin' | 'accountant' | 'teacher' | 'parent' | 'pupil'

export type Language = 'en' | 'hi' | 'mixed'

/** What a scenario measures. The report totals each one. */
export type Dimension = 'grounding' | 'tool_choice' | 'write_intent' | 'access' | 'completeness' | 'language'

/**
 * What the person wants, for the release gates: a task the assistant should
 * do (read or propose), one it must ask about first, or one it must refuse.
 */
export type Intent = 'read' | 'propose' | 'ask' | 'refuse'

/** A string is matched case-insensitively as it is; a regex as written. */
export type Matcher = string | RegExp

/** Words the answer must or must not hold. */
export interface Expectations {
  /** Every one of these. */
  readonly mustMention?: readonly Matcher[]
  /** At least one of these. */
  readonly mustMentionAny?: readonly Matcher[]
  /** None of these: a wrong claim, such as "saved" before anyone confirmed. */
  readonly mustNotMention?: readonly Matcher[]
  /**
   * None of these, anywhere the person can see them (the answer or any tool
   * result sent to the browser): a fact this person may not read. A hit is
   * an unauthorised disclosure, which fails the release gate on its own.
   */
  readonly mustNotReveal?: readonly Matcher[]
}

export interface Checks extends Expectations {
  /** Tools the model must call, at least these. An inner array means any one of them. */
  readonly expectedTools?: readonly (string | readonly string[])[]
  /** Tools it must not call. A name ending in `*` is a prefix. */
  readonly forbiddenTools?: readonly string[]
  /** No tool call at all: an unsupported change, or off-topic. */
  readonly expectNoTools?: boolean
  readonly maxToolCalls?: number
  /** A proposal card of this kind must be made. */
  readonly expectProposal?: AssistantProposalKind
  /** No proposal may be made. A proposal here is an unrequested write. */
  readonly expectNoProposal?: boolean
  /** The answer must ask the person something back (it holds a question mark). */
  readonly asksBack?: boolean
}

/** The seeded people and records the scenarios are written about, read once per run. */
export interface SectionFact {
  readonly id: string
  /** "UKG A", "Class 9 A". */
  readonly label: string
  /** "UKG A" as a teacher types it: "UKG A" or "9A". */
  readonly short: string
}

export interface PupilFact {
  readonly id: string
  readonly name: string
  readonly firstName: string
  readonly lastName: string
  readonly admissionNumber: string
  readonly section: SectionFact
}

export interface PersonFact {
  readonly name: string
  readonly membershipId: string
  readonly userId: string
}

export interface Facts {
  readonly schoolId: string
  readonly schoolName: string
  /** Today in the school's timezone, YYYY-MM-DD. */
  readonly today: string
  readonly tomorrow: string
  /** Not a Sunday or a holiday: registers are expected today. */
  readonly schoolDay: boolean
  readonly yearName: string
  readonly people: Readonly<Record<EvalRole, PersonFact>>
  readonly teacher: {
    readonly staffId: string
    /** The section they are class teacher of; its register is blank today. */
    readonly classSection: SectionFact
    readonly classPupils: readonly PupilFact[]
    /** Pupils of their class whose first name no classmate shares, the injected pupil left out. */
    readonly named: readonly PupilFact[]
    /** A section they do not teach at all. */
    readonly otherSection: SectionFact
    /** A periodic test 2 paper of theirs with no marks yet, when there is one. */
    readonly openPaper: { readonly section: SectionFact; readonly subject: string; readonly pupils: readonly PupilFact[] } | null
    /** Two pupils of their class who share a first name (evals/extras.ts). */
    readonly twins: readonly [PupilFact, PupilFact]
  }
  readonly principalView: {
    /** A pupil of Class 9 A, the pupil login's classmate. */
    readonly pupil: PupilFact
    /** A section whose register is marked today. */
    readonly markedSection: SectionFact
  }
  readonly parent: {
    readonly children: readonly PupilFact[]
    /** A pupil who is not their child. */
    readonly otherChild: PupilFact
  }
  readonly pupil: {
    readonly self: PupilFact
    readonly classmate: PupilFact
    readonly classTeacher: string
  }
  /** The pupil whose health note holds an instruction (evals/extras.ts). */
  readonly injected: PupilFact
  /** A staff member other than the admin, for the staff register. */
  readonly staffMember: { readonly id: string; readonly name: string; readonly firstName: string }
}

/** What a truth function may read: the fixture database as its owner, never through the app. */
export interface TruthContext {
  readonly db: pg.Pool
  readonly facts: Facts
}

/** What the scripted model has seen so far in one turn, for building the next call. */
export interface ScriptState {
  readonly facts: Facts
  /** The tool results of this turn so far, as the model read them. */
  readonly results: readonly { readonly tool: string; readonly value: unknown }[]
  /** The whole prompt as JSON, for an answer about earlier turns. */
  readonly prompt: string
}

export interface ScriptStep {
  readonly tool: string
  readonly input: (state: ScriptState) => Record<string, unknown>
}

/** How the scripted model (--scripted) answers one turn: these calls, then words. */
export interface Script {
  readonly steps: readonly ScriptStep[]
  /** The words. By default a plain listing of what the tools returned (evals/scripted.ts). */
  readonly say?: (state: ScriptState) => string
}

/** A turn before the measured question, in the same conversation. */
export interface SetupTurn {
  readonly question: (facts: Facts) => string
  readonly script?: Script
  /**
   * Confirm the proposal this turn made, with the preview as the person
   * edited it on the card. The turn must have made one.
   */
  readonly confirm?: (preview: AssistantProposalPreview, facts: Facts) => AssistantProposalPreview
}

export interface Scenario {
  /** Stable: reports are compared by it. */
  readonly id: string
  readonly role: EvalRole
  readonly language: Language
  /** High-risk scenarios run `repeat` times and pass only if every run passes. */
  readonly risk: 'high' | 'normal'
  readonly intent: Intent
  /** What it measures; `language` is added for every hi or mixed scenario. */
  readonly dimensions: readonly Dimension[]
  readonly question: (facts: Facts) => string
  readonly checks: (facts: Facts) => Checks
  /** Facts read from the fixture database that the answer must match. */
  readonly truth?: (context: TruthContext) => Promise<Expectations>
  readonly setup?: readonly SetupTurn[]
  /** It confirms a change, so it runs once, after every scenario that does not. */
  readonly writes?: boolean
  /** A reason not to run today, such as "today is not a school day". */
  readonly skip?: (facts: Facts) => string | null
  /** For --scripted. A scenario without one is skipped in that mode. */
  readonly script?: Script
}

/** One tool call in a turn, as the browser received it. */
export interface ToolCallRecord {
  readonly toolCallId: string
  readonly tool: string
  readonly input: unknown
  /** The tool's output as sent to the browser: status, card, forModel, proposal. */
  readonly output: unknown
}

/** One turn, parsed from the UI message stream. */
export interface TurnRecord {
  readonly httpStatus: number
  readonly calls: readonly ToolCallRecord[]
  readonly text: string
  readonly proposals: readonly { readonly id: string; readonly kind: string; readonly preview: AssistantProposalPreview }[]
  /** The stream said the turn failed. */
  readonly errored: boolean
}

/** Why a check failed, grouped the way the release gates read them. */
export type FailureKind =
  | 'disclosure'
  | 'unrequested_write'
  | 'tool'
  | 'mention'
  | 'wrong_claim'
  | 'proposal'
  | 'ask'
  | 'language'
  | 'error'

export interface Failure {
  readonly kind: FailureKind
  readonly reason: string
}
