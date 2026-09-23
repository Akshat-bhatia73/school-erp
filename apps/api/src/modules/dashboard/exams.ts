import { sql } from 'drizzle-orm'
import type { AuthzConnection } from '@erp/authz'
import type {
  DashboardExams,
  DashboardMarksToEnter,
  DashboardReportCard,
  ExamKind,
  ReportCardKind,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { examPlans, examState, reportCardPlans } from '../exams/common.ts'
import { paperCounts, sectionStatuses } from '../exams/reads.ts'
import { rows } from './queries.ts'

/**
 * The exam blocks of the dashboards. Every figure comes from the same readers
 * the exam screens use, under the caller's own plans, so a number here is
 * always a count of rows the matching screen would list. A caller who holds
 * the key nowhere throws ACCESS_DENIED from the plan, which the dashboard's
 * optionalBlock turns into an absent block.
 */

const MARKS_TO_ENTER_LIMIT = 50

/**
 * A subject teacher's papers still waiting for marks: those their
 * `exams.record_marks` plan selects, whose window is open on `date` (from the
 * first day of the exam to the end of the re-check deadline), with fewer
 * cells filled than a full sheet holds. Soonest deadline first.
 */
export async function marksToEnter(
  conn: AuthzConnection,
  context: RequestContext,
  yearId: string,
  date: string,
): Promise<DashboardMarksToEnter[]> {
  const plans = await examPlans(conn, context, 'exams.record_marks')
  const papers = await paperCounts(
    conn,
    context,
    plans,
    sql`exam_papers.academic_year_id = ${yearId}::uuid
        AND exams.starts_on <= ${date}::date AND exams.recheck_deadline >= ${date}::date`,
    sql`exam_marks.academic_year_id = ${yearId}::uuid`,
  )
  return papers
    .filter((paper) => paper.entered < paper.expected && examState(paper.examRow, date) === 'open')
    .sort((a, b) =>
      a.examRow.recheck_deadline === b.examRow.recheck_deadline
        ? 0
        : a.examRow.recheck_deadline < b.examRow.recheck_deadline
          ? -1
          : 1,
    )
    .slice(0, MARKS_TO_ENTER_LIMIT)
    .map((paper) => ({
      paperId: paper.id,
      exam: { id: paper.exam.id, kind: paper.exam.kind, recheckDeadline: paper.examRow.recheck_deadline },
      section: paper.section,
      grade: paper.grade,
      subject: paper.subject,
      entered: paper.entered,
      expected: paper.expected,
    }))
}

interface ExamRowForDashboard extends Record<string, unknown> {
  id: string
  kind: ExamKind
  starts_on: string
  recheck_deadline: string
}

/**
 * The office's card: each of this year's exams the caller's `exams.read` plan
 * selects, with the sections counted by the same status reader the exam
 * overview uses. Undefined when no exam of this year is set up (or the plan
 * selects no exam row, which is the same thing to this caller).
 */
export async function officeExams(
  conn: AuthzConnection,
  context: RequestContext,
  yearId: string,
  date: string,
): Promise<DashboardExams | undefined> {
  const plans = await examPlans(conn, context)
  const exams = await rows<ExamRowForDashboard>(
    conn,
    sql`SELECT exams.id, exams.kind,
               to_char(exams.starts_on, 'YYYY-MM-DD') AS starts_on,
               to_char(exams.recheck_deadline, 'YYYY-MM-DD') AS recheck_deadline
          FROM exams
         WHERE exams.school_id = ${context.schoolId}::uuid
           AND exams.academic_year_id = ${yearId}::uuid
           AND (${plans.exams})
         ORDER BY exams.starts_on, exams.id`,
  )
  if (exams.length === 0) return undefined
  const items: DashboardExams['items'] = []
  for (const exam of exams) {
    const sections = await sectionStatuses(conn, context, { exam, plans, today: date })
    items.push({
      examId: exam.id,
      kind: exam.kind,
      recheckDeadline: exam.recheck_deadline,
      locked: examState(exam, date) === 'locked',
      papersOutstanding: sections.reduce(
        (sum, section) => sum + section.papers.filter((paper) => !paper.complete).length,
        0,
      ),
      sectionsTotal: sections.length,
      sectionsReadyToPublish: sections.filter((section) => section.readyToPublish).length,
      sectionsPublished: sections.filter((section) => section.publication !== null).length,
    })
  }
  return { items }
}

/**
 * The newest published report card of one child, of any year, under the
 * caller's `report_cards.read` plan. A family's plan reaches published
 * versions only, and a version is published by being one, so nothing here
 * can show a figure the school has not handed out.
 */
export async function latestReportCard(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
): Promise<DashboardReportCard | undefined> {
  const plans = await reportCardPlans(conn, context)
  const [row] = await rows<{
    id: string
    card: ReportCardKind
    year_id: string
    year_name: string
    published_at: string
  }>(
    conn,
    sql`SELECT report_card_versions.id, report_card_versions.card,
               ay.id AS year_id, ay.name AS year_name,
               to_char(report_card_versions.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS published_at
          FROM report_card_versions
          JOIN academic_years ay ON ay.school_id = report_card_versions.school_id
                                AND ay.id = report_card_versions.academic_year_id
         WHERE report_card_versions.school_id = ${context.schoolId}::uuid
           AND report_card_versions.student_id = ${studentId}::uuid
           AND (${plans.cards})
         ORDER BY report_card_versions.published_at DESC, report_card_versions.id
         LIMIT 1`,
  )
  if (!row) return undefined
  return {
    versionId: row.id,
    card: row.card,
    academicYear: { id: row.year_id, name: row.year_name },
    publishedAt: row.published_at,
  }
}
