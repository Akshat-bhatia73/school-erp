import { createHash } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import {
  EXAM_KINDS,
  EXAM_PATTERN,
  REPORT_CARD_TERMS,
  ReportCardContent,
  TERM_PATTERN,
  attendancePercentage,
  finalPercentage,
  gradeFor,
  overallResult,
  scoreParts,
  type CoScholasticGrades,
  type ErrorReason,
  type ExamComponent,
  type ExamKind,
  type ExamTerm,
  type MarkValue,
  type ReportCardKind,
  type ReportCardRemarks,
  type ResultDisplayMode,
  type ResultView,
} from '@erp/contracts'
import { ApiFailure } from '../shared/index.ts'
import { attendanceFiguresCte, type FiguresRow } from '../attendance/figures.ts'
import {
  currentMarksCte,
  markValueOf,
  publicationState,
  readExamSettings,
  readSection,
  rosterOn,
  type ExamConnection,
  type RosterPupil,
  type SectionRow,
} from '../exams/common.ts'

/**
 * Building one pupil's report card.
 *
 * Nothing on a card is typed in by hand except the co-scholastic grades and
 * the remarks: the figures come from the current marks through the one
 * scoring rule, the attendance from the same rows the register screens read,
 * and the grading key, the marks-or-grades choice and the layout from the
 * school's settings as they stand now. Publishing freezes the result, so a
 * later change to any of them never alters a published card. The same builder
 * answers "would this card come out differently today?", by comparing its
 * hash with the one stored on the newest version.
 */

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`
const DATE = `'YYYY-MM-DD'`

/** The exams a card is built from, in pattern order. */
export function cardExamKinds(card: ReportCardKind): ExamKind[] {
  const terms = REPORT_CARD_TERMS[card]
  return EXAM_KINDS.filter((kind) => terms.includes(EXAM_PATTERN[kind].term))
}

/** The main exam of the card's last term: its first day fixes the card's roster. */
export function cardMainExam(card: ReportCardKind): ExamKind {
  const terms = REPORT_CARD_TERMS[card]
  return TERM_PATTERN[terms[terms.length - 1]!].mainExam
}

/** The last term a card covers, whose co-scholastic grades count as "entered". */
export function cardLastTerm(card: ReportCardKind): ExamTerm {
  const terms = REPORT_CARD_TERMS[card]
  return terms[terms.length - 1]!
}

function shift(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

interface YearExamRow extends Record<string, unknown> {
  id: string
  kind: ExamKind
  starts_on: string
  ends_on: string
}

/** The exams of one year that exist so far, by kind. Read school-wide. */
export async function yearExams(
  conn: ExamConnection,
  schoolId: string,
  academicYearId: string,
): Promise<Map<ExamKind, YearExamRow>> {
  const rows = await conn.client.query<YearExamRow>(
    `SELECT id, kind, to_char(starts_on, ${DATE}) AS starts_on, to_char(ends_on, ${DATE}) AS ends_on
       FROM exams WHERE school_id = $1 AND academic_year_id = $2`,
    [schoolId, academicYearId],
  )
  return new Map(rows.rows.map((row) => [row.kind, row]))
}

interface YearRow extends Record<string, unknown> {
  start_date: string
  end_date: string
}

async function readYear(conn: ExamConnection, schoolId: string, academicYearId: string): Promise<YearRow> {
  const rows = await conn.client.query<YearRow>(
    `SELECT to_char(start_date, ${DATE}) AS start_date, to_char(end_date, ${DATE}) AS end_date
       FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, academicYearId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

/**
 * The day a roster is taken on: the first day of the exam named, or, while
 * that exam is not set up yet, today clipped into the year.
 */
export async function rosterDate(
  conn: ExamConnection,
  schoolId: string,
  section: SectionRow,
  kind: ExamKind,
  today: string,
): Promise<string> {
  const exam = (await yearExams(conn, schoolId, section.academic_year_id)).get(kind)
  if (exam) return exam.starts_on
  const year = await readYear(conn, schoolId, section.academic_year_id)
  if (today < year.start_date) return year.start_date
  if (today > year.end_date) return year.end_date
  return today
}

/**
 * A card's roster: the pupils enrolled in the section on the first day of the
 * card's last main exam, narrowed by `pupils` (over `students`). A write
 * passes TRUE after deciding the section; a read passes its plan.
 */
export async function cardRoster(
  conn: ExamConnection,
  schoolId: string,
  section: SectionRow,
  card: ReportCardKind,
  today: string,
  pupils: SQL,
): Promise<RosterPupil[]> {
  const date = await rosterDate(conn, schoolId, section, cardMainExam(card), today)
  return rosterOn(conn, schoolId, section.id, date, pupils)
}

export interface CardExamStatus {
  readonly examId: string
  readonly kind: ExamKind
  readonly published: boolean
  readonly changedSincePublished: boolean
}

/**
 * Where each exam of a card stands for a section, and the reason a publish
 * would be refused. An exam that is not set up yet counts as not published.
 */
export async function cardExamsStatus(
  conn: ExamConnection,
  schoolId: string,
  section: SectionRow,
  card: ReportCardKind,
): Promise<{ exams: CardExamStatus[]; blockedBy: ErrorReason | undefined }> {
  const found = await yearExams(conn, schoolId, section.academic_year_id)
  const exams: CardExamStatus[] = []
  let missing = false
  for (const kind of cardExamKinds(card)) {
    const exam = found.get(kind)
    if (!exam) {
      missing = true
      continue
    }
    const state = await publicationState(conn, schoolId, exam.id, section.id)
    exams.push({
      examId: exam.id,
      kind,
      published: state !== null,
      changedSincePublished: state?.changedSince === true,
    })
  }
  const blockedBy: ErrorReason | undefined =
    missing || exams.some((exam) => !exam.published)
      ? 'report_card_exams_not_published'
      : exams.some((exam) => exam.changedSincePublished)
        ? 'report_card_exams_changed'
        : undefined
  return { exams, blockedBy }
}

export interface LatestVersion {
  readonly id: string
  readonly studentId: string
  readonly versionNumber: number
  readonly publishedAt: string
  readonly contentHash: string
}

/**
 * The newest version of one card per pupil among those named, for one year,
 * narrowed by `cards` (over `report_card_versions`). A write passes TRUE.
 */
export async function latestVersions(
  conn: ExamConnection,
  input: {
    readonly schoolId: string
    readonly academicYearId: string
    readonly card: ReportCardKind
    readonly studentIds: readonly string[]
    readonly cards: SQL
  },
): Promise<Map<string, LatestVersion>> {
  if (input.studentIds.length === 0) return new Map()
  const rows = await conn.db.execute<{
    id: string
    student_id: string
    version_number: number
    published_at: string
    content_hash: string
  }>(
    sql`SELECT DISTINCT ON (report_card_versions.student_id)
               report_card_versions.id, report_card_versions.student_id, report_card_versions.version_number,
               to_char(report_card_versions.published_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS published_at,
               report_card_versions.content_hash
          FROM report_card_versions
         WHERE report_card_versions.school_id = ${input.schoolId}::uuid
           AND report_card_versions.academic_year_id = ${input.academicYearId}::uuid
           AND report_card_versions.card = ${input.card}
           AND report_card_versions.student_id = ANY(ARRAY[${sql.join(
             input.studentIds.map((id) => sql`${id}::uuid`),
             sql`, `,
           )}])
           AND (${input.cards})
         ORDER BY report_card_versions.student_id, report_card_versions.version_number DESC`,
  )
  return new Map(
    rows.rows.map((row) => [
      row.student_id,
      {
        id: row.id,
        studentId: row.student_id,
        versionNumber: Number(row.version_number),
        publishedAt: row.published_at,
        contentHash: row.content_hash,
      },
    ]),
  )
}

// ---------------------------------------------------------------------------
// The builder.

export interface BuildCardInput {
  readonly studentId: string
  readonly sectionId: string
  readonly academicYearId: string
  readonly card: ReportCardKind
  /** The school's today, which bounds the attendance counted. */
  readonly today: string
}

export interface BuiltCard {
  readonly content: ReportCardContent
  readonly remarks: ReportCardRemarks
  readonly hash: string
}

function pupilName(first: string, last: string | null): string {
  return [first, last].filter((part) => part !== null && part !== '').join(' ').slice(0, 160)
}

const NO_GRADES: CoScholasticGrades = {
  work_education: null,
  art_education: null,
  health_physical_education: null,
  discipline: null,
}

/** The hash a version stores: the frozen content and the remarks together. */
export function cardHash(content: ReportCardContent, remarks: ReportCardRemarks): string {
  return createHash('sha256').update(JSON.stringify({ content, remarks })).digest('hex')
}

/**
 * One pupil's card as it would be published now. Everything is read
 * school-wide: the caller has already decided the section. The marks are the
 * live current ones; a card is only published while every exam it needs has
 * no change since its publication, so these are the published marks too.
 */
export async function buildReportCard(
  conn: ExamConnection,
  schoolId: string,
  input: BuildCardInput,
): Promise<BuiltCard> {
  const settings = await readExamSettings(conn, schoolId)
  const section = await readSection(conn, schoolId, input.sectionId)
  if (section.academic_year_id !== input.academicYearId) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const year = await readYear(conn, schoolId, input.academicYearId)
  const exams = await yearExams(conn, schoolId, input.academicYearId)
  const kinds = cardExamKinds(input.card)
  const examIds = kinds.map((kind) => exams.get(kind)?.id).filter((id): id is string => id !== undefined)
  const terms = REPORT_CARD_TERMS[input.card]

  // The pupil, with the roll number of their enrolment in this section.
  const pupilRows = await conn.client.query<{
    id: string
    first_name: string
    last_name: string | null
    admission_number: string
    roll_number: number | null
  }>(
    `SELECT s.id, s.first_name, s.last_name, s.admission_number,
            (SELECT e.roll_number FROM enrollments e
              WHERE e.school_id = s.school_id AND e.student_id = s.id AND e.section_id = $3
              ORDER BY e.joined_on DESC LIMIT 1) AS roll_number
       FROM students s WHERE s.school_id = $1 AND s.id = $2`,
    [schoolId, input.studentId, input.sectionId],
  )
  const pupil = pupilRows.rows[0]
  if (!pupil) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const roll = pupil.roll_number === null ? null : Number(pupil.roll_number)

  // The subjects: those the section has papers in for the card's exams.
  const subjects =
    examIds.length === 0
      ? []
      : (
          await conn.client.query<{ id: string; name: string }>(
            `SELECT DISTINCT sub.id, sub.name
               FROM exam_papers p
               JOIN subjects sub ON sub.school_id = p.school_id AND sub.id = p.subject_id
              WHERE p.school_id = $1 AND p.section_id = $2 AND p.exam_id = ANY($3::uuid[])
              ORDER BY sub.name, sub.id`,
            [schoolId, input.sectionId, examIds],
          )
        ).rows

  // The current marks of this pupil in this section and year.
  const marks = await conn.db.execute<{
    subject_id: string
    kind: ExamKind
    component: ExamComponent
    status: string
    marks_tenths: number | null
  }>(
    sql`WITH ${currentMarksCte({
      schoolId,
      marks: sql`TRUE`,
      filter: sql`exam_marks.student_id = ${input.studentId}::uuid
                  AND exam_marks.section_id = ${input.sectionId}::uuid
                  AND exam_marks.academic_year_id = ${input.academicYearId}::uuid`,
    })}
        SELECT ex_current.subject_id, exams.kind, ex_current.component, ex_current.status, ex_current.marks_tenths
          FROM ex_current
          JOIN exams ON exams.school_id = ${schoolId}::uuid AND exams.id = ex_current.exam_id`,
  )
  const values = new Map<string, MarkValue>()
  for (const row of marks.rows) {
    values.set(`${row.subject_id}:${row.kind}:${row.component}`, markValueOf(row.status, row.marks_tenths))
  }

  const scholastic = subjects.map((subject) => {
    const termRows = terms.map((term) => {
      const components = TERM_PATTERN[term].exams.flatMap((kind) =>
        EXAM_PATTERN[kind].components.map((component) => ({
          exam: kind,
          component,
          value: values.get(`${subject.id}:${kind}:${component}`) ?? null,
        })),
      )
      const { percentage } = scoreParts(components)
      return { term, components, percentage, grade: gradeFor(settings.gradeBands, percentage) }
    })
    if (input.card !== 'final') return { subject: { id: subject.id, name: subject.name }, terms: termRows }
    const final = finalPercentage(termRows[0]?.percentage ?? null, termRows[1]?.percentage ?? null)
    return {
      subject: { id: subject.id, name: subject.name },
      terms: termRows,
      final: { percentage: final, grade: gradeFor(settings.gradeBands, final) },
    }
  })

  // The class teacher's entries for these terms.
  const entryRows = await conn.client.query<{
    term: ExamTerm
    work_education: 'A' | 'B' | 'C' | null
    art_education: 'A' | 'B' | 'C' | null
    health_physical_education: 'A' | 'B' | 'C' | null
    discipline: 'A' | 'B' | 'C' | null
    remarks: string | null
  }>(
    `SELECT term, work_education, art_education, health_physical_education, discipline, remarks
       FROM report_card_entries
      WHERE school_id = $1 AND section_id = $2 AND student_id = $3 AND academic_year_id = $4`,
    [schoolId, input.sectionId, input.studentId, input.academicYearId],
  )
  const entries = new Map(entryRows.rows.map((row) => [row.term, row]))
  const coScholastic = terms.map((term) => {
    const entry = entries.get(term)
    return {
      term,
      grades: entry
        ? {
            work_education: entry.work_education,
            art_education: entry.art_education,
            health_physical_education: entry.health_physical_education,
            discipline: entry.discipline,
          }
        : NO_GRADES,
    }
  })
  const remarks: ReportCardRemarks = {}
  for (const term of terms) {
    const text = entries.get(term)?.remarks?.trim()
    if (text) remarks[term] = text
  }

  // Attendance per term, over the same rows the register screens read.
  const term1End = exams.get('half_yearly')?.ends_on ?? year.end_date
  const windows: Record<ExamTerm, { from: string; to: string }> = {
    term_1: { from: year.start_date, to: term1End },
    term_2: { from: shift(term1End, 1), to: exams.get('annual')?.ends_on ?? year.end_date },
  }
  const attendance = []
  for (const term of terms) {
    const window = windows[term]
    const figures =
      window.from > window.to
        ? undefined
        : (
            await conn.db.execute<FiguresRow>(
              sql`${attendanceFiguresCte({
                schoolId,
                from: window.from,
                to: window.to,
                asOf: input.today,
                holidays: sql`TRUE`,
                entries: sql`TRUE`,
                spans: sql`enrollments.student_id = ${input.studentId}::uuid
                           AND enrollments.academic_year_id = ${input.academicYearId}::uuid`,
              })}
              SELECT * FROM att_figures`,
            )
          ).rows[0]
    const counts = {
      schoolDays: Number(figures?.school_days ?? 0),
      present: Number(figures?.present ?? 0),
      late: Number(figures?.late ?? 0),
      halfDay: Number(figures?.half_day ?? 0),
      leave: Number(figures?.leave ?? 0),
    }
    // A leave day is neither for nor against a pupil (the Task 20 rule), so it
    // is not one of their working days either, and the card's two figures
    // and its percentage agree.
    attendance.push({
      term,
      workingDays: Math.max(0, counts.schoolDays - counts.leave),
      daysPresent: counts.present + counts.late + counts.halfDay / 2,
      percentage: attendancePercentage(counts),
    })
  }

  // The school's header lines, each only when the layout asks for it.
  const schoolRows = await conn.client.query<{
    name: string
    affiliation_number: string | null
    address: string | null
    phone: string | null
    email: string | null
    has_logo: boolean
  }>(
    `SELECT name, affiliation_number,
            CASE WHEN jsonb_typeof(address) = 'string' THEN address #>> '{}' ELSE address->>'line' END AS address,
            phone, email, (logo_storage_key IS NOT NULL) AS has_logo
       FROM schools WHERE id = $1`,
    [schoolId],
  )
  const school = schoolRows.rows[0]
  if (!school) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const lines = settings.layout.headerLines
  const contact = [school.phone, school.email].filter((part): part is string => !!part).join(' · ')
  const header = {
    ...(lines.schoolName ? { name: school.name } : {}),
    ...(lines.affiliationNumber && school.affiliation_number ? { affiliationNumber: school.affiliation_number } : {}),
    ...(lines.address && school.address ? { address: school.address } : {}),
    ...(lines.contact && contact !== '' ? { contact } : {}),
  }

  const draft = {
    card: input.card,
    school: header,
    showLogo: settings.layout.showLogo && school.has_logo === true,
    student: {
      id: pupil.id,
      name: pupilName(pupil.first_name, pupil.last_name),
      admissionNumber: pupil.admission_number,
      ...(roll === null || roll <= 0 ? {} : { rollNumber: roll }),
    },
    academicYear: { id: section.academic_year_id, name: section.year_name },
    grade: { id: section.grade_id, name: section.grade_name },
    section: { id: section.id, name: section.name },
    displayMode: settings.displayMode,
    gradeBands: settings.gradeBands,
    blocks: settings.layout.blocks,
    signatures: settings.layout.signatures,
    footerNote: settings.layout.footerNote,
    scholastic,
    coScholastic,
    attendance,
    ...(input.card === 'final'
      ? (() => {
          const overall = overallResult(scholastic.map((row) => row.final?.percentage ?? null))
          return {
            overall: {
              percentage: overall.percentage,
              grade: gradeFor(settings.gradeBands, overall.percentage),
              result: overall.result,
            },
          }
        })()
      : {}),
  }
  const parsed = ReportCardContent.safeParse(draft)
  if (!parsed.success) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const content = parsed.data
  return { content, remarks, hash: cardHash(content, remarks) }
}

/**
 * A card as one reader sees it. A family reading a card published under
 * grades sees grades only: every component value and every percentage is
 * taken out here, on the server, and the grades and the result stay.
 */
export function projectForView(
  content: ReportCardContent,
  view: ResultView,
  displayMode: ResultDisplayMode = content.displayMode,
): ReportCardContent {
  if (view !== 'family' || displayMode !== 'grades') return content
  return {
    ...content,
    scholastic: content.scholastic.map((row) => ({
      ...row,
      terms: row.terms.map((term) => ({ ...term, components: [], percentage: null })),
      ...(row.final === undefined ? {} : { final: { ...row.final, percentage: null } }),
    })),
    ...(content.overall === undefined ? {} : { overall: { ...content.overall, percentage: null } }),
  }
}
