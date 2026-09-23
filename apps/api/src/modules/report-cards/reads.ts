import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { withTenantTransaction } from '@erp/db'
import {
  ReportCardContent,
  ReportCardRemarks,
  ReportCardView,
  StudentReportCardsRequest,
  StudentReportCardsResponse,
  type ReportCardKind,
  type ReportCardSectionResponse,
  type ReportCardSectionSummary,
  type ReportCardSectionsResponse,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import {
  allowedActionsFor,
  allowedActionsForMany,
  ApiFailure,
  assertUuidParam,
  protectedRoute,
  requireFound,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  decideReportCard,
  pupilRef,
  readSection,
  reportCardPlans,
  resultViewFor,
  schoolToday,
  type ExamConnection,
  type SectionRow,
} from '../exams/common.ts'
import {
  buildReportCard,
  cardExamsStatus,
  cardLastTerm,
  cardRoster,
  latestVersions,
  projectForView,
} from './build.ts'

/**
 * The readers behind the report card screens. The routes here, the section
 * routes in publish.ts, and later the files and the dashboard all call these
 * functions, so a screen and a file can never disagree. Every statement ANDs
 * the caller's own plans into SQL.
 */

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

/** The academic year, when it is this school's. */
export async function readYearName(
  conn: ExamConnection,
  schoolId: string,
  academicYearId: string,
): Promise<{ id: string; name: string }> {
  const rows = await conn.client.query<{ id: string; name: string }>(
    'SELECT id, name FROM academic_years WHERE school_id = $1 AND id = $2',
    [schoolId, academicYearId],
  )
  return requireFound(rows.rows[0])
}

/**
 * How many of these pupils' cards would come out differently if published
 * now. Only pupils with a version are built: a pupil never published is not
 * "changed", simply not published yet.
 */
async function changedSince(
  conn: ExamConnection,
  schoolId: string,
  section: SectionRow,
  card: ReportCardKind,
  today: string,
  latest: ReadonlyMap<string, { contentHash: string }>,
): Promise<Set<string>> {
  const changed = new Set<string>()
  for (const [studentId, version] of latest) {
    const built = await buildReportCard(conn, schoolId, {
      studentId,
      sectionId: section.id,
      academicYearId: section.academic_year_id,
      card,
      today,
    })
    if (built.hash !== version.contentHash) changed.add(studentId)
  }
  return changed
}

/** Every section of a year whose cards the caller may prepare or read, with its progress. */
export async function readReportCardSections(
  conn: ExamConnection,
  context: RequestContext,
  academicYearId: string,
  card: ReportCardKind,
): Promise<ReportCardSectionsResponse> {
  const plans = await reportCardPlans(conn, context, 'report_cards.read')
  const year = await readYearName(conn, context.schoolId, academicYearId)
  const today = await schoolToday(conn, context.schoolId)
  const sections = await conn.db.execute<{ id: string }>(
    sql`SELECT sections.id FROM sections
          JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
         WHERE sections.school_id = ${context.schoolId}::uuid
           AND sections.academic_year_id = ${academicYearId}::uuid
           AND (${plans.rosters})
         ORDER BY grades.sort_order, grades.name, sections.name, sections.id`,
  )
  const ids = sections.rows.map((row) => row.id)
  const actions = await allowedActionsForMany(conn, context, 'report_card', ids)
  const lastTerm = cardLastTerm(card)
  const items: ReportCardSectionSummary[] = []
  for (const id of ids) {
    const section = await readSection(conn, context.schoolId, id)
    const roster = await cardRoster(conn, context.schoolId, section, card, today, plans.pupils)
    const pupilIds = roster.map((pupil) => pupil.id)
    const entered =
      pupilIds.length === 0
        ? 0
        : Number(
            (
              await conn.db.execute<{ count: number }>(
                sql`SELECT count(*)::int AS count FROM report_card_entries
                     WHERE report_card_entries.school_id = ${context.schoolId}::uuid
                       AND report_card_entries.section_id = ${id}::uuid
                       AND report_card_entries.term = ${lastTerm}
                       AND report_card_entries.student_id = ANY(ARRAY[${sql.join(
                         pupilIds.map((pupil) => sql`${pupil}::uuid`),
                         sql`, `,
                       )}])
                       AND report_card_entries.work_education IS NOT NULL
                       AND report_card_entries.art_education IS NOT NULL
                       AND report_card_entries.health_physical_education IS NOT NULL
                       AND report_card_entries.discipline IS NOT NULL
                       AND (${plans.entries})`,
              )
            ).rows[0]?.count ?? 0,
          )
    const latest = await latestVersions(conn, {
      schoolId: context.schoolId,
      academicYearId,
      card,
      studentIds: pupilIds,
      cards: plans.cards,
    })
    const changed = await changedSince(conn, context.schoolId, section, card, today, latest)
    const status = await cardExamsStatus(conn, context.schoolId, section, card)
    items.push({
      section: { id: section.id, name: section.name },
      grade: { id: section.grade_id, name: section.grade_name },
      pupils: roster.length,
      coScholasticEntered: entered,
      published: latest.size,
      changedSincePublished: changed.size,
      examsReady: status.blockedBy === undefined,
      allowedActions: [...(actions.get(id) ?? [])],
    })
  }
  return { academicYear: year, card, items }
}

/** One section's cards: where its exams stand and each pupil's newest version. */
export async function readSectionCards(
  conn: ExamConnection,
  context: RequestContext,
  sectionId: string,
  card: ReportCardKind,
): Promise<ReportCardSectionResponse> {
  const plans = await reportCardPlans(conn, context, 'report_cards.read')
  const section = await readSection(conn, context.schoolId, sectionId)
  const today = await schoolToday(conn, context.schoolId)
  const status = await cardExamsStatus(conn, context.schoolId, section, card)
  const roster = await cardRoster(conn, context.schoolId, section, card, today, plans.pupils)
  const latest = await latestVersions(conn, {
    schoolId: context.schoolId,
    academicYearId: section.academic_year_id,
    card,
    studentIds: roster.map((pupil) => pupil.id),
    cards: plans.cards,
  })
  const changed = await changedSince(conn, context.schoolId, section, card, today, latest)
  const actions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'report_card',
    id: sectionId,
  })
  return {
    section: { id: section.id, name: section.name },
    grade: { id: section.grade_id, name: section.grade_name },
    academicYear: { id: section.academic_year_id, name: section.year_name },
    card,
    exams: status.exams.map((exam) => ({
      examId: exam.examId,
      kind: exam.kind,
      published: exam.published,
      changedSincePublished: exam.changedSincePublished,
    })),
    readyToPublish: status.blockedBy === undefined,
    ...(status.blockedBy === undefined ? {} : { blockedBy: status.blockedBy }),
    rows: roster.map((pupil) => {
      const version = latest.get(pupil.id)
      return {
        student: pupilRef(pupil),
        latest: version
          ? {
              versionId: version.id,
              versionNumber: version.versionNumber,
              publishedAt: version.publishedAt,
              changedSince: changed.has(pupil.id),
            }
          : null,
      }
    }),
    allowedActions: [...actions],
  }
}

/** Every published version of one pupil's cards for a year, newest first. */
export async function readStudentReportCards(
  conn: ExamConnection,
  context: RequestContext,
  studentId: string,
  academicYearId: string,
): Promise<StudentReportCardsResponse> {
  const plans = await reportCardPlans(conn, context, 'report_cards.read')
  const year = await readYearName(conn, context.schoolId, academicYearId)
  const pupils = await conn.client.query<{
    id: string
    first_name: string
    last_name: string | null
    admission_number: string
    roll_number: number | null
  }>(
    `SELECT s.id, s.first_name, s.last_name, s.admission_number,
            (SELECT e.roll_number FROM enrollments e
              WHERE e.school_id = s.school_id AND e.student_id = s.id AND e.academic_year_id = $3
              ORDER BY e.joined_on DESC LIMIT 1) AS roll_number
       FROM students s WHERE s.school_id = $1 AND s.id = $2`,
    [context.schoolId, studentId, academicYearId],
  )
  const pupil = requireFound(pupils.rows[0])
  const versions = await conn.db.execute<{
    id: string
    card: ReportCardKind
    version_number: number
    published_at: string
    latest: boolean
  }>(
    sql`SELECT report_card_versions.id, report_card_versions.card, report_card_versions.version_number,
               to_char(report_card_versions.published_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS published_at,
               report_card_versions.version_number = max(report_card_versions.version_number)
                 OVER (PARTITION BY report_card_versions.card) AS latest
          FROM report_card_versions
         WHERE report_card_versions.school_id = ${context.schoolId}::uuid
           AND report_card_versions.student_id = ${studentId}::uuid
           AND report_card_versions.academic_year_id = ${academicYearId}::uuid
           AND (${plans.cards})
         ORDER BY report_card_versions.published_at DESC, report_card_versions.version_number DESC`,
  )
  return {
    student: pupilRef({
      id: pupil.id,
      name: [pupil.first_name, pupil.last_name].filter((part) => part !== null && part !== '').join(' ').slice(0, 160),
      admissionNumber: pupil.admission_number,
      rollNumber: pupil.roll_number === null ? null : Number(pupil.roll_number),
    }),
    academicYear: year,
    cards: versions.rows.map((row) => ({
      id: row.id,
      card: row.card,
      versionNumber: Number(row.version_number),
      publishedAt: row.published_at,
      latest: row.latest === true,
    })),
  }
}

/**
 * One published version as this caller sees it. A family reading a card
 * published under grades gets grades only.
 */
export async function readReportCardView(
  conn: ExamConnection,
  context: RequestContext,
  versionId: string,
): Promise<ReportCardView> {
  const plans = await reportCardPlans(conn, context, 'report_cards.read')
  const rows = await conn.db.execute<{
    id: string
    student_id: string
    card: ReportCardKind
    version_number: number
    published_at: string
    content: unknown
    remarks: unknown
    latest: boolean
  }>(
    sql`SELECT report_card_versions.id, report_card_versions.student_id, report_card_versions.card,
               report_card_versions.version_number,
               to_char(report_card_versions.published_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS published_at,
               report_card_versions.content, report_card_versions.remarks,
               NOT EXISTS (SELECT 1 FROM report_card_versions newer
                            WHERE newer.school_id = report_card_versions.school_id
                              AND newer.student_id = report_card_versions.student_id
                              AND newer.academic_year_id = report_card_versions.academic_year_id
                              AND newer.card = report_card_versions.card
                              AND newer.version_number > report_card_versions.version_number) AS latest
          FROM report_card_versions
         WHERE report_card_versions.school_id = ${context.schoolId}::uuid
           AND report_card_versions.id = ${versionId}::uuid
           AND (${plans.cards})`,
  )
  const row = requireFound(rows.rows[0])
  const content = ReportCardContent.safeParse(row.content)
  const remarks = ReportCardRemarks.safeParse(row.remarks ?? {})
  if (!content.success || !remarks.success) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const view = await resultViewFor(conn, context.schoolId, row.student_id, plans.staffPupils)
  const actions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'report_card',
    id: versionId,
  })
  return {
    id: row.id,
    card: row.card,
    versionNumber: Number(row.version_number),
    publishedAt: row.published_at,
    latest: row.latest === true,
    view,
    content: projectForView(content.data, view),
    remarks: remarks.data,
    allowedActions: [...actions],
  }
}

export function registerReportCardReadRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/report-cards/students/:studentId',
    permission: 'report_cards.read',
    query: StudentReportCardsRequest,
    response: StudentReportCardsResponse,
    handler: async ({ context, param, query }) => {
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // The pupil face: the office, the class teacher of the pupil's class, or their family.
        await decideReportCard(conn, context, 'report_cards.read', studentId)
        return readStudentReportCards(conn, context, studentId, query.academicYearId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/report-cards/versions/:versionId',
    permission: 'report_cards.read',
    response: ReportCardView,
    auditRead: { targetType: 'report_card', param: 'versionId', summary: "Read a pupil's report card." },
    handler: async ({ context, param }) => {
      const versionId = assertUuidParam(param('versionId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideReportCard(conn, context, 'report_cards.read', versionId)
        return readReportCardView(conn, context, versionId)
      })
    },
  })
}
