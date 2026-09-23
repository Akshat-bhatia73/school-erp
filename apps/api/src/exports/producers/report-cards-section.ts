import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { FilesUuid, ReportCardKind } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { decideReportCard } from '../../modules/exams/common.ts'
import { readSectionCardsForFile } from '../../modules/report-cards/exports.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { PDF_CONTENT_TYPE } from '../pdf/kit.ts'
import { renderReportCards } from '../pdf/report-card.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile, ProducerIo } from '../types.ts'
import { logoForCards } from './report-card.ts'

/** The job row says which section and which card; the rest is read again now. */
const Criteria = z.object({ sectionId: FilesUuid, card: ReportCardKind })

/**
 * A section's newest cards in one document, one pupil after another in roll
 * order, each drawn as it was published. Only pupils the requester's own
 * export plan reaches are printed.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
  io?: ProducerIo,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const { sectionId, card } = parsed.data
  await decideReportCard(conn, context, 'report_cards.export', sectionId)
  const found = await readSectionCardsForFile(conn, context, sectionId, card)
  // A document with no page is not a file anybody wants.
  if (found.cards.length === 0) throw new ApiFailure('INVALID_REQUEST')
  const logo = found.cards.some((entry) => entry.content.showLogo) ? await logoForCards(conn, context, io) : null
  return {
    bytes: await renderReportCards(found.cards, logo),
    contentType: PDF_CONTENT_TYPE,
    fileName: exportFileName(
      [
        'report-cards',
        card === 'term_1' ? 'term-1' : 'final',
        found.section.gradeName,
        found.section.sectionName,
        found.section.yearName,
        fileNameDate(context.now),
      ],
      'pdf',
    ),
    rowCount: found.cards.length,
  }
}

registerProducer({ kind: 'report_cards_section', produce })
