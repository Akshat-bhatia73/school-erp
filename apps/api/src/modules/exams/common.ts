import { sql, type SQL } from 'drizzle-orm'
import {
  AuthorizationError,
  examScopedTable,
  planPredicate,
  planPredicateWithout,
  reportCardScopedTable,
  scopedTableFor,
  type AuthzConnection,
} from '@erp/authz'
import {
  DEFAULT_GRADE_BANDS,
  DEFAULT_REPORT_CARD_LAYOUT,
  GradeBands,
  ReportCardLayout,
  ResultDisplayMode,
  markFromTenths,
  markToTenths,
  type ErrorReason,
  type ExamComponent,
  type ExamKind,
  type ExamPaperWindow,
  type ExamReasonKind,
  type ExamRef,
  type MarkValue,
  type ResultView,
  EXAM_PATTERN,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure, decideResource, readPlan, schoolToday } from '../shared/index.ts'
import { pupilRef, readSection, rosterOn, type RosterPupil, type SectionRow } from '../attendance/reads.ts'

/**
 * What the exams and report cards modules share, in one place.
 *
 * Nothing about a total, a grade or a completion count is stored: the current
 * mark follows from the newest row of `exam_marks`, a total from the scoring
 * rule in @erp/contracts, a grade from the school's bands. Every screen, file
 * and dashboard figure reads through the plans and the common table
 * expression here, so a list and its detail read, and a screen and its file,
 * cannot disagree. Nothing is fetched school-wide and filtered in JavaScript.
 */

export { schoolToday, rosterOn, pupilRef, readSection }
export type { RosterPupil, SectionRow }

/** The tenant transaction an exams read or write runs on. */
export type ExamConnection = AuthzConnection

type ExamPermission = 'exams.read' | 'exams.record_marks' | 'exams.manage' | 'exams.publish' | 'exams.export'
type ReportCardPermission = 'report_cards.read' | 'report_cards.manage' | 'report_cards.publish' | 'report_cards.export'

// ---------------------------------------------------------------------------
// Decisions on one record.

/** A denial on a named exam record answers like a record that is not there. */
export async function decideExam(
  conn: ExamConnection,
  context: RequestContext,
  permission: ExamPermission,
  id: string,
): Promise<void> {
  const decision = await decideResource(conn, context, permission, 'exam', id)
  if (!decision.allowed) {
    throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
  }
}

/** True when the caller holds this permission on this exam record. */
export async function mayOnExam(
  conn: ExamConnection,
  context: RequestContext,
  permission: ExamPermission,
  id: string,
): Promise<boolean> {
  return (await decideResource(conn, context, permission, 'exam', id)).allowed
}

/** A denial on a named report card record answers like a record that is not there. */
export async function decideReportCard(
  conn: ExamConnection,
  context: RequestContext,
  permission: ReportCardPermission,
  id: string,
): Promise<void> {
  const decision = await decideResource(conn, context, permission, 'report_card', id)
  if (!decision.allowed) {
    throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
  }
}

/** True when the caller holds this permission on this report card record. */
export async function mayOnReportCard(
  conn: ExamConnection,
  context: RequestContext,
  permission: ReportCardPermission,
  id: string,
): Promise<boolean> {
  return (await decideResource(conn, context, permission, 'report_card', id)).allowed
}

// ---------------------------------------------------------------------------
// Plans. Each is a SQL boolean over an unaliased table, exactly as the
// authorizer names it, so a query ANDs it into a WHERE clause or an EXISTS
// over that table.

/** The family scopes: a parent's, and a student's once student login exists. */
const FAMILY_SCOPES = ['own_children', 'own_record'] as const

function studentTable() {
  const scoped = scopedTableFor('student')
  if (!scoped) throw new Error('the authorizer has no scoped table for student')
  return scoped
}

async function basicPupils(conn: ExamConnection, context: RequestContext): Promise<SQL> {
  try {
    return planPredicate(await readPlan(conn, context, 'students.read_basic', 'student'), studentTable())
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'ACCESS_DENIED') return sql`FALSE`
    throw error
  }
}

export interface ExamPlans {
  /** Over `exams`: the exams' own rows. The office's; nobody else's plan selects one. */
  readonly exams: SQL
  /** Over `exam_papers`: the sheets this caller may see. */
  readonly papers: SQL
  /** Over `exam_marks`: every mark this caller may read. For a family scope, published rows only. */
  readonly marks: SQL
  /** Over `exam_marks`: the marks reached other than as a family, which are read live. */
  readonly staffMarks: SQL
  /** Over `students`: the pupils this caller may read results of AND may name. */
  readonly pupils: SQL
  /** Over `students`: the pupils reached other than as a family, AND named. */
  readonly staffPupils: SQL
}

/** The plans of one caller under an exams key. Throws when they hold it nowhere. */
export async function examPlans(
  conn: ExamConnection,
  context: RequestContext,
  permission: ExamPermission = 'exams.read',
): Promise<ExamPlans> {
  const plan = await readPlan(conn, context, permission, 'exam')
  const basic = await basicPupils(conn, context)
  return {
    exams: planPredicate(plan, examScopedTable('exam')),
    papers: planPredicate(plan, examScopedTable('paper')),
    marks: planPredicate(plan, examScopedTable('mark')),
    staffMarks: planPredicateWithout(plan, examScopedTable('mark'), FAMILY_SCOPES),
    pupils: sql`(${planPredicate(plan, examScopedTable('pupil'))}) AND (${basic})`,
    staffPupils: sql`(${planPredicateWithout(plan, examScopedTable('pupil'), FAMILY_SCOPES)}) AND (${basic})`,
  }
}

export interface ReportCardPlans {
  /** Over `report_card_versions`: the published cards this caller may read. */
  readonly cards: SQL
  /** Over `report_card_entries`: the class teacher's working rows. Never a family's. */
  readonly entries: SQL
  /** Over `sections`: the sections whose cards this caller may prepare or read. */
  readonly rosters: SQL
  /** Over `students`: the pupils whose cards this caller may read AND may name. */
  readonly pupils: SQL
  /** Over `students`: the pupils reached other than as a family, AND named. */
  readonly staffPupils: SQL
}

/** The plans of one caller under a report cards key. Throws when they hold it nowhere. */
export async function reportCardPlans(
  conn: ExamConnection,
  context: RequestContext,
  permission: ReportCardPermission = 'report_cards.read',
): Promise<ReportCardPlans> {
  const plan = await readPlan(conn, context, permission, 'report_card')
  const basic = await basicPupils(conn, context)
  return {
    cards: planPredicate(plan, reportCardScopedTable('card')),
    entries: planPredicate(plan, reportCardScopedTable('entry')),
    rosters: planPredicate(plan, reportCardScopedTable('roster')),
    pupils: sql`(${planPredicate(plan, reportCardScopedTable('pupil'))}) AND (${basic})`,
    staffPupils: sql`(${planPredicateWithout(plan, reportCardScopedTable('pupil'), FAMILY_SCOPES)}) AND (${basic})`,
  }
}

/**
 * Whose eyes an answer about this pupil is shaped for. `staff` when the
 * caller reaches the pupil through any scope other than a family one: live
 * marks, always as marks. Otherwise `family`: published figures only (the
 * plan already guarantees that) and, when the school shows grades, no marks.
 */
export async function resultViewFor(
  conn: ExamConnection,
  schoolId: string,
  studentId: string,
  staffPupils: SQL,
): Promise<ResultView> {
  const rows = await conn.db.execute<{ staff: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM students
          WHERE students.school_id = ${schoolId}::uuid AND students.id = ${studentId}::uuid
            AND (${staffPupils})) AS staff`,
  )
  return rows.rows[0]?.staff === true ? 'staff' : 'family'
}

// ---------------------------------------------------------------------------
// The current mark.

/**
 * The `ex_current` common table expression (without the WITH): the newest row
 * per paper, pupil and component among the rows `marks` allows, narrowed
 * further by `filter` (for example one paper, one pupil or one year), both
 * over the unaliased `exam_marks` table.
 *
 * Columns: id, paper_id, exam_id, academic_year_id, section_id, subject_id,
 * student_id, component, status, marks_tenths, revision, kind, reason_kind,
 * recorded_at.
 *
 * A family plan selects published rows only, so for a parent this is each
 * mark as it stood at the newest publication; a staff plan sees the live mark.
 */
export function currentMarksCte(input: { readonly schoolId: string; readonly marks: SQL; readonly filter?: SQL }): SQL {
  return sql`ex_current AS (
      SELECT DISTINCT ON (exam_marks.paper_id, exam_marks.student_id, exam_marks.component)
             exam_marks.id, exam_marks.paper_id, exam_marks.exam_id, exam_marks.academic_year_id,
             exam_marks.section_id, exam_marks.subject_id, exam_marks.student_id, exam_marks.component,
             exam_marks.status, exam_marks.marks_tenths, exam_marks.revision, exam_marks.kind,
             exam_marks.reason_kind, exam_marks.recorded_at
        FROM exam_marks
       WHERE exam_marks.school_id = ${input.schoolId}::uuid
         AND (${input.marks})
         AND (${input.filter ?? sql`TRUE`})
       ORDER BY exam_marks.paper_id, exam_marks.student_id, exam_marks.component, exam_marks.revision DESC
    )`
}

/** A stored row as the contract's value: a number of marks, or a status. */
export function markValueOf(status: string, marksTenths: number | null): MarkValue {
  if (status === 'marked' && marksTenths !== null) return markFromTenths(Number(marksTenths))
  if (status === 'absent' || status === 'medical' || status === 'exempt') return status
  throw new ApiFailure('SERVICE_UNAVAILABLE')
}

/** A value as the two stored columns. */
export function storedFormOf(value: MarkValue): { status: 'marked' | 'absent' | 'medical' | 'exempt'; marksTenths: number | null } {
  return typeof value === 'number' ? { status: 'marked', marksTenths: markToTenths(value) } : { status: value, marksTenths: null }
}

/** The newest stored row of one cell, read school-wide for a write. */
export interface StoredMark {
  readonly id: string
  readonly revision: number
  readonly status: string
  readonly marksTenths: number | null
}

export function cellKey(studentId: string, component: ExamComponent): string {
  return `${studentId}:${component}`
}

/**
 * The newest row of every cell of a paper, read across the whole school and
 * not through a plan: a revision must follow the row that really exists, or
 * the append-only index would refuse the insert. Only a write calls this,
 * after it has decided the paper.
 */
export async function storedMarks(
  conn: ExamConnection,
  schoolId: string,
  paperId: string,
): Promise<Map<string, StoredMark>> {
  const rows = await conn.client.query<{
    student_id: string
    component: ExamComponent
    id: string
    revision: number
    status: string
    marks_tenths: number | null
  }>(
    `SELECT DISTINCT ON (student_id, component) student_id, component, id, revision, status, marks_tenths
       FROM exam_marks
      WHERE school_id = $1 AND paper_id = $2
      ORDER BY student_id, component, revision DESC`,
    [schoolId, paperId],
  )
  return new Map(
    rows.rows.map((row) => [
      cellKey(row.student_id, row.component),
      {
        id: row.id,
        revision: Number(row.revision),
        status: row.status,
        marksTenths: row.marks_tenths === null ? null : Number(row.marks_tenths),
      },
    ]),
  )
}

/** Whether a stored cell already holds this value. */
export function sameValue(stored: StoredMark, value: MarkValue): boolean {
  const next = storedFormOf(value)
  return stored.status === next.status && stored.marksTenths === next.marksTenths
}

/**
 * One mark, appended. Nothing else ever writes to `exam_marks`. The exam, the
 * year, the section and the subject are copied from the paper, and the
 * composite foreign key refuses a row that disagrees with it.
 */
export async function insertMark(
  conn: ExamConnection,
  context: RequestContext,
  input: {
    readonly paper: PaperRow
    readonly studentId: string
    readonly component: ExamComponent
    readonly value: MarkValue
    readonly kind: 'entry' | 'correction'
    readonly reasonKind: ExamReasonKind | null
    readonly current: StoredMark | undefined
  },
): Promise<void> {
  const stored = storedFormOf(input.value)
  await conn.client.query(
    `INSERT INTO exam_marks (school_id, paper_id, exam_id, academic_year_id, section_id, subject_id, student_id,
                             component, status, marks_tenths, revision, supersedes_mark_id, kind, reason_kind,
                             recorded_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      context.schoolId,
      input.paper.id,
      input.paper.exam_id,
      input.paper.academic_year_id,
      input.paper.section_id,
      input.paper.subject_id,
      input.studentId,
      input.component,
      stored.status,
      stored.marksTenths,
      (input.current?.revision ?? 0) + 1,
      input.current?.id ?? null,
      input.kind,
      input.reasonKind,
      context.membershipId,
    ],
  )
}

// ---------------------------------------------------------------------------
// Exams and papers.

const DATE = `'YYYY-MM-DD'`

export interface ExamRow extends Record<string, unknown> {
  id: string
  academic_year_id: string
  year_name: string
  kind: ExamKind
  starts_on: string
  ends_on: string
  recheck_deadline: string
  version: number
}

/**
 * One exam with its year. The record has already been decided, so this read
 * is bounded by the school alone.
 */
export async function readExam(conn: ExamConnection, schoolId: string, examId: string): Promise<ExamRow> {
  const rows = await conn.client.query<ExamRow>(
    `SELECT exams.id, exams.academic_year_id, ay.name AS year_name, exams.kind,
            to_char(exams.starts_on, ${DATE}) AS starts_on, to_char(exams.ends_on, ${DATE}) AS ends_on,
            to_char(exams.recheck_deadline, ${DATE}) AS recheck_deadline, exams.version
       FROM exams
       JOIN academic_years ay ON ay.school_id = exams.school_id AND ay.id = exams.academic_year_id
      WHERE exams.school_id = $1 AND exams.id = $2`,
    [schoolId, examId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return { ...row, version: Number(row.version) }
}

export interface PaperRow extends Record<string, unknown> {
  id: string
  exam_id: string
  academic_year_id: string
  section_id: string
  section_name: string
  grade_id: string
  grade_name: string
  subject_id: string
  subject_name: string
  kind: ExamKind
  starts_on: string
  ends_on: string
  recheck_deadline: string
}

/**
 * One paper with its exam, section, class and subject. The record has already
 * been decided, so this read is bounded by the school alone.
 */
export async function readPaper(conn: ExamConnection, schoolId: string, paperId: string): Promise<PaperRow> {
  const rows = await conn.client.query<PaperRow>(
    `SELECT p.id, p.exam_id, p.academic_year_id, p.section_id, sec.name AS section_name,
            g.id AS grade_id, g.name AS grade_name, p.subject_id, sub.name AS subject_name,
            e.kind, to_char(e.starts_on, ${DATE}) AS starts_on, to_char(e.ends_on, ${DATE}) AS ends_on,
            to_char(e.recheck_deadline, ${DATE}) AS recheck_deadline
       FROM exam_papers p
       JOIN exams e ON e.school_id = p.school_id AND e.id = p.exam_id
       JOIN sections sec ON sec.school_id = p.school_id AND sec.id = p.section_id
       JOIN grades g ON g.school_id = sec.school_id AND g.id = sec.grade_id
       JOIN subjects sub ON sub.school_id = p.school_id AND sub.id = p.subject_id
      WHERE p.school_id = $1 AND p.id = $2`,
    [schoolId, paperId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

/** The exam as a paper or a result names it. */
export function examRef(row: {
  readonly exam_id?: string
  readonly id?: string
  readonly kind: ExamKind
  readonly starts_on: string
  readonly ends_on: string
  readonly recheck_deadline: string
}): ExamRef {
  const id = row.exam_id ?? row.id
  if (id === undefined) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return {
    id,
    kind: row.kind,
    term: EXAM_PATTERN[row.kind].term,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    recheckDeadline: row.recheck_deadline,
  }
}

// ---------------------------------------------------------------------------
// The window.

export type ExamState = 'not_started' | 'open' | 'locked'

/**
 * Where an exam stands on a day, by its dates alone. Open from its first day
 * to the end of its re-check deadline in the school's timezone (today is the
 * school's today, from schoolToday), locked after. Nothing runs at the
 * deadline; the state is worked out each time it is asked for.
 */
export function examState(exam: { readonly starts_on: string; readonly recheck_deadline: string }, today: string): ExamState {
  if (today < exam.starts_on) return 'not_started'
  if (today <= exam.recheck_deadline) return 'open'
  return 'locked'
}

/**
 * What the server will accept on a paper from this caller. The marks sheet
 * (exams.record_marks) is open from the first day to the end of the re-check
 * deadline; a correction (exams.manage) from the first day on. A caller who
 * lacks the permission gets no reason: there is nothing about the exam to
 * explain to them.
 */
export function paperWindow(input: {
  readonly state: ExamState
  readonly mayRecord: boolean
  readonly mayCorrect: boolean
}): ExamPaperWindow {
  const recordReason: ErrorReason | undefined =
    input.state === 'not_started'
      ? 'exam_not_started'
      : input.state === 'locked'
        ? 'exam_recheck_deadline_passed'
        : undefined
  const correctReason: ErrorReason | undefined = input.state === 'not_started' ? 'exam_not_started' : undefined
  const record = input.mayRecord && recordReason === undefined
  const correct = input.mayCorrect && correctReason === undefined
  return {
    state: input.state,
    record,
    ...(input.mayRecord && recordReason !== undefined ? { recordBlockedBy: recordReason } : {}),
    correct,
    ...(input.mayCorrect && correctReason !== undefined ? { correctBlockedBy: correctReason } : {}),
  }
}

// ---------------------------------------------------------------------------
// Publications.

/**
 * The newest publication of one exam for one section, and whether any mark
 * of that exam and section was written after it. Null when it was never
 * published. Read school-wide: the caller has already decided the section.
 */
export async function publicationState(
  conn: ExamConnection,
  schoolId: string,
  examId: string,
  sectionId: string,
): Promise<{ publishedAt: string; changedSince: boolean } | null> {
  const rows = await conn.client.query<{ published_at: string; changed_since: boolean }>(
    `SELECT to_char(pub.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at,
            EXISTS (SELECT 1 FROM exam_marks m
                     WHERE m.school_id = pub.school_id AND m.exam_id = pub.exam_id
                       AND m.section_id = pub.section_id AND m.recorded_at > pub.published_at) AS changed_since
       FROM exam_publications pub
      WHERE pub.school_id = $1 AND pub.exam_id = $2 AND pub.section_id = $3
      ORDER BY pub.published_at DESC LIMIT 1`,
    [schoolId, examId, sectionId],
  )
  const row = rows.rows[0]
  return row ? { publishedAt: row.published_at, changedSince: row.changed_since === true } : null
}

// ---------------------------------------------------------------------------
// The school's settings.

export interface SettingsRow {
  readonly displayMode: ResultDisplayMode
  readonly gradeBands: GradeBands
  readonly layout: ReportCardLayout
  /** 0 while the school uses the defaults and has never saved its own. */
  readonly version: number
  readonly updatedAt: string | null
}

/**
 * The grade bands, the marks-or-grades choice and the layout this school uses
 * today: its own row, or the defaults while it has none. The stored JSON is
 * parsed through the same contracts a save is checked against; a row that no
 * longer parses is a server fault, never silently replaced by the defaults.
 */
export async function readExamSettings(conn: ExamConnection, schoolId: string): Promise<SettingsRow> {
  const rows = await conn.client.query<{
    display_mode: string
    grade_bands: unknown
    layout: unknown
    version: number
    updated_at: string
  }>(
    `SELECT display_mode, grade_bands, layout, version,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS updated_at
       FROM exam_settings WHERE school_id = $1`,
    [schoolId],
  )
  const row = rows.rows[0]
  if (!row) {
    return {
      displayMode: 'marks',
      gradeBands: DEFAULT_GRADE_BANDS,
      layout: DEFAULT_REPORT_CARD_LAYOUT,
      version: 0,
      updatedAt: null,
    }
  }
  const displayMode = ResultDisplayMode.safeParse(row.display_mode)
  const gradeBands = GradeBands.safeParse(row.grade_bands)
  const layout = ReportCardLayout.safeParse(row.layout)
  if (!displayMode.success || !gradeBands.success || !layout.success) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return {
    displayMode: displayMode.data,
    gradeBands: gradeBands.data,
    layout: layout.data,
    version: Number(row.version),
    updatedAt: row.updated_at,
  }
}
