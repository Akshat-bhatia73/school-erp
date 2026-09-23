import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { FilesUuid } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { decideReportCard } from '../../modules/exams/common.ts'
import { readCardForFile } from '../../modules/report-cards/exports.ts'
import { readLogo } from '../../modules/setup/logo.ts'
import { exportFileName } from '../naming.ts'
import { PDF_CONTENT_TYPE } from '../pdf/kit.ts'
import { renderReportCards, type PrintedLogo } from '../pdf/report-card.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile, ProducerIo } from '../types.ts'

/** The job row says which version; everything else is read again now. */
const Criteria = z.object({ versionId: FilesUuid })

/**
 * The school's logo for a printed card, or null. A logo that cannot be read
 * leaves its space empty rather than failing the whole card.
 */
export async function logoForCards(
  conn: AuthzConnection,
  context: RequestContext,
  io: ProducerIo | undefined,
): Promise<PrintedLogo | null> {
  if (io === undefined) return null
  try {
    const logo = await readLogo(conn, io.documents, context.schoolId)
    return logo === null ? null : { bytes: logo.bytes }
  } catch {
    return null
  }
}

/** One published card, drawn as it was published. */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
  io?: ProducerIo,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const { versionId } = parsed.data
  // Decided again under the export key: a family whose link has ended, or a
  // class teacher who has moved on, gets no file.
  await decideReportCard(conn, context, 'report_cards.export', versionId)
  const card = await readCardForFile(conn, context, versionId)
  const logo = card.content.showLogo ? await logoForCards(conn, context, io) : null
  const content = card.content
  return {
    bytes: await renderReportCards([card], logo),
    contentType: PDF_CONTENT_TYPE,
    fileName: exportFileName(
      [
        'report-card',
        content.card === 'term_1' ? 'term-1' : 'final',
        content.academicYear.name,
        content.student.admissionNumber,
        `v${card.versionNumber}`,
      ],
      'pdf',
    ),
    rowCount: 1,
  }
}

registerProducer({ kind: 'report_card', produce })
