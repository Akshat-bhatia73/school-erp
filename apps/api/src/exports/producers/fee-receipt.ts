import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { FilesUuid } from '@erp/contracts'
import type { FeeReceiptDetail } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { readReceipt } from '../../modules/fees/receipts.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE, formatPdfDate, type Fact } from '../pdf/kit.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'

/** The job row says which ledger row; everything else is decided here, now. */
const Criteria = z.object({ receiptId: FilesUuid })

/**
 * Money as an Indian school writes it. The rupee sign is used because both
 * faces of the embedded Inter font carry the glyph, so nothing falls back to
 * an empty box.
 */
export function formatRupees(paise: number): string {
  const rupees = Math.abs(paise) / 100
  const text = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees)
  return `${paise < 0 ? '-' : ''}₹${text}`
}

/** What the document calls itself, by the kind of row it prints. */
function titleOf(kind: FeeReceiptDetail['kind']): string {
  if (kind === 'refund') return 'Refund'
  if (kind === 'cancellation') return 'Cancelled receipt'
  if (kind === 'payment') return 'Fee receipt'
  return 'Fee adjustment'
}

/** "credit_adjustment" is a stored value, "Credit adjustment" is read by people. */
function label(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Facts drop what the row does not carry rather than printing empty lines. */
function fact(name: string, value: string | undefined): Fact[] {
  if (value === undefined || value === '') return []
  return [{ label: name, value }]
}

/**
 * The line a reader needs most: whether the money on this page still stands.
 * A cancelled payment is not a payment any more, and a refunded one has gone
 * back, so the page says so instead of leaving somebody to work it out.
 */
function standingNote(receipt: FeeReceiptDetail): string | undefined {
  if (receipt.kind !== 'payment') return undefined
  if (receipt.state === 'cancelled') return 'This payment has been cancelled. It is not a valid receipt.'
  if (receipt.state === 'refunded') return 'The whole of this payment has been refunded.'
  if (receipt.state === 'partly_refunded') {
    const refunded = receipt.amountPaise - (receipt.refundablePaise ?? 0)
    return `Part of this payment has been refunded: ${formatRupees(refunded)} of ${formatRupees(receipt.amountPaise)}.`
  }
  return undefined
}

async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  // The reader applies this caller's own fee plan, so a row they may not read
  // is not there when the file is made, whoever asked for the job.
  const receipt = await readReceipt(conn, context, parsed.data.receiptId)

  const className = [receipt.student.grade?.name, receipt.student.section?.name]
    .filter((part) => part !== undefined && part !== '')
    .join(' ')
  const title = titleOf(receipt.kind)

  const document = await openDocument(conn, context, { title })
  document.personHeader({
    name: receipt.student.name,
    subtitle: `Admission number ${receipt.student.admissionNumber}`,
    tags: [
      title,
      ...(className === '' ? [] : [className]),
      ...(receipt.state === undefined || receipt.state === 'standing' ? [] : [label(receipt.state)]),
    ],
  })

  document.panel(title, {
    kind: 'facts',
    facts: [
      ...fact('Number', receipt.receiptNumber),
      ...fact('Date', formatPdfDate(receipt.receivedOn)),
      ...fact('Academic year', receipt.academicYear.name),
      ...fact('Class', className),
      ...fact('Amount', formatRupees(receipt.amountPaise)),
      ...fact('Mode', receipt.mode === undefined ? undefined : label(receipt.mode)),
      ...fact('Reference', receipt.reference),
      ...fact('Paid by', receipt.payerName),
      // A refund, a cancellation or an adjustment is always about an earlier
      // row, so the page names the one it answers.
      ...fact(
        'Against receipt',
        receipt.reverses === undefined ? undefined : receipt.reverses.receiptNumber,
      ),
    ],
  })

  if (receipt.lines.length > 0) {
    document.panel('Heads', {
      kind: 'table',
      columns: [
        { header: 'Fee head', width: 0.65 },
        { header: 'Amount', width: 0.35, emphasis: 'primary' },
      ],
      rows: [
        ...receipt.lines.map((line) => [line.head.name, formatRupees(line.amountPaise)]),
        ['Total', formatRupees(receipt.lines.reduce((carry, line) => carry + line.amountPaise, 0))],
      ],
    })
  }

  const note = standingNote(receipt)
  if (note !== undefined) document.note(note)

  return {
    bytes: await document.finish(),
    contentType: PDF_CONTENT_TYPE,
    fileName: exportFileName(
      ['fee', 'receipt', receipt.receiptNumber, fileNameDate(context.now)],
      'pdf',
    ),
    rowCount: 1,
  }
}

registerProducer({ kind: 'fee_receipt', produce })
