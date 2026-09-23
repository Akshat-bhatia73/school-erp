import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import {
  ReportCardContent,
  ReportCardExportJob,
  ReportCardExportRequest,
  ReportCardKind,
  ReportCardRemarks,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { insertExportJob } from '../../exports/jobs.ts'
import { createAndMaybeProduce } from '../../exports/run.ts'
import {
  ApiFailure,
  assertUuidParam,
  protectedRoute,
  requireFound,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  decideReportCard,
  readSection,
  reportCardPlans,
  schoolToday,
  type ExamConnection,
} from '../exams/common.ts'
import { cardRoster, latestVersions, projectForView } from './build.ts'

/**
 * One card, and a section's cards, as a file.
 *
 * Both run under `report_cards.export`, never the read key. A parent holds
 * `report_cards.export` at their own children, so the copy a family prints is
 * decided exactly like the office's: by the export key on the named record.
 * The route decides and counts; the producer reads the versions again under
 * the requester's own export plans when it makes the bytes.
 *
 * The file always draws a card as it was published, under the display mode
 * frozen into it, because it is the document handed to the family: a card
 * published under grades prints grades alone, whoever prints it.
 */

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

/** One published version, as the file draws it. */
export interface CardForFile {
  readonly id: string
  readonly studentId: string
  readonly versionNumber: number
  readonly publishedAt: string
  readonly content: ReportCardContent
  readonly remarks: ReportCardRemarks
}

interface VersionRow extends Record<string, unknown> {
  id: string
  student_id: string
  version_number: number
  published_at: string
  content: unknown
  remarks: unknown
}

function cardFromRow(row: VersionRow): CardForFile {
  const content = ReportCardContent.safeParse(row.content)
  const remarks = ReportCardRemarks.safeParse(row.remarks ?? {})
  if (!content.success || !remarks.success) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return {
    id: row.id,
    studentId: row.student_id,
    versionNumber: Number(row.version_number),
    publishedAt: row.published_at,
    // The family projection under the card's own frozen mode: what was handed out.
    content: projectForView(content.data, 'family'),
    remarks: remarks.data,
  }
}

/**
 * One version under the caller's `report_cards.export` plan. The version has
 * already been decided; a row the plan does not reach is not there.
 */
export async function readCardForFile(
  conn: ExamConnection,
  context: RequestContext,
  versionId: string,
): Promise<CardForFile> {
  const plans = await reportCardPlans(conn, context, 'report_cards.export')
  const rows = await conn.db.execute<VersionRow>(
    sql`SELECT report_card_versions.id, report_card_versions.student_id, report_card_versions.version_number,
               to_char(report_card_versions.published_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS published_at,
               report_card_versions.content, report_card_versions.remarks
          FROM report_card_versions
         WHERE report_card_versions.school_id = ${context.schoolId}::uuid
           AND report_card_versions.id = ${versionId}::uuid
           AND (${plans.cards})`,
  )
  return cardFromRow(requireFound(rows.rows[0]))
}

/**
 * The newest version of this card for each pupil on the section's card
 * roster, in roll order, all under the caller's `report_cards.export` plans.
 * A pupil with no published card is left out. The section has already been
 * decided.
 */
export async function readSectionCardsForFile(
  conn: ExamConnection,
  context: RequestContext,
  sectionId: string,
  card: ReportCardKind,
): Promise<{ section: { gradeName: string; sectionName: string; yearName: string }; cards: CardForFile[] }> {
  const plans = await reportCardPlans(conn, context, 'report_cards.export')
  const section = await readSection(conn, context.schoolId, sectionId)
  const today = await schoolToday(conn, context.schoolId)
  const roster = await cardRoster(conn, context.schoolId, section, card, today, plans.pupils)
  const latest = await latestVersions(conn, {
    schoolId: context.schoolId,
    academicYearId: section.academic_year_id,
    card,
    studentIds: roster.map((pupil) => pupil.id),
    cards: plans.cards,
  })
  const ids = roster.flatMap((pupil) => {
    const version = latest.get(pupil.id)
    return version === undefined ? [] : [version.id]
  })
  const cards: CardForFile[] = []
  if (ids.length > 0) {
    const rows = await conn.db.execute<VersionRow>(
      sql`SELECT report_card_versions.id, report_card_versions.student_id, report_card_versions.version_number,
                 to_char(report_card_versions.published_at AT TIME ZONE 'UTC', ${sql.raw(ISO)}) AS published_at,
                 report_card_versions.content, report_card_versions.remarks
            FROM report_card_versions
           WHERE report_card_versions.school_id = ${context.schoolId}::uuid
             AND report_card_versions.id = ANY(ARRAY[${sql.join(
               ids.map((id) => sql`${id}::uuid`),
               sql`, `,
             )}])
             AND (${plans.cards})`,
    )
    const byId = new Map(rows.rows.map((row) => [row.id, row]))
    // The roster is already in roll order, so the pages follow it.
    for (const id of ids) {
      const row = byId.get(id)
      if (row) cards.push(cardFromRow(row))
    }
  }
  return {
    section: { gradeName: section.grade_name, sectionName: section.name, yearName: section.year_name },
    cards,
  }
}

/** A card kind in a path, or a path to nothing. */
function assertCardParam(value: string): ReportCardKind {
  const parsed = ReportCardKind.safeParse(value)
  if (!parsed.success) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return parsed.data
}

export function registerReportCardExportRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  // One published version as a document. The parent's own copy runs under
  // report_cards.export (held at own_children), not under the read key.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/report-cards/versions/:versionId/export',
    permission: 'report_cards.export',
    body: ReportCardExportRequest,
    response: ReportCardExportJob,
    successStatus: 202,
    handler: async ({ context, param }) => {
      const versionId = assertUuidParam(param('versionId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A card this caller may not export answers exactly like one that is
        // not there, whether it belongs to another family or another class.
        await decideReportCard(conn, context, 'report_cards.export', versionId)
        const found = await readCardForFile(conn, context, versionId)

        const jobId = await insertExportJob(conn, context, {
          kind: 'report_card',
          permission: 'report_cards.export',
          criteria: { versionId },
          summary: "Requested a pupil's report card as a document.",
          safeChanges: { versionId, studentId: found.studentId },
        })
        // One record is always small, so the file is made in this request.
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: 1 })
      })
    },
  })

  // A section's newest cards, one pupil per page, in one document.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/report-cards/sections/:sectionId/cards/:card/export',
    permission: 'report_cards.export',
    body: ReportCardExportRequest,
    response: ReportCardExportJob,
    successStatus: 202,
    handler: async ({ context, param }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const card = assertCardParam(param('card'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideReportCard(conn, context, 'report_cards.export', sectionId)
        const counted = await readSectionCardsForFile(conn, context, sectionId, card)
        const rows = counted.cards.length
        // Nothing published means nothing to print. It is not a refusal of
        // access, so it carries no reason and reveals nothing.
        if (rows === 0) throw new ApiFailure('INVALID_REQUEST')

        const jobId = await insertExportJob(conn, context, {
          kind: 'report_cards_section',
          permission: 'report_cards.export',
          criteria: { sectionId, card },
          summary: "Requested a section's report cards as a document.",
          safeChanges: { sectionId, card, rows },
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: rows })
      })
    },
  })
}
