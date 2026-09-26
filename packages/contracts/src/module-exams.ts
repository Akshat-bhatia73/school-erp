/** Task 21 request and response contracts owned by the exams module. */
import { z } from 'zod'
import { CalendarDate, DisplayName, Id, Reason, Timestamp, Version } from './common.ts'
import { ErrorReason } from './errors.ts'
import { AllowedActions, ExportJobSummary, NamedReference } from './responses.ts'

// ---------------------------------------------------------------------------
// The fixed pattern.
//
// Every class of every school follows the CBSE two-term scheme, decided by the
// product owner on 23 September 2026. It lives here, in code, and no school
// can edit it: a school sets only when each exam happens and when its
// re-check window closes.
//
// Term 1 is periodic test 1 (out of 10), notebook (5), subject enrichment (5)
// and the half-yearly exam (80), out of 100. Term 2 is the same with periodic
// test 2 and the annual exam. The notebook and subject enrichment marks are
// recorded against the term's main exam, so each term has two exams: the
// periodic test, with one component, and the main exam, with three.

export const ExamKind = z.enum(['periodic_test_1', 'half_yearly', 'periodic_test_2', 'annual'])
export type ExamKind = z.infer<typeof ExamKind>
export const EXAM_KINDS = ExamKind.options

export const ExamTerm = z.enum(['term_1', 'term_2'])
export type ExamTerm = z.infer<typeof ExamTerm>
export const EXAM_TERMS = ExamTerm.options

export const ExamComponent = z.enum(['periodic_test', 'notebook', 'subject_enrichment', 'written'])
export type ExamComponent = z.infer<typeof ExamComponent>

/** What each component is out of. Marks are entered against these, with no scaling. */
export const EXAM_COMPONENTS: Readonly<Record<ExamComponent, { readonly label: string; readonly maxMarks: number }>> = {
  periodic_test: { label: 'Periodic test', maxMarks: 10 },
  notebook: { label: 'Notebook', maxMarks: 5 },
  subject_enrichment: { label: 'Subject enrichment', maxMarks: 5 },
  written: { label: 'Written exam', maxMarks: 80 },
}

export interface ExamPatternEntry {
  readonly term: ExamTerm
  readonly label: string
  readonly components: readonly ExamComponent[]
}

export const EXAM_PATTERN: Readonly<Record<ExamKind, ExamPatternEntry>> = {
  periodic_test_1: { term: 'term_1', label: 'Periodic test 1', components: ['periodic_test'] },
  half_yearly: { term: 'term_1', label: 'Half-yearly exam', components: ['notebook', 'subject_enrichment', 'written'] },
  periodic_test_2: { term: 'term_2', label: 'Periodic test 2', components: ['periodic_test'] },
  annual: { term: 'term_2', label: 'Annual exam', components: ['notebook', 'subject_enrichment', 'written'] },
}

/**
 * The two exams of each term, periodic test first. The main exam is the one
 * whose roster is the term's roster and whose last day ends the term.
 */
export const TERM_PATTERN: Readonly<
  Record<ExamTerm, { readonly label: string; readonly exams: readonly [ExamKind, ExamKind]; readonly mainExam: ExamKind }>
> = {
  term_1: { label: 'Term 1', exams: ['periodic_test_1', 'half_yearly'], mainExam: 'half_yearly' },
  term_2: { label: 'Term 2', exams: ['periodic_test_2', 'annual'], mainExam: 'annual' },
}

/** A subject's final percentage below this is a subject that needs improvement. */
export const EXAM_PASS_PERCENTAGE = 33

// ---------------------------------------------------------------------------
// A mark.

/** A status in place of a mark. Absent counts as zero; medical and exempt leave the component out. */
export const MarkStatus = z.enum(['absent', 'medical', 'exempt'])
export type MarkStatus = z.infer<typeof MarkStatus>

/** A mark with at most one decimal place, never above the largest component. */
export const MarkNumber = z
  .number()
  .min(0)
  .max(80)
  .refine((value) => Math.abs(value * 10 - Math.round(value * 10)) < 1e-6, 'At most one decimal place')

/** What a cell of the marks sheet holds once it is filled in: a mark or a status. */
export const MarkValue = z.union([MarkNumber, MarkStatus])
export type MarkValue = z.infer<typeof MarkValue>

/** Marks are stored as whole tenths, so 7.5 is 75 and no float ever reaches the database. */
export function markToTenths(value: number): number {
  return Math.round(value * 10)
}

export function markFromTenths(tenths: number): number {
  return tenths / 10
}

/** Whether a value fits the component it is entered against. */
export function markFitsComponent(component: ExamComponent, value: MarkValue): boolean {
  if (typeof value !== 'number') return true
  return markToTenths(value) <= EXAM_COMPONENTS[component].maxMarks * 10
}

/** One component of one subject as the scoring rule sees it. Null is "not entered". */
export interface ScoredPart {
  readonly component: ExamComponent
  readonly value: MarkValue | null
}

export interface ScoredTotal {
  /** Marks scored over the components that count, in tenths. */
  readonly scoredTenths: number
  /** What the components that count are out of. */
  readonly outOf: number
  /** Scaled to 100, to one decimal; null when no component counts. */
  readonly percentage: number | null
}

/**
 * The one scoring rule, shared by the API, the files and the screens.
 *
 * A component with a mark counts that mark against its maximum. Absent counts
 * as zero against its maximum. Medical, exempt and a component with nothing
 * entered (for example a periodic test held before the pupil joined) are left
 * out: neither the mark nor the maximum is added. The total is what was scored
 * over what the counted components are out of, scaled to 100 and rounded to
 * one decimal place, half up. With every component counted a term is already
 * out of 100, so nothing is scaled.
 */
export function scoreParts(parts: readonly ScoredPart[]): ScoredTotal {
  let scoredTenths = 0
  let outOf = 0
  for (const part of parts) {
    if (part.value === null || part.value === 'medical' || part.value === 'exempt') continue
    outOf += EXAM_COMPONENTS[part.component].maxMarks
    if (typeof part.value === 'number') scoredTenths += markToTenths(part.value)
  }
  if (outOf === 0) return { scoredTenths, outOf, percentage: null }
  // scored / outOf * 100, to one decimal: (tenths / 10) / outOf * 100 * 10 / 10.
  const percentage = Math.round((scoredTenths * 100) / outOf) / 10
  return { scoredTenths, outOf, percentage: Math.min(100, percentage) }
}

/**
 * A subject's final figure on the final card: the mean of the two term
 * percentages, to one decimal, half up; the one term there is when the other
 * counted nothing; null when neither did.
 */
export function finalPercentage(term1: number | null, term2: number | null): number | null {
  const present = [term1, term2].filter((value): value is number => value !== null)
  if (present.length === 0) return null
  const sum = present.reduce((total, value) => total + value * 10, 0)
  return Math.round(sum / present.length) / 10
}

/**
 * The overall figure on the final card: the mean of the subjects' final
 * percentages (subjects with none are left out), to one decimal, and whether
 * every subject reached the pass percentage.
 */
export function overallResult(finals: readonly (number | null)[]): {
  readonly percentage: number | null
  readonly result: 'pass' | 'needs_improvement' | null
} {
  const present = finals.filter((value): value is number => value !== null)
  if (present.length === 0) return { percentage: null, result: null }
  const sum = present.reduce((total, value) => total + value * 10, 0)
  const percentage = Math.round(sum / present.length) / 10
  const result = present.every((value) => value >= EXAM_PASS_PERCENTAGE) ? 'pass' : 'needs_improvement'
  return { percentage, result }
}

/** Why a saved mark changed. The words somebody typed are the audit note. */
export const ExamReasonKind = z.enum(['recheck', 'entry_error', 'other'])
export type ExamReasonKind = z.infer<typeof ExamReasonKind>

// ---------------------------------------------------------------------------
// Exam dates, set by the office for each academic year.

export const ExamSchedule = z.strictObject({
  id: Id,
  academicYear: NamedReference,
  kind: ExamKind,
  term: ExamTerm,
  startsOn: CalendarDate,
  endsOn: CalendarDate,
  recheckDeadline: CalendarDate,
  /** True once the re-check deadline has passed: after the end of that day in the school's timezone. */
  locked: z.boolean(),
  /** Sections with at least one paper for this exam. */
  sectionsTotal: z.number().int().nonnegative(),
  /** Sections whose results for this exam have been published at least once. */
  sectionsPublished: z.number().int().nonnegative(),
  version: Version,
  allowedActions: AllowedActions,
})
export type ExamSchedule = z.infer<typeof ExamSchedule>

export const ExamListRequest = z.strictObject({ academicYearId: Id })
export type ExamListRequest = z.infer<typeof ExamListRequest>

export const ExamListResponse = z.strictObject({
  academicYear: NamedReference,
  /** Today in the school's timezone, which every window on the screen is measured against. */
  today: CalendarDate,
  items: z.array(ExamSchedule).max(4),
})
export type ExamListResponse = z.infer<typeof ExamListResponse>

const examDates = {
  startsOn: CalendarDate,
  endsOn: CalendarDate,
  recheckDeadline: CalendarDate,
}

const datesInOrder = (value: { startsOn: string; endsOn: string; recheckDeadline: string }): boolean =>
  value.startsOn <= value.endsOn && value.endsOn <= value.recheckDeadline

export const ExamCreateRequest = z
  .strictObject({ academicYearId: Id, kind: ExamKind, ...examDates })
  .refine(datesInOrder, 'The exam must end on or after its first day, and the re-check deadline must be on or after its last day')
export type ExamCreateRequest = z.infer<typeof ExamCreateRequest>

export const ExamUpdateRequest = z
  .strictObject({ expectedVersion: Version, ...examDates })
  .refine(datesInOrder, 'The exam must end on or after its first day, and the re-check deadline must be on or after its last day')
export type ExamUpdateRequest = z.infer<typeof ExamUpdateRequest>

// ---------------------------------------------------------------------------
// Papers: one exam, one section, one subject.

/** The pupil a mark belongs to, named no further than a roster names them. */
export const ExamPupil = z.strictObject({
  id: Id,
  name: DisplayName,
  admissionNumber: z.string().min(1).max(100),
  rollNumber: z.number().int().positive().optional(),
})
export type ExamPupil = z.infer<typeof ExamPupil>

/** The exam a paper belongs to, as a paper names it. */
export const ExamRef = z.strictObject({
  id: Id,
  kind: ExamKind,
  term: ExamTerm,
  startsOn: CalendarDate,
  endsOn: CalendarDate,
  recheckDeadline: CalendarDate,
})
export type ExamRef = z.infer<typeof ExamRef>

/**
 * What the server will accept on this paper from this caller, worked out once
 * so the screen and the write agree. `state` follows the dates alone: before
 * the first day, from the first day to the end of the re-check deadline, and
 * after it. `record` is the marks sheet (exams.record_marks, open state only);
 * `correct` is the office's correction with a reason (exams.manage, from the
 * first day on). A caller who lacks the permission gets no reason.
 */
export const ExamPaperWindow = z.strictObject({
  state: z.enum(['not_started', 'open', 'locked']),
  record: z.boolean(),
  recordBlockedBy: ErrorReason.optional(),
  correct: z.boolean(),
  correctBlockedBy: ErrorReason.optional(),
})
export type ExamPaperWindow = z.infer<typeof ExamPaperWindow>

export const ExamPaperSummary = z.strictObject({
  id: Id,
  exam: ExamRef,
  section: NamedReference,
  grade: NamedReference,
  subject: NamedReference,
  /** Pupils on the roster: enrolled in the section on the exam's first day. */
  pupils: z.number().int().nonnegative(),
  /** Cells with a mark or a status, over the roster and the exam's components. */
  entered: z.number().int().nonnegative(),
  /** Pupils times components. */
  expected: z.number().int().nonnegative(),
  window: ExamPaperWindow,
  /** Whether this exam's results have been published for this section. */
  published: z.boolean(),
  allowedActions: AllowedActions,
})
export type ExamPaperSummary = z.infer<typeof ExamPaperSummary>

export const ExamPapersRequest = z.strictObject({
  academicYearId: Id,
  examId: Id.optional(),
  sectionId: Id.optional(),
  subjectId: Id.optional(),
})
export type ExamPapersRequest = z.infer<typeof ExamPapersRequest>

export const ExamPapersResponse = z.strictObject({
  today: CalendarDate,
  items: z.array(ExamPaperSummary).max(2000),
})
export type ExamPapersResponse = z.infer<typeof ExamPapersResponse>

/** One filled cell, with the stored row behind it. */
export const ExamSheetCell = z.strictObject({
  component: ExamComponent,
  value: MarkValue,
  revision: z.number().int().positive(),
  kind: z.enum(['entry', 'correction']),
  recordedAt: Timestamp,
})
export type ExamSheetCell = z.infer<typeof ExamSheetCell>

export const ExamSheetRow = z.strictObject({
  student: ExamPupil,
  /** The filled cells only. A component with no cell is not entered yet. */
  cells: z.array(ExamSheetCell).max(4),
})
export type ExamSheetRow = z.infer<typeof ExamSheetRow>

export const ExamSheetComponent = z.strictObject({
  key: ExamComponent,
  label: z.string().min(1).max(60),
  maxMarks: z.number().int().positive(),
})

/** The full marks sheet: roster down, components across. */
export const ExamSheet = z.strictObject({
  paper: ExamPaperSummary,
  components: z.array(ExamSheetComponent).min(1).max(4),
  rows: z.array(ExamSheetRow).max(200),
})
export type ExamSheet = z.infer<typeof ExamSheet>

/**
 * `expectedRevision` is the revision of the cell the writer read (0 when it
 * was empty). When sent, the server refuses the whole write with
 * VERSION_CONFLICT if the cell has moved since. Optional only so an older
 * screen still saves.
 */
export const ExamMarkLine = z.strictObject({
  studentId: Id,
  component: ExamComponent,
  value: MarkValue,
  expectedRevision: z.number().int().nonnegative().optional(),
})
export type ExamMarkLine = z.infer<typeof ExamMarkLine>

/** A cell may appear once in a body. */
const ExamMarkLines = z
  .array(ExamMarkLine)
  .max(800)
  .refine(
    (lines) => new Set(lines.map((line) => `${line.studentId}:${line.component}`)).size === lines.length,
    'Each pupil and component may appear once',
  )

/** Why saved marks changed, for a save that changes any of them. */
export const ExamChange = z.strictObject({ reasonKind: ExamReasonKind, reason: Reason })
export type ExamChange = z.infer<typeof ExamChange>

/**
 * The marks sheet, saved in one write. Every filled cell is sent; a cell left
 * out is not entered yet, and a filled cell is never emptied again. A new row
 * is written only where the value differs from the current one, and any such
 * change to a cell that was already saved needs `change`.
 */
export const ExamMarksSaveRequest = z.strictObject({
  entries: ExamMarkLines,
  change: ExamChange.optional(),
})
export type ExamMarksSaveRequest = z.infer<typeof ExamMarksSaveRequest>

/** The office's correction: the changed cells only, always with a reason. */
export const ExamMarksCorrectionRequest = z.strictObject({
  entries: ExamMarkLines.refine((lines) => lines.length > 0, 'Name at least one mark'),
  reasonKind: ExamReasonKind,
  reason: Reason,
})
export type ExamMarksCorrectionRequest = z.infer<typeof ExamMarksCorrectionRequest>

/** Every stored row of one cell, oldest first. The reason's words are in the audit log. */
export const ExamMarkHistory = z.strictObject({
  student: ExamPupil,
  component: ExamComponent,
  rows: z
    .array(
      z.strictObject({
        id: Id,
        value: MarkValue,
        revision: z.number().int().positive(),
        kind: z.enum(['entry', 'correction']),
        reasonKind: ExamReasonKind.optional(),
        recordedAt: Timestamp,
        recordedBy: DisplayName.optional(),
      }),
    )
    .max(200),
})
export type ExamMarkHistory = z.infer<typeof ExamMarkHistory>

export const ExamMarkHistoryRequest = z.strictObject({ component: ExamComponent })
export type ExamMarkHistoryRequest = z.infer<typeof ExamMarkHistoryRequest>

// ---------------------------------------------------------------------------
// Moderation and publishing: one exam across the school.

export const ExamSectionPaper = z.strictObject({
  paperId: Id,
  subject: NamedReference,
  entered: z.number().int().nonnegative(),
  expected: z.number().int().nonnegative(),
  complete: z.boolean(),
})

export const ExamSectionStatus = z.strictObject({
  section: NamedReference,
  grade: NamedReference,
  pupils: z.number().int().nonnegative(),
  papers: z.array(ExamSectionPaper).max(30),
  /** Every pupil has a mark or a status for every subject and component. */
  complete: z.boolean(),
  /** The newest publication, with whether any mark was written after it. */
  publication: z.strictObject({ publishedAt: Timestamp, changedSince: z.boolean() }).nullable(),
  /** Locked, complete, and either never published or changed since. */
  readyToPublish: z.boolean(),
  /** Why it is not ready, when that is something the office can act on. */
  blockedBy: ErrorReason.optional(),
})
export type ExamSectionStatus = z.infer<typeof ExamSectionStatus>

export const ExamOverview = z.strictObject({
  exam: ExamSchedule,
  today: CalendarDate,
  sections: z.array(ExamSectionStatus).max(500),
})
export type ExamOverview = z.infer<typeof ExamOverview>

export const ExamPublishRequest = z.strictObject({})
export type ExamPublishRequest = z.infer<typeof ExamPublishRequest>

// ---------------------------------------------------------------------------
// One pupil's results for a year.

/**
 * Whose eyes a result is shaped for. `staff` is anybody who reaches the pupil
 * other than as their parent (the office, the class teacher, a subject
 * teacher): live marks, always as marks. `family` is a parent: each exam as
 * it stood at its newest publication, and grades only when the school shows
 * grades.
 */
export const ResultView = z.enum(['staff', 'family'])
export type ResultView = z.infer<typeof ResultView>

/** Whether report cards and parent screens show marks with grades, or grades alone. */
export const ResultDisplayMode = z.enum(['marks', 'grades'])
export type ResultDisplayMode = z.infer<typeof ResultDisplayMode>

export const ExamResultComponent = z.strictObject({
  component: ExamComponent,
  /** Absent when nothing is entered, and always absent in a family view under grades. */
  value: MarkValue.optional(),
})

export const ExamResultSubject = z.strictObject({
  subject: NamedReference,
  /** Empty in a family view under grades. */
  components: z.array(ExamResultComponent).max(4),
  /** The subject's figure for this exam scaled to 100; omitted in a family view under grades. */
  percentage: z.number().min(0).max(100).nullable().optional(),
  grade: z.string().min(1).max(8).nullable(),
})

export const ExamResult = z.strictObject({
  exam: ExamRef,
  /** The newest publication for the pupil's section; always set in a family view. */
  publishedAt: Timestamp.optional(),
  subjects: z.array(ExamResultSubject).max(30),
})
export type ExamResult = z.infer<typeof ExamResult>

export const ExamResultsRequest = z.strictObject({ academicYearId: Id })
export type ExamResultsRequest = z.infer<typeof ExamResultsRequest>

export const ExamResultsResponse = z.strictObject({
  student: ExamPupil,
  academicYear: NamedReference,
  section: NamedReference.optional(),
  grade: NamedReference.optional(),
  view: ResultView,
  /** What this answer shows: always `marks` in a staff view. */
  displayMode: ResultDisplayMode,
  exams: z.array(ExamResult).max(4),
})
export type ExamResultsResponse = z.infer<typeof ExamResultsResponse>

// ---------------------------------------------------------------------------
// Files.

export const ExamMarksRegisterExportRequest = z.strictObject({})
export type ExamMarksRegisterExportRequest = z.infer<typeof ExamMarksRegisterExportRequest>

export const ExamExportJob = ExportJobSummary
export type ExamExportJob = z.infer<typeof ExamExportJob>
