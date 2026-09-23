import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { withTenantTransaction } from '@erp/db'
import {
  ReportCardKind,
  ReportCardPublishRequest,
  ReportCardPublishResponse,
  ReportCardSectionResponse,
  ReportCardSectionsRequest,
  ReportCardSectionsResponse,
} from '@erp/contracts'
import {
  ApiFailure,
  assertUuidParam,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { decideReportCard, readSection, schoolToday } from '../exams/common.ts'
import { buildReportCard, cardExamsStatus, cardRoster, latestVersions } from './build.ts'
import { readReportCardSections, readSectionCards } from './reads.ts'

/**
 * Preparing and publishing a section's report cards.
 *
 * Publishing freezes each pupil's card as it would be built now into a new
 * version. A pupil whose fresh card hashes the same as their newest version is
 * skipped, earlier versions are always kept, and the remarks never reach the
 * audit row.
 */

/** The card from the path; anything else is a page that does not exist. */
function cardParam(value: string): ReportCardKind {
  const parsed = ReportCardKind.safeParse(value)
  if (!parsed.success) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return parsed.data
}

export function registerReportCardPublishRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/report-cards/sections',
    permission: 'report_cards.read',
    query: ReportCardSectionsRequest,
    response: ReportCardSectionsResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) =>
        readReportCardSections(conn, context, query.academicYearId, query.card),
      ),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/report-cards/sections/:sectionId/cards/:card',
    permission: 'report_cards.read',
    response: ReportCardSectionResponse,
    handler: async ({ context, param }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const card = cardParam(param('card'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideReportCard(conn, context, 'report_cards.read', sectionId)
        return readSectionCards(conn, context, sectionId, card)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/report-cards/sections/:sectionId/cards/:card/publish',
    permission: 'report_cards.publish',
    body: ReportCardPublishRequest,
    response: ReportCardPublishResponse,
    successStatus: 201,
    handler: async ({ context, param, body }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const card = cardParam(param('card'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideReportCard(conn, context, 'report_cards.publish', sectionId)
        const section = await readSection(conn, context.schoolId, sectionId)
        const status = await cardExamsStatus(conn, context.schoolId, section, card)
        if (status.blockedBy !== undefined) throw new ApiFailure('INVALID_REQUEST', undefined, status.blockedBy)

        const today = await schoolToday(conn, context.schoolId)
        const roster = (await cardRoster(conn, context.schoolId, section, card, today, sql`TRUE`)).map(
          (pupil) => pupil.id,
        )
        const onRoster = new Set(roster)
        const named = body.studentIds ?? roster
        if (named.some((id) => !onRoster.has(id))) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'report_card_pupil_not_on_roster')
        }

        // The newest version of every pupil, read school-wide: the next
        // number must follow the row that really exists.
        const latest = await latestVersions(conn, {
          schoolId: context.schoolId,
          academicYearId: section.academic_year_id,
          card,
          studentIds: named,
          cards: sql`TRUE`,
        })
        const toPublish = []
        for (const studentId of named) {
          const built = await buildReportCard(conn, context.schoolId, {
            studentId,
            sectionId,
            academicYearId: section.academic_year_id,
            card,
            today,
          })
          const current = latest.get(studentId)
          if (current !== undefined && current.contentHash === built.hash) continue
          toPublish.push({ studentId, built, versionNumber: (current?.versionNumber ?? 0) + 1 })
        }
        if (toPublish.length === 0) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'report_card_nothing_to_publish')
        }

        for (const item of toPublish) {
          const remarks = Object.keys(item.built.remarks).length === 0 ? null : JSON.stringify(item.built.remarks)
          await conn.client.query(
            `INSERT INTO report_card_versions
               (school_id, student_id, academic_year_id, section_id, card, version_number, content, remarks,
                content_hash, published_by_membership_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
            [
              context.schoolId,
              item.studentId,
              section.academic_year_id,
              sectionId,
              card,
              item.versionNumber,
              JSON.stringify(item.built.content),
              remarks,
              item.built.hash,
              context.membershipId,
            ],
          )
        }

        const unchanged = named.length - toPublish.length
        await writeAudit(conn, context, {
          action: 'report_cards.publish',
          targetType: 'section',
          targetId: sectionId,
          summary: 'Published report cards.',
          safeChanges: {
            sectionId,
            academicYearId: section.academic_year_id,
            card,
            published: toPublish.length,
            unchanged,
          },
        })
        return { published: toPublish.length, unchanged }
      })
    },
  })
}
