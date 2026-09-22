import type { AuthzConnection } from '@erp/authz'
import { FeeDuesExportRequest, type FeeDuesRow } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { readDues } from '../../modules/fees/statement.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE } from '../pdf/kit.ts'
import { formatRupees } from './fee-receipt.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, XLSX_CONTENT_TYPE } from '../xlsx.ts'

/** The whole request is the criteria: one year, the filters, one format. */
const Criteria = FeeDuesExportRequest

/** How many pupils one read brings back, and how many the file may hold. */
const PAGE_SIZE = 100
const MAX_ROWS = 20_000

/** Paise as a spreadsheet number: rupees with two decimals, in the cell. */
function rupees(paise: number): number {
  return Math.round(paise) / 100
}

/**
 * Every pupil the dues list answers for these filters, read page by page
 * through the very reader the screen uses. The caller's own plans are inside
 * that reader, so a file holds a pupil only when their statement would open.
 */
async function readAll(
  conn: AuthzConnection,
  context: RequestContext,
  request: FeeDuesExportRequest,
): Promise<{ rows: FeeDuesRow[]; yearName: string; asOf: string }> {
  const rows: FeeDuesRow[] = []
  let yearName = ''
  let asOf = ''
  for (let page = 1; rows.length < MAX_ROWS; page += 1) {
    const answer = await readDues(conn, context, {
      academicYearId: request.academicYearId,
      ...(request.gradeId === undefined ? {} : { gradeId: request.gradeId }),
      ...(request.sectionId === undefined ? {} : { sectionId: request.sectionId }),
      show: request.show,
      page,
      pageSize: PAGE_SIZE,
    })
    yearName = answer.academicYear.name
    asOf = answer.asOf
    rows.push(...answer.items)
    if (answer.items.length < PAGE_SIZE || rows.length >= answer.total) break
  }
  return { rows, yearName, asOf }
}

/** What the file says it covers, in the words the filters were asked in. */
function scopeLine(rows: readonly FeeDuesRow[], request: FeeDuesExportRequest): string {
  const first = rows[0]?.student
  const parts: string[] = []
  if (request.gradeId !== undefined && first?.grade !== undefined) parts.push(first.grade.name)
  if (request.sectionId !== undefined && first?.section !== undefined) {
    parts.push(`Section ${first.section.name}`)
  }
  if (request.show === 'due') parts.push('only pupils who owe something')
  return parts.length === 0 ? 'All pupils' : parts.join(' · ')
}

const COLUMNS = [
  { header: 'Admission number', key: 'admissionNumber', width: 20 },
  { header: 'Pupil', key: 'name', width: 30 },
  { header: 'Class', key: 'grade', width: 14 },
  { header: 'Section', key: 'section', width: 12 },
  { header: 'Fee for the year', key: 'charged', width: 18 },
  { header: 'Due so far', key: 'due', width: 16 },
  { header: 'Paid', key: 'paid', width: 16 },
  { header: 'Balance', key: 'balance', width: 16 },
] as const

/**
 * Who owes what, as a spreadsheet or a document. Every figure comes from the
 * shared charges reader, so the file and the screen can never disagree about
 * a balance.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const request = parsed.data
  const { rows, yearName, asOf } = await readAll(conn, context, request)

  const totals = rows.reduce(
    (carry, row) => ({
      charged: carry.charged + row.chargedYearPaise,
      due: carry.due + row.dueToDatePaise,
      paid: carry.paid + row.paidPaise,
      balance: carry.balance + row.balancePaise,
    }),
    { charged: 0, due: 0, paid: 0, balance: 0 },
  )
  const fileName = exportFileName(
    ['fee', 'dues', yearName, fileNameDate(context.now)],
    request.format,
  )

  if (request.format === 'xlsx') {
    const sheet = rows.map((row) => ({
      admissionNumber: row.student.admissionNumber,
      name: row.student.name,
      grade: row.student.grade?.name ?? '',
      section: row.student.section?.name ?? '',
      charged: rupees(row.chargedYearPaise),
      due: rupees(row.dueToDatePaise),
      paid: rupees(row.paidPaise),
      balance: rupees(row.balancePaise),
    }))
    // The last row adds the columns up, so a reader who prints the sheet still
    // sees what the screen's footer showed them.
    return {
      bytes: await buildWorkbook({
        sheetName: 'Fee dues',
        columns: COLUMNS,
        rows: [
          ...sheet,
          {
            admissionNumber: '',
            name: `Total (${rows.length} pupils)`,
            grade: '',
            section: '',
            charged: rupees(totals.charged),
            due: rupees(totals.due),
            paid: rupees(totals.paid),
            balance: rupees(totals.balance),
          },
        ],
      }),
      contentType: XLSX_CONTENT_TYPE,
      fileName,
      rowCount: rows.length,
    }
  }

  const document = await openDocument(conn, context, { title: 'Fee dues', landscape: true })
  document.personHeader({
    name: `Fee dues ${yearName}`.trim(),
    subtitle: `As on ${asOf}`,
    tags: [scopeLine(rows, request)],
  })
  document.panel('Pupils', {
    kind: 'table',
    columns: [
      { header: 'Admission number', width: 0.16 },
      { header: 'Pupil', width: 0.26, emphasis: 'primary' },
      { header: 'Class', width: 0.14 },
      { header: 'Fee for the year', width: 0.11 },
      { header: 'Due so far', width: 0.11 },
      { header: 'Paid', width: 0.11 },
      { header: 'Balance', width: 0.11, emphasis: 'primary' },
    ],
    rows: rows.map((row) => [
      row.student.admissionNumber,
      row.student.name,
      [row.student.grade?.name, row.student.section?.name].filter(Boolean).join(' '),
      formatRupees(row.chargedYearPaise),
      formatRupees(row.dueToDatePaise),
      formatRupees(row.paidPaise),
      formatRupees(row.balancePaise),
    ]),
  })
  document.panel('Totals', {
    kind: 'facts',
    facts: [
      { label: 'Pupils', value: String(rows.length) },
      { label: 'Fee for the year', value: formatRupees(totals.charged) },
      { label: 'Due so far', value: formatRupees(totals.due) },
      { label: 'Paid', value: formatRupees(totals.paid) },
      { label: 'Balance', value: formatRupees(totals.balance) },
    ],
  })

  return {
    bytes: await document.finish(),
    contentType: PDF_CONTENT_TYPE,
    fileName,
    rowCount: rows.length,
  }
}

registerProducer({ kind: 'fee_dues', produce })
