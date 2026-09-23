import { sql, type SQL } from 'drizzle-orm'
import { AuthorizationError, planPredicate, scopedTableFor } from '@erp/authz'
import {
  EXAM_COMPONENTS,
  EXAM_KINDS,
  EXAM_PATTERN,
  ExamListResponse,
  ExamMarkHistory,
  ExamOverview,
  ExamPapersResponse,
  ExamResultsResponse,
  ExamSheet,
  gradeFor,
  scoreParts,
  type ErrorReason,
  type ExamComponent,
  type ExamKind,
  type ExamPaperSummary,
  type ExamPapersRequest,
  type ExamReasonKind,
  type ExamResult,
  type ExamSchedule,
  type ExamSectionStatus,
  type ExamSheetRow,
  type MarkValue,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { allowedActionsForMany, ApiFailure, readPlan } from '../shared/index.ts'
import {
  currentMarksCte,
  examPlans,
  examRef,
  examState,
  markValueOf,
  paperWindow,
  pupilRef,
  readExamSettings,
  readPaper,
  resultViewFor,
  rosterOn,
  schoolToday,
  type ExamConnection,
  type ExamPlans,
} from './common.ts'

/**
 * The readers behind the exams screens.
 *
 * The exam list, one exam's moderation view, the caller's papers, one marks
 * sheet, one cell's history and one pupil's results are all read here, and
 * the routes, the files, the dashboard and the subject access export call the
 * same functions, so a screen and a file can never disagree. Every statement
 * ANDs the caller's own plans into SQL; nothing is fetched school-wide and
 * then filtered in JavaScript.
 */

type ExamReadPermission = 'exams.read' | 'exams.record_marks' | 'exams.manage' | 'exams.publish' | 'exams.export'

/** The stored timestamp, as the contract's ISO string. */
const ISO_TIMESTAMP = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`)
const DATE = sql.raw(`'YYYY-MM-DD'`)

/** The four exams in the order of the year. */
function kindOrder(column: SQL): SQL {
  return sql`array_position(ARRAY['periodic_test_1','half_yearly','periodic_test_2','annual']::text[], ${column})`
}

/**
 * Whether a component belongs to an exam of this kind: a periodic test has
 * the one component, a main exam the other three.
 */
function componentOfKind(kind: SQL, component: SQL): SQL {
  return sql`((${kind} IN ('periodic_test_1', 'periodic_test_2')) = (${component} = 'periodic_test'))`
}

/** A list of ids as one bound Postgres array, so drizzle never spreads it. */
export function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

/** A name as a roster prints it, never longer than the contract allows. */
function personName(first: string, last: string | null): string {
  return [first, last].filter((part) => part !== null && part !== '').join(' ').slice(0, 160)
}

/** A plan for a permission the caller may not hold at all: FALSE, not an error. */
async function optionalPredicate(read: () => Promise<SQL>): Promise<SQL> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof AuthorizationError) return sql`FALSE`
    throw error
  }
}

function scoped(kind: 'staff' | 'enrollment') {
  const table = scopedTableFor(kind)
  if (!table) throw new Error(`the authorizer has no scoped table for ${kind}`)
  return table
}

// ---------------------------------------------------------------------------
// Years.

export interface YearRow extends Record<string, unknown> {
  id: string
  name: string
  start_date: string
  end_date: string
}

/** One academic year of this school, or a refused request. */
export async function readYear(conn: ExamConnection, schoolId: string, yearId: string): Promise<YearRow> {
  const rows = await conn.client.query<YearRow>(
    `SELECT id, name, to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, yearId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  return row
}

// ---------------------------------------------------------------------------
// Exams.

interface ScheduleRow extends Record<string, unknown> {
  id: string
  academic_year_id: string
  year_name: string
  kind: ExamKind
  starts_on: string
  ends_on: string
  recheck_deadline: string
  version: number
  sections_total: number
  sections_published: number
}

/** The exam rows the caller's plan selects, narrowed by `filter` over `exams`. */
async function readSchedules(
  conn: ExamConnection,
  context: RequestContext,
  plans: ExamPlans,
  filter: SQL,
  today: string,
): Promise<ExamSchedule[]> {
  const schoolId = context.schoolId
  const rows = await conn.db.execute<ScheduleRow>(
    sql`SELECT exams.id, exams.academic_year_id, ay.name AS year_name, exams.kind,
               to_char(exams.starts_on, ${DATE}) AS starts_on, to_char(exams.ends_on, ${DATE}) AS ends_on,
               to_char(exams.recheck_deadline, ${DATE}) AS recheck_deadline, exams.version,
               (SELECT count(DISTINCT p.section_id)::int FROM exam_papers p
                 WHERE p.school_id = exams.school_id AND p.exam_id = exams.id) AS sections_total,
               (SELECT count(DISTINCT pub.section_id)::int FROM exam_publications pub
                 WHERE pub.school_id = exams.school_id AND pub.exam_id = exams.id) AS sections_published
          FROM exams
          JOIN academic_years ay ON ay.school_id = exams.school_id AND ay.id = exams.academic_year_id
         WHERE exams.school_id = ${schoolId}::uuid AND (${plans.exams}) AND (${filter})
         ORDER BY ${kindOrder(sql`exams.kind`)}`,
  )
  const actions = await allowedActionsForMany(conn, context, 'exam', rows.rows.map((row) => row.id))
  return rows.rows.map((row) => ({
    id: row.id,
    academicYear: { id: row.academic_year_id, name: row.year_name },
    kind: row.kind,
    term: EXAM_PATTERN[row.kind].term,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    recheckDeadline: row.recheck_deadline,
    locked: examState(row, today) === 'locked',
    sectionsTotal: Number(row.sections_total ?? 0),
    sectionsPublished: Number(row.sections_published ?? 0),
    version: Number(row.version),
    allowedActions: [...(actions.get(row.id) ?? [])],
  }))
}

/** The exams of one year. Only the office's plan selects an exam's own row. */
export async function readExamList(
  conn: ExamConnection,
  context: RequestContext,
  academicYearId: string,
): Promise<ExamListResponse> {
  const year = await readYear(conn, context.schoolId, academicYearId)
  const plans = await examPlans(conn, context)
  const today = await schoolToday(conn, context.schoolId)
  const items = await readSchedules(conn, context, plans, sql`exams.academic_year_id = ${year.id}::uuid`, today)
  return ExamListResponse.parse({ academicYear: { id: year.id, name: year.name }, today, items })
}

/** One exam as the list shows it. A row the plan does not select is not there. */
export async function readSchedule(
  conn: ExamConnection,
  context: RequestContext,
  examId: string,
): Promise<ExamSchedule> {
  const plans = await examPlans(conn, context)
  const today = await schoolToday(conn, context.schoolId)
  const [item] = await readSchedules(conn, context, plans, sql`exams.id = ${examId}::uuid`, today)
  if (!item) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return item
}

// ---------------------------------------------------------------------------
// Papers with their counts.

interface PaperCountRow extends Record<string, unknown> {
  id: string
  exam_id: string
  kind: ExamKind
  starts_on: string
  ends_on: string
  recheck_deadline: string
  section_id: string
  section_name: string
  grade_id: string
  grade_name: string
  subject_id: string
  subject_name: string
  pupils: number
  entered: number
  published: boolean
}

export interface PaperCount {
  readonly id: string
  readonly exam: ReturnType<typeof examRef>
  readonly examRow: { readonly starts_on: string; readonly recheck_deadline: string }
  readonly section: { id: string; name: string }
  readonly grade: { id: string; name: string }
  readonly subject: { id: string; name: string }
  readonly pupils: number
  readonly entered: number
  readonly expected: number
  readonly published: boolean
}

/**
 * The papers the caller's plan selects, narrowed by `filter` over
 * `exam_papers`, each with its roster size (enrolled on the exam's first day,
 * under the pupils plan), the cells filled in for that roster (under the marks
 * plan) and what a full sheet holds. One statement for any number of papers.
 */
export async function paperCounts(
  conn: ExamConnection,
  context: RequestContext,
  plans: ExamPlans,
  filter: SQL,
  marksFilter: SQL,
): Promise<PaperCount[]> {
  const schoolId = context.schoolId
  const rows = await conn.db.execute<PaperCountRow>(
    sql`WITH ${currentMarksCte({ schoolId, marks: plans.marks, filter: marksFilter })}
        SELECT exam_papers.id, exam_papers.exam_id, exams.kind,
               to_char(exams.starts_on, ${DATE}) AS starts_on, to_char(exams.ends_on, ${DATE}) AS ends_on,
               to_char(exams.recheck_deadline, ${DATE}) AS recheck_deadline,
               exam_papers.section_id, sections.name AS section_name,
               grades.id AS grade_id, grades.name AS grade_name,
               exam_papers.subject_id, subjects.name AS subject_name,
               COALESCE(roster.pupils, 0) AS pupils, COALESCE(roster.entered, 0) AS entered,
               EXISTS (SELECT 1 FROM exam_publications pub
                        WHERE pub.school_id = exam_papers.school_id AND pub.exam_id = exam_papers.exam_id
                          AND pub.section_id = exam_papers.section_id) AS published
          FROM exam_papers
          JOIN exams ON exams.school_id = exam_papers.school_id AND exams.id = exam_papers.exam_id
          JOIN sections ON sections.school_id = exam_papers.school_id AND sections.id = exam_papers.section_id
          JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
          JOIN subjects ON subjects.school_id = exam_papers.school_id AND subjects.id = exam_papers.subject_id
          LEFT JOIN LATERAL (
            SELECT count(*)::int AS pupils,
                   COALESCE(sum((SELECT count(*) FROM ex_current c
                                  WHERE c.paper_id = exam_papers.id AND c.student_id = students.id
                                    AND ${componentOfKind(sql`exams.kind`, sql`c.component`)})), 0)::int AS entered
              FROM enrollments
              JOIN students ON students.school_id = enrollments.school_id AND students.id = enrollments.student_id
             WHERE enrollments.school_id = exam_papers.school_id
               AND enrollments.section_id = exam_papers.section_id
               AND enrollments.joined_on <= exams.starts_on
               AND (enrollments.left_on IS NULL OR enrollments.left_on >= exams.starts_on)
               AND (${plans.pupils})
          ) roster ON TRUE
         WHERE exam_papers.school_id = ${schoolId}::uuid AND (${plans.papers}) AND (${filter})
         ORDER BY ${kindOrder(sql`exams.kind`)}, grades.sort_order, sections.name, subjects.name, exam_papers.id`,
  )
  return rows.rows.map((row) => {
    const pupils = Number(row.pupils ?? 0)
    return {
      id: row.id,
      exam: examRef(row),
      examRow: { starts_on: row.starts_on, recheck_deadline: row.recheck_deadline },
      section: { id: row.section_id, name: row.section_name },
      grade: { id: row.grade_id, name: row.grade_name },
      subject: { id: row.subject_id, name: row.subject_name },
      pupils,
      entered: Number(row.entered ?? 0),
      expected: pupils * EXAM_PATTERN[row.kind].components.length,
      published: row.published === true,
    }
  })
}

/** The contract's summary of each paper, with the window and the actions. */
async function summarise(
  conn: ExamConnection,
  context: RequestContext,
  papers: readonly PaperCount[],
  today: string,
): Promise<ExamPaperSummary[]> {
  const actions = await allowedActionsForMany(conn, context, 'exam', papers.map((paper) => paper.id))
  return papers.map((paper) => {
    const allowed = actions.get(paper.id) ?? []
    return {
      id: paper.id,
      exam: paper.exam,
      section: paper.section,
      grade: paper.grade,
      subject: paper.subject,
      pupils: paper.pupils,
      entered: paper.entered,
      expected: paper.expected,
      window: paperWindow({
        state: examState(paper.examRow, today),
        mayRecord: allowed.includes('exams.record_marks'),
        mayCorrect: allowed.includes('exams.manage'),
      }),
      published: paper.published,
      allowedActions: [...allowed],
    }
  })
}

/**
 * The papers of a year the caller may see: a subject teacher's own subject in
 * their own section, a class teacher's whole class, the office's everything.
 */
export async function listPapers(
  conn: ExamConnection,
  context: RequestContext,
  filters: ExamPapersRequest,
  permission: ExamReadPermission = 'exams.read',
): Promise<ExamPapersResponse> {
  await readYear(conn, context.schoolId, filters.academicYearId)
  const plans = await examPlans(conn, context, permission)
  const today = await schoolToday(conn, context.schoolId)
  const conditions: SQL[] = [sql`exam_papers.academic_year_id = ${filters.academicYearId}::uuid`]
  const markConditions: SQL[] = [sql`exam_marks.academic_year_id = ${filters.academicYearId}::uuid`]
  if (filters.examId !== undefined) {
    conditions.push(sql`exam_papers.exam_id = ${filters.examId}::uuid`)
    markConditions.push(sql`exam_marks.exam_id = ${filters.examId}::uuid`)
  }
  if (filters.sectionId !== undefined) {
    conditions.push(sql`exam_papers.section_id = ${filters.sectionId}::uuid`)
    markConditions.push(sql`exam_marks.section_id = ${filters.sectionId}::uuid`)
  }
  if (filters.subjectId !== undefined) {
    conditions.push(sql`exam_papers.subject_id = ${filters.subjectId}::uuid`)
    markConditions.push(sql`exam_marks.subject_id = ${filters.subjectId}::uuid`)
  }
  const papers = await paperCounts(
    conn,
    context,
    plans,
    sql.join(conditions, sql` AND `),
    sql.join(markConditions, sql` AND `),
  )
  const items = await summarise(conn, context, papers, today)
  return ExamPapersResponse.parse({ today, items })
}

// ---------------------------------------------------------------------------
// One marks sheet.

interface CellRow extends Record<string, unknown> {
  student_id: string
  component: ExamComponent
  status: string
  marks_tenths: number | null
  revision: number
  kind: 'entry' | 'correction'
  recorded_at: string
}

/** The components of an exam of this kind, as the sheet heads its columns. */
export function sheetComponents(kind: ExamKind): { key: ExamComponent; label: string; maxMarks: number }[] {
  return EXAM_PATTERN[kind].components.map((key) => ({
    key,
    label: EXAM_COMPONENTS[key].label,
    maxMarks: EXAM_COMPONENTS[key].maxMarks,
  }))
}

/**
 * One paper's sheet: the roster on the exam's first day in roll order, and
 * against each name the current mark of each component the caller may read.
 * The paper has already been decided.
 */
export async function readSheet(conn: ExamConnection, context: RequestContext, paperId: string): Promise<ExamSheet> {
  const schoolId = context.schoolId
  const paper = await readPaper(conn, schoolId, paperId)
  const plans = await examPlans(conn, context)
  const today = await schoolToday(conn, schoolId)
  const [count] = await paperCounts(
    conn,
    context,
    plans,
    sql`exam_papers.id = ${paperId}::uuid`,
    sql`exam_marks.paper_id = ${paperId}::uuid`,
  )
  if (!count) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const [summary] = await summarise(conn, context, [count], today)
  if (!summary) throw new ApiFailure('RESOURCE_NOT_FOUND')

  const roster = await rosterOn(conn, schoolId, paper.section_id, paper.starts_on, plans.pupils)
  const components = sheetComponents(paper.kind)
  const cells = await conn.db.execute<CellRow>(
    sql`WITH ${currentMarksCte({ schoolId, marks: plans.marks, filter: sql`exam_marks.paper_id = ${paperId}::uuid` })}
        SELECT student_id, component, status, marks_tenths, revision, kind,
               to_char(recorded_at AT TIME ZONE 'UTC', ${ISO_TIMESTAMP}) AS recorded_at
          FROM ex_current
         WHERE ${componentOfKind(sql`${paper.kind}::text`, sql`component`)}`,
  )
  const byPupil = new Map<string, CellRow[]>()
  for (const cell of cells.rows) {
    const list = byPupil.get(cell.student_id) ?? []
    list.push(cell)
    byPupil.set(cell.student_id, list)
  }
  const order = new Map(components.map((component, index) => [component.key, index]))
  const rows: ExamSheetRow[] = roster.map((pupil) => ({
    student: pupilRef(pupil),
    cells: (byPupil.get(pupil.id) ?? [])
      .sort((a, b) => (order.get(a.component) ?? 0) - (order.get(b.component) ?? 0))
      .map((cell) => ({
        component: cell.component,
        value: markValueOf(cell.status, cell.marks_tenths === null ? null : Number(cell.marks_tenths)),
        revision: Number(cell.revision),
        kind: cell.kind,
        recordedAt: cell.recorded_at,
      })),
  }))
  return ExamSheet.parse({ paper: summary, components, rows })
}

// ---------------------------------------------------------------------------
// One cell's history.

interface HistoryRow extends Record<string, unknown> {
  id: string
  status: string
  marks_tenths: number | null
  revision: number
  kind: 'entry' | 'correction'
  reason_kind: ExamReasonKind | null
  recorded_at: string
  recorded_by: string | null
}

/**
 * Every row of one cell the caller may read, oldest first. Whoever recorded a
 * row is named only when their staff record is one the caller may read in the
 * directory. The pupil must be on the paper's roster or have a row there.
 */
export async function readMarkHistory(
  conn: ExamConnection,
  context: RequestContext,
  paperId: string,
  studentId: string,
  component: ExamComponent,
): Promise<ExamMarkHistory> {
  const schoolId = context.schoolId
  const paper = await readPaper(conn, schoolId, paperId)
  const plans = await examPlans(conn, context)
  const staffPlan = await optionalPredicate(async () =>
    planPredicate(await readPlan(conn, context, 'staff.read_directory', 'staff'), scoped('staff')),
  )
  const rows = await conn.db.execute<HistoryRow>(
    sql`SELECT exam_marks.id, exam_marks.status, exam_marks.marks_tenths, exam_marks.revision, exam_marks.kind,
               exam_marks.reason_kind,
               to_char(exam_marks.recorded_at AT TIME ZONE 'UTC', ${ISO_TIMESTAMP}) AS recorded_at,
               (SELECT staff.first_name || COALESCE(' ' || NULLIF(staff.last_name, ''), '')
                  FROM membership_staff_links msl
                  JOIN staff ON staff.school_id = msl.school_id AND staff.id = msl.staff_id
                 WHERE msl.school_id = exam_marks.school_id
                   AND msl.membership_id = exam_marks.recorded_by_membership_id
                   AND (${staffPlan})
                 LIMIT 1) AS recorded_by
          FROM exam_marks
         WHERE exam_marks.school_id = ${schoolId}::uuid AND exam_marks.paper_id = ${paperId}::uuid
           AND exam_marks.student_id = ${studentId}::uuid AND exam_marks.component = ${component}
           AND (${plans.marks})
         ORDER BY exam_marks.revision`,
  )

  const roster = await rosterOn(conn, schoolId, paper.section_id, paper.starts_on, plans.pupils)
  let pupil = roster.find((row) => row.id === studentId)
  if (!pupil && rows.rows.length > 0) {
    const named = await conn.db.execute<{
      id: string
      first_name: string
      last_name: string | null
      admission_number: string
    }>(
      sql`SELECT students.id, students.first_name, students.last_name, students.admission_number
            FROM students WHERE students.school_id = ${schoolId}::uuid AND students.id = ${studentId}::uuid
             AND (${plans.pupils})`,
    )
    const found = named.rows[0]
    if (found) {
      pupil = {
        id: found.id,
        name: personName(found.first_name, found.last_name),
        admissionNumber: found.admission_number,
        rollNumber: null,
      }
    }
  }
  if (!pupil) throw new ApiFailure('RESOURCE_NOT_FOUND')

  return ExamMarkHistory.parse({
    student: pupilRef(pupil),
    component,
    rows: rows.rows.map((row) => ({
      id: row.id,
      value: markValueOf(row.status, row.marks_tenths === null ? null : Number(row.marks_tenths)),
      revision: Number(row.revision),
      kind: row.kind,
      ...(row.reason_kind === null ? {} : { reasonKind: row.reason_kind }),
      recordedAt: row.recorded_at,
      ...(row.recorded_by === null || row.recorded_by.trim() === ''
        ? {}
        : { recordedBy: row.recorded_by.slice(0, 160) }),
    })),
  })
}

// ---------------------------------------------------------------------------
// Moderation: one exam across the school, section by section.

interface PublicationRow extends Record<string, unknown> {
  section_id: string
  published_at: string
  changed_since: boolean
}

/**
 * The state of each section of one exam: its papers with their counts, the
 * newest publication and what, if anything, stops the office publishing it.
 * Narrowed to one section when `sectionId` is given.
 */
export async function sectionStatuses(
  conn: ExamConnection,
  context: RequestContext,
  input: {
    readonly exam: { readonly id: string; readonly starts_on: string; readonly recheck_deadline: string }
    readonly plans: ExamPlans
    readonly today: string
    readonly sectionId?: string
  },
): Promise<ExamSectionStatus[]> {
  const { exam, plans } = input
  const sectionPaper = input.sectionId === undefined ? sql`TRUE` : sql`exam_papers.section_id = ${input.sectionId}::uuid`
  const sectionMark = input.sectionId === undefined ? sql`TRUE` : sql`exam_marks.section_id = ${input.sectionId}::uuid`
  const papers = await paperCounts(
    conn,
    context,
    plans,
    sql`exam_papers.exam_id = ${exam.id}::uuid AND ${sectionPaper}`,
    sql`exam_marks.exam_id = ${exam.id}::uuid AND ${sectionMark}`,
  )
  const sectionPub = input.sectionId === undefined ? sql`TRUE` : sql`pub.section_id = ${input.sectionId}::uuid`
  const publications = await conn.db.execute<PublicationRow>(
    sql`SELECT DISTINCT ON (pub.section_id) pub.section_id,
               to_char(pub.published_at AT TIME ZONE 'UTC', ${ISO_TIMESTAMP}) AS published_at,
               EXISTS (SELECT 1 FROM exam_marks m
                        WHERE m.school_id = pub.school_id AND m.exam_id = pub.exam_id
                          AND m.section_id = pub.section_id AND m.recorded_at > pub.published_at) AS changed_since
          FROM exam_publications pub
         WHERE pub.school_id = ${context.schoolId}::uuid AND pub.exam_id = ${exam.id}::uuid AND ${sectionPub}
         ORDER BY pub.section_id, pub.published_at DESC`,
  )
  const published = new Map(publications.rows.map((row) => [row.section_id, row]))
  const locked = examState(exam, input.today) === 'locked'

  const sections = new Map<string, PaperCount[]>()
  for (const paper of papers) {
    const list = sections.get(paper.section.id) ?? []
    list.push(paper)
    sections.set(paper.section.id, list)
  }
  const statuses: ExamSectionStatus[] = []
  for (const [sectionId, list] of sections) {
    const first = list[0]
    if (!first) continue
    const complete = list.every((paper) => paper.entered >= paper.expected)
    const pub = published.get(sectionId)
    const publication = pub ? { publishedAt: pub.published_at, changedSince: pub.changed_since === true } : null
    const fresh = publication === null || publication.changedSince
    let blockedBy: ErrorReason | undefined
    if (!locked) blockedBy = 'exam_publish_before_deadline'
    else if (!complete) blockedBy = 'exam_section_incomplete'
    else if (!fresh) blockedBy = 'exam_nothing_to_publish'
    statuses.push({
      section: first.section,
      grade: first.grade,
      pupils: first.pupils,
      papers: list.map((paper) => ({
        paperId: paper.id,
        subject: paper.subject,
        entered: paper.entered,
        expected: paper.expected,
        complete: paper.entered >= paper.expected,
      })),
      complete,
      publication,
      readyToPublish: locked && complete && fresh,
      ...(blockedBy === undefined ? {} : { blockedBy }),
    })
  }
  return statuses
}

/** One exam with every section's state. The exam has already been decided. */
export async function readOverview(
  conn: ExamConnection,
  context: RequestContext,
  examId: string,
): Promise<ExamOverview> {
  const exam = await readSchedule(conn, context, examId)
  const plans = await examPlans(conn, context)
  const today = await schoolToday(conn, context.schoolId)
  const sections = await sectionStatuses(conn, context, {
    exam: { id: exam.id, starts_on: exam.startsOn, recheck_deadline: exam.recheckDeadline },
    plans,
    today,
  })
  return ExamOverview.parse({ exam, today, sections })
}

// ---------------------------------------------------------------------------
// One pupil's results for a year.

interface ResultMarkRow extends Record<string, unknown> {
  exam_id: string
  kind: ExamKind
  starts_on: string
  ends_on: string
  recheck_deadline: string
  section_id: string
  subject_id: string
  subject_name: string
  component: ExamComponent
  status: string
  marks_tenths: number | null
  published_at: string | null
}

/**
 * A pupil's exams in one year, as the caller may see them: live marks for
 * staff; for a family, each exam as it stood at its newest publication, and
 * grades alone when the school shows grades. An exam appears only when the
 * pupil has at least one mark in it the caller may read. The pupil has
 * already been decided.
 */
export async function readStudentResults(
  conn: ExamConnection,
  context: RequestContext,
  studentId: string,
  academicYearId: string,
): Promise<ExamResultsResponse> {
  const schoolId = context.schoolId
  const year = await readYear(conn, schoolId, academicYearId)
  const plans = await examPlans(conn, context)

  const named = await conn.db.execute<{
    id: string
    first_name: string
    last_name: string | null
    admission_number: string
  }>(
    sql`SELECT students.id, students.first_name, students.last_name, students.admission_number
          FROM students WHERE students.school_id = ${schoolId}::uuid AND students.id = ${studentId}::uuid
           AND (${plans.pupils})`,
  )
  const student = named.rows[0]
  if (!student) throw new ApiFailure('RESOURCE_NOT_FOUND')

  const view = await resultViewFor(conn, schoolId, studentId, plans.staffPupils)
  const settings = await readExamSettings(conn, schoolId)
  const displayMode = view === 'staff' ? 'marks' : settings.displayMode
  const gradesOnly = view === 'family' && displayMode === 'grades'

  const enrollmentPlan = await optionalPredicate(async () =>
    planPredicate(await readPlan(conn, context, 'students.read_enrollments', 'enrollment'), scoped('enrollment')),
  )
  const placed = await conn.db.execute<{
    section_id: string
    section_name: string
    grade_id: string
    grade_name: string
  }>(
    sql`SELECT sections.id AS section_id, sections.name AS section_name, grades.id AS grade_id, grades.name AS grade_name
          FROM enrollments
          JOIN sections ON sections.school_id = enrollments.school_id AND sections.id = enrollments.section_id
          JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
         WHERE enrollments.school_id = ${schoolId}::uuid AND enrollments.student_id = ${studentId}::uuid
           AND enrollments.academic_year_id = ${year.id}::uuid AND (${enrollmentPlan})
         ORDER BY enrollments.joined_on DESC, enrollments.id
         LIMIT 1`,
  )
  const place = placed.rows[0]

  const marks = await conn.db.execute<ResultMarkRow>(
    sql`WITH ${currentMarksCte({
      schoolId,
      marks: plans.marks,
      filter: sql`exam_marks.student_id = ${studentId}::uuid AND exam_marks.academic_year_id = ${year.id}::uuid`,
    })}
        SELECT c.exam_id, e.kind, to_char(e.starts_on, ${DATE}) AS starts_on, to_char(e.ends_on, ${DATE}) AS ends_on,
               to_char(e.recheck_deadline, ${DATE}) AS recheck_deadline,
               c.section_id, c.subject_id, sub.name AS subject_name, c.component, c.status, c.marks_tenths,
               (SELECT to_char(max(pub.published_at) AT TIME ZONE 'UTC', ${ISO_TIMESTAMP})
                  FROM exam_publications pub
                 WHERE pub.school_id = c.school_id AND pub.exam_id = c.exam_id
                   AND pub.section_id = c.section_id) AS published_at
          FROM (SELECT ex_current.*, ${schoolId}::uuid AS school_id FROM ex_current) c
          JOIN exams e ON e.school_id = c.school_id AND e.id = c.exam_id
          JOIN subjects sub ON sub.school_id = c.school_id AND sub.id = c.subject_id
         WHERE ${componentOfKind(sql`e.kind`, sql`c.component`)}
         ORDER BY ${kindOrder(sql`e.kind`)}, sub.name, sub.id`,
  )

  // Group by exam, then by subject, keeping the order of the statement.
  const exams = new Map<
    string,
    { row: ResultMarkRow; publishedAt: string | null; subjects: Map<string, { name: string; values: Map<ExamComponent, MarkValue> }> }
  >()
  for (const row of marks.rows) {
    let exam = exams.get(row.exam_id)
    if (!exam) {
      exam = { row, publishedAt: null, subjects: new Map() }
      exams.set(row.exam_id, exam)
    }
    // The marks of one exam name one section; the newest publication of any
    // of them is the one the family view stands at.
    if (row.published_at !== null && (exam.publishedAt === null || row.published_at > exam.publishedAt)) {
      exam.publishedAt = row.published_at
    }
    let subject = exam.subjects.get(row.subject_id)
    if (!subject) {
      subject = { name: row.subject_name, values: new Map() }
      exam.subjects.set(row.subject_id, subject)
    }
    subject.values.set(row.component, markValueOf(row.status, row.marks_tenths === null ? null : Number(row.marks_tenths)))
  }

  const results: ExamResult[] = []
  for (const kind of EXAM_KINDS) {
    for (const exam of exams.values()) {
      if (exam.row.kind !== kind) continue
      const components = EXAM_PATTERN[kind].components
      results.push({
        exam: examRef(exam.row),
        ...(exam.publishedAt === null ? {} : { publishedAt: exam.publishedAt }),
        subjects: [...exam.subjects.entries()].map(([subjectId, subject]) => {
          const parts = components.map((component) => ({ component, value: subject.values.get(component) ?? null }))
          const percentage = scoreParts(parts).percentage
          return {
            subject: { id: subjectId, name: subject.name },
            components: gradesOnly
              ? []
              : parts.map((part) => ({ component: part.component, ...(part.value === null ? {} : { value: part.value }) })),
            ...(gradesOnly ? {} : { percentage }),
            grade: gradeFor(settings.gradeBands, percentage),
          }
        }),
      })
    }
  }

  return ExamResultsResponse.parse({
    student: pupilRef({
      id: student.id,
      name: personName(student.first_name, student.last_name),
      admissionNumber: student.admission_number,
      rollNumber: null,
    }),
    academicYear: { id: year.id, name: year.name },
    ...(place
      ? {
          section: { id: place.section_id, name: place.section_name },
          grade: { id: place.grade_id, name: place.grade_name },
        }
      : {}),
    view,
    displayMode,
    exams: results,
  })
}
