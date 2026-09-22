import type { AuthzConnection } from '@erp/authz'
import { FeeCollectionsExportRequest, type FeeReceiptSummary } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { listReceipts } from '../../modules/fees/receipts.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE, formatPdfDate } from '../pdf/kit.ts'
import { formatRupees } from './fee-receipt.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, XLSX_CONTENT_TYPE } from '../xlsx.ts'

/** The whole request is the criteria: a window, a mode maybe, one format. */
const Criteria = FeeCollectionsExportRequest

/** How many rows one read brings back, and how many the file may hold. */
const PAGE_SIZE = 100
const MAX_ROWS = 20_000

function rupees(paise: number): number {
  return Math.round(paise) / 100
}

/** "credit_adjustment" is a stored value; a register says it in plain words. */
const KIND_WORDS: Readonly<Record<FeeReceiptSummary['kind'], string>> = {
  payment: 'Payment',
  refund: 'Refund',
  cancellation: 'Cancellation',
  credit_adjustment: 'Credit adjustment',
  debit_adjustment: 'Debit adjustment',
}

/** "bank_transfer" is a stored value, "Bank transfer" is what a person reads. */
function label(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

interface Register {
  readonly rows: FeeReceiptSummary[]
  readonly totals: { collectedPaise: number; refundedPaise: number; netPaise: number }
}

/**
 * Every ledger row of the window, page by page through the very reader the
 * register screen uses. The totals are the ones that reader reports over the
 * whole search, not a sum of the pages taken, so they describe the file even
 * when the row cap stops it short.
 */
async function readAll(
  conn: AuthzConnection,
  context: RequestContext,
  request: FeeCollectionsExportRequest,
): Promise<Register> {
  const filters = {
    from: request.from,
    to: request.to,
    ...(request.mode === undefined ? {} : { mode: request.mode }),
  }
  const rows: FeeReceiptSummary[] = []
  let totals = { collectedPaise: 0, refundedPaise: 0, netPaise: 0 }
  for (let page = 1; rows.length < MAX_ROWS; page += 1) {
    const answer = await listReceipts(conn, context, filters, { page, pageSize: PAGE_SIZE })
    totals = {
      collectedPaise: answer.totals.collectedPaise,
      refundedPaise: answer.totals.refundedPaise,
      netPaise: answer.totals.netPaise,
    }
    rows.push(...answer.items)
    if (answer.items.length < PAGE_SIZE || rows.length >= answer.total) break
  }
  return { rows, totals }
}

const COLUMNS = [
  { header: 'Number', key: 'number', width: 20 },
  { header: 'Date', key: 'date', width: 14 },
  { header: 'Pupil', key: 'name', width: 30 },
  { header: 'Admission number', key: 'admissionNumber', width: 20 },
  { header: 'Kind', key: 'kind', width: 18 },
  { header: 'Mode', key: 'mode', width: 16 },
  { header: 'Standing', key: 'state', width: 16 },
  { header: 'Amount', key: 'amount', width: 16 },
] as const

/**
 * The collection register: what came in and what went back between two dates,
 * as a spreadsheet or a document. A cancelled payment is still printed,
 * because a register that quietly dropped rows could not be reconciled, but
 * it is marked and it is not counted as money collected.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const request = parsed.data
  const { rows, totals } = await readAll(conn, context, request)

  const window = `${formatPdfDate(request.from)} to ${formatPdfDate(request.to)}`
  const fileName = exportFileName(
    ['fee', 'collections', request.from, request.to, fileNameDate(context.now)],
    request.format,
  )

  if (request.format === 'xlsx') {
    const sheet = rows.map((row) => ({
      number: row.receiptNumber,
      date: row.receivedOn,
      name: row.student.name,
      admissionNumber: row.student.admissionNumber,
      kind: KIND_WORDS[row.kind],
      mode: row.mode === undefined ? '' : label(row.mode),
      state: row.state === undefined ? '' : label(row.state),
      amount: rupees(row.amountPaise),
    }))
    return {
      bytes: await buildWorkbook({
        sheetName: 'Collections',
        columns: COLUMNS,
        rows: [
          ...sheet,
          { number: '', date: '', name: 'Collected', admissionNumber: '', kind: '', mode: '', state: '', amount: rupees(totals.collectedPaise) },
          { number: '', date: '', name: 'Refunded', admissionNumber: '', kind: '', mode: '', state: '', amount: rupees(totals.refundedPaise) },
          { number: '', date: '', name: 'Net', admissionNumber: '', kind: '', mode: '', state: '', amount: rupees(totals.netPaise) },
        ],
      }),
      contentType: XLSX_CONTENT_TYPE,
      fileName,
      rowCount: rows.length,
    }
  }

  const document = await openDocument(conn, context, {
    title: 'Fee collections',
    landscape: true,
  })
  document.personHeader({
    name: 'Fee collections',
    subtitle: window,
    tags: [
      ...(request.mode === undefined ? [] : [label(request.mode)]),
      `${rows.length} rows`,
    ],
  })
  document.panel('The register', {
    kind: 'table',
    columns: [
      { header: 'Number', width: 0.16 },
      { header: 'Date', width: 0.11 },
      { header: 'Pupil', width: 0.22, emphasis: 'primary' },
      { header: 'Admission number', width: 0.14 },
      { header: 'Kind', width: 0.13 },
      { header: 'Mode', width: 0.11 },
      { header: 'Amount', width: 0.13, emphasis: 'primary' },
    ],
    rows: rows.map((row) => [
      row.receiptNumber,
      formatPdfDate(row.receivedOn),
      // The standing of a payment sits under the pupil's name, so a cancelled
      // row cannot be mistaken for money the school holds.
      {
        title: row.student.name,
        lines: row.state === undefined || row.state === 'standing' ? [] : [label(row.state)],
      },
      row.student.admissionNumber,
      KIND_WORDS[row.kind],
      row.mode === undefined ? '' : label(row.mode),
      formatRupees(row.amountPaise),
    ]),
  })
  document.panel('Totals', {
    kind: 'facts',
    facts: [
      { label: 'Collected', value: formatRupees(totals.collectedPaise) },
      { label: 'Refunded', value: formatRupees(totals.refundedPaise) },
      { label: 'Net', value: formatRupees(totals.netPaise) },
    ],
  })

  return {
    bytes: await document.finish(),
    contentType: PDF_CONTENT_TYPE,
    fileName,
    rowCount: rows.length,
  }
}

registerProducer({ kind: 'fee_collections', produce })
