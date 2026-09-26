import { z } from 'zod'
import {
  FeeDuesPage,
  FeeHeadList,
  FeePaymentMode,
  FeeReceiptDetail,
  FeeReceiptKind,
  FeeReceiptPage,
  FeeStatement,
  FeeStructureList,
  type FeeReceiptSummary,
} from '@erp/contracts'
import { readTool } from './types.ts'
import {
  DateInput,
  IdInput,
  NO_YEAR,
  PAGE_SIZE,
  YearInput,
  appPath,
  capped,
  className,
  date,
  dateLabel,
  datetime,
  fact,
  fetchParsed,
  humanise,
  money,
  ok,
  recordCard,
  rupees,
  seg,
  source,
  tableCard,
  tag,
  text,
  toolList,
  yearFor,
} from './present.ts'

function receiptForModel(receipt: FeeReceiptSummary) {
  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    kind: receipt.kind,
    amountRupees: rupees(receipt.amountPaise),
    mode: receipt.mode,
    receivedOn: receipt.receivedOn,
    studentId: receipt.student.id,
    student: receipt.student.name,
    state: receipt.state,
  }
}

const RECEIPT_COLUMNS = [
  { key: 'number', label: 'Receipt' },
  { key: 'date', label: 'Date' },
  { key: 'student', label: 'Pupil' },
  { key: 'kind', label: 'Kind' },
  { key: 'mode', label: 'Mode' },
  { key: 'amount', label: 'Amount', align: 'end' as const },
]

function receiptRow(receipt: FeeReceiptSummary) {
  return {
    cells: {
      number: text(receipt.receiptNumber),
      date: date(receipt.receivedOn),
      student: text(receipt.student.name),
      kind: tag(humanise(receipt.state === 'cancelled' ? 'cancelled' : receipt.kind)),
      mode: text(receipt.mode ? humanise(receipt.mode) : undefined),
      amount: money(receipt.amountPaise),
    },
    href: `/fees/receipts/${seg(receipt.id)}`,
  }
}

export const feeDues = readTool({
  name: 'fee_dues',
  description:
    'Who owes fees and how much: by pupil, 50 at a time, what has fallen due, what is paid and what is still owed, with the totals. Sorted by balance, highest first. Use it for "fees due", "dues", "pending fees", "who has not paid" and "how much is outstanding". Filter by class, section or name.',
  permission: 'fees.read',
  input: z.object({
    onlyWithDues: z.boolean().optional().describe('Only pupils who owe something today. True by default.'),
    gradeId: IdInput('Only this class.').optional(),
    sectionId: IdInput('Only this section.').optional(),
    search: z.string().trim().min(1).max(100).optional().describe('Part of a pupil name or an admission number.'),
    academicYearId: YearInput(),
    page: z.number().int().min(1).max(1000).optional().describe('Page of 50, from 1.'),
  }),
  async run(input, context) {
    const page = input.page ?? 1
    const show = input.onlyWithDues === false ? 'all' : 'due'
    const found = await fetchParsed(context, FeeDuesPage, '/fees/dues', {
      page,
      pageSize: PAGE_SIZE,
      show,
      academicYearId: input.academicYearId,
      gradeId: input.gradeId,
      sectionId: input.sectionId,
      q: input.search,
    })
    if (!found.ok) return found.outcome
    const body = found.body
    // The route already sorts by balance, highest first, across every page.
    const items = body.items
    return ok(
      {
        academicYear: body.academicYear.name,
        asOf: body.asOf,
        totals: {
          outstandingRupees: rupees(body.totals.outstandingPaise),
          dueToDateRupees: rupees(body.totals.dueToDatePaise),
          paidRupees: rupees(body.totals.paidPaise),
          pupilsWithDues: body.totals.studentsWithDues,
        },
        sortedBy: 'balance, highest first',
        pupils: items.map((row) => ({
          studentId: row.student.id,
          name: row.student.name,
          class: className(row.student.grade, row.student.section),
          dueToDateRupees: rupees(row.dueToDatePaise),
          paidRupees: rupees(row.paidPaise),
          balanceRupees: rupees(row.balancePaise),
        })),
        total: body.total,
        page,
        shown: body.items.length,
        morePages: page * PAGE_SIZE < body.total,
      },
      tableCard({
        title: `Fee dues, ${body.academicYear.name}`,
        columns: [
          { key: 'name', label: 'Pupil' },
          { key: 'class', label: 'Class' },
          { key: 'due', label: 'Due to date', align: 'end' },
          { key: 'paid', label: 'Paid', align: 'end' },
          { key: 'balance', label: 'Balance', align: 'end' },
        ],
        rows: items.map((row) => ({
          cells: {
            name: text(row.student.name),
            class: text(className(row.student.grade, row.student.section)),
            due: money(row.dueToDatePaise),
            paid: money(row.paidPaise),
            balance: money(row.balancePaise),
          },
          href: appPath(`/fees/students/${seg(row.student.id)}`, { academicYearId: body.academicYear.id }),
        })),
        total: body.total,
      }),
      source(
        `Fee dues, ${body.academicYear.name}`,
        appPath('/fees', { academicYearId: input.academicYearId, gradeId: input.gradeId, sectionId: input.sectionId, show, q: input.search }),
      ),
    )
  },
})

export const studentFeeStatement = readTool({
  name: 'student_fee_statement',
  description:
    "One pupil's fee statement for a year: each fee with what has fallen due, what is paid and the balance, plus concessions and recent receipts.",
  permission: 'fees.read',
  input: z.object({ studentId: IdInput('The pupil id, from find_students.'), academicYearId: YearInput() }),
  async run(input, context) {
    const found = await fetchParsed(context, FeeStatement, `/fees/students/${seg(input.studentId)}/statement`, {
      academicYearId: input.academicYearId,
    })
    if (!found.ok) return found.outcome
    const body = found.body
    const { totals } = body
    const href = appPath(`/fees/students/${seg(body.student.id)}`, { academicYearId: body.academicYear.id })
    return ok(
      {
        studentId: body.student.id,
        name: body.student.name,
        class: className(body.student.grade, body.student.section),
        academicYear: body.academicYear.name,
        academicYearId: body.academicYear.id,
        asOf: body.asOf,
        totals: {
          chargedForYearRupees: rupees(totals.chargedYearPaise),
          concessionForYearRupees: rupees(totals.concessionYearPaise),
          dueToDateRupees: rupees(totals.dueToDatePaise),
          paidRupees: rupees(totals.paidPaise),
          balanceRupees: rupees(totals.balancePaise),
          leftForYearRupees: rupees(totals.yearBalancePaise),
        },
        fees: body.lines.map((line) => ({
          fee: line.head.name,
          frequency: line.frequency,
          instalmentsDue: `${line.instalmentsDue} of ${line.instalments}`,
          dueToDateRupees: rupees(line.dueToDatePaise),
          paidRupees: rupees(line.paidPaise),
          balanceRupees: rupees(line.balancePaise),
        })),
        concessions: body.concessions.map((concession) => ({
          fee: concession.head?.name ?? 'every fee',
          category: concession.category,
          ...(concession.percentBp !== undefined ? { percent: concession.percentBp / 100 } : {}),
          ...(concession.amountPaise !== undefined ? { amountRupees: rupees(concession.amountPaise) } : {}),
        })),
        recentReceipts: body.receipts.slice(0, 10).map(receiptForModel),
      },
      tableCard({
        title: `Fee statement, ${body.student.name}, ${body.academicYear.name}`,
        columns: [
          { key: 'fee', label: 'Fee' },
          { key: 'due', label: 'Due to date', align: 'end' },
          { key: 'paid', label: 'Paid', align: 'end' },
          { key: 'balance', label: 'Balance', align: 'end' },
          { key: 'year', label: 'Left for the year', align: 'end' },
        ],
        rows: [
          ...body.lines.map((line) => ({
            cells: {
              fee: text(line.head.name),
              due: money(line.dueToDatePaise),
              paid: money(line.paidPaise),
              balance: money(line.balancePaise),
              year: money(line.yearBalancePaise),
            },
          })),
          {
            cells: {
              fee: text('Total'),
              due: money(totals.dueToDatePaise),
              paid: money(totals.paidPaise),
              balance: money(totals.balancePaise),
              year: money(totals.yearBalancePaise),
            },
          },
        ],
      }),
      source(`Fee statement, ${body.student.name}`, href),
    )
  },
})

export const feeReceipts = readTool({
  name: 'fee_receipts',
  description:
    'Fee receipts, 50 at a time, for a period, a pupil, a payment mode or a kind, with the collected, refunded and net totals over every match.',
  permission: 'fees.read',
  input: z.object({
    from: DateInput('First day.').optional(),
    to: DateInput('Last day.').optional(),
    studentId: IdInput('Only this pupil.').optional(),
    mode: FeePaymentMode.optional().describe('Only this payment mode.'),
    kind: FeeReceiptKind.optional().describe('Only this kind of receipt.'),
    search: z.string().trim().min(1).max(100).optional().describe('A receipt number, an admission number or part of a name.'),
    academicYearId: IdInput('Only this academic year.').optional(),
    page: z.number().int().min(1).max(1000).optional().describe('Page of 50, from 1.'),
  }),
  async run(input, context) {
    const page = input.page ?? 1
    const found = await fetchParsed(context, FeeReceiptPage, '/fees/receipts', {
      page,
      pageSize: PAGE_SIZE,
      from: input.from,
      to: input.to,
      studentId: input.studentId,
      mode: input.mode,
      kind: input.kind,
      q: input.search,
      academicYearId: input.academicYearId,
    })
    if (!found.ok) return found.outcome
    const body = found.body
    const period = input.from || input.to ? `${input.from ? dateLabel(input.from) : '…'} to ${input.to ? dateLabel(input.to) : '…'}` : undefined
    return ok(
      {
        totals: {
          collectedRupees: rupees(body.totals.collectedPaise),
          refundedRupees: rupees(body.totals.refundedPaise),
          cancelledRupees: rupees(body.totals.cancelledPaise),
          netRupees: rupees(body.totals.netPaise),
          receipts: body.total,
        },
        receipts: body.items.map(receiptForModel),
        page,
        shown: body.items.length,
        morePages: page * PAGE_SIZE < body.total,
      },
      tableCard({
        title: period ? `Receipts, ${period}` : 'Receipts',
        columns: RECEIPT_COLUMNS,
        rows: body.items.map(receiptRow),
        total: body.total,
      }),
      source(
        period ? `Collections, ${period}` : 'Collections',
        appPath('/fees/collections', { from: input.from, to: input.to, mode: input.mode, kind: input.kind, q: input.search, academicYearId: input.academicYearId }),
      ),
    )
  },
})

export const feeReceipt = readTool({
  name: 'fee_receipt',
  description: 'One fee receipt in full: the pupil, each fee paid, the mode and reference, and any refund or cancellation of it.',
  permission: 'fees.read',
  input: z.object({ receiptId: IdInput('The receipt id, from fee_receipts or a fee statement.') }),
  async run(input, context) {
    const found = await fetchParsed(context, FeeReceiptDetail, `/fees/receipts/${seg(input.receiptId)}`)
    if (!found.ok) return found.outcome
    const receipt = found.body
    const href = `/fees/receipts/${seg(receipt.id)}`
    return ok(
      {
        ...receiptForModel(receipt),
        academicYear: receipt.academicYear.name,
        reference: receipt.reference,
        payerName: receipt.payerName,
        lines: receipt.lines.map((line) => ({ fee: line.head.name, amountRupees: rupees(line.amountPaise) })),
        refundableRupees: receipt.refundablePaise === undefined ? undefined : rupees(receipt.refundablePaise),
        reversedBy: receipt.reversedBy.map((row) => ({ receiptNumber: row.receiptNumber, kind: row.kind, amountRupees: rupees(row.amountPaise), on: row.receivedOn })),
        reverses: receipt.reverses?.receiptNumber,
      },
      recordCard({
        entity: 'other',
        title: `Receipt ${receipt.receiptNumber}`,
        subtitle: `${receipt.student.name}, ${receipt.academicYear.name}`,
        tags: [humanise(receipt.kind), receipt.state ? humanise(receipt.state) : undefined],
        facts: [
          fact('Amount', money(receipt.amountPaise)),
          fact('Received on', date(receipt.receivedOn)),
          fact('Mode', text(receipt.mode ? humanise(receipt.mode) : undefined)),
          fact('Reference', text(receipt.reference)),
          fact('Paid by', text(receipt.payerName)),
          ...receipt.lines.slice(0, 12).map((line) => fact(line.head.name, money(line.amountPaise))),
          fact('Recorded at', datetime(receipt.recordedAt)),
          receipt.refundablePaise !== undefined ? fact('Still refundable', money(receipt.refundablePaise)) : undefined,
        ],
        href,
      }),
      source(`Receipt ${receipt.receiptNumber}`, href),
    )
  },
})

export const feeHeads = readTool({
  name: 'fee_heads',
  description:
    "The school's fee setup: the names of its fees (tuition, transport and so on), who is charged each and how often. It says nothing about what anyone owes or paid; for that use fee_dues or fee_receipts.",
  permission: 'fees.read',
  input: z.object({}),
  async run(_input, context) {
    const found = await fetchParsed(context, FeeHeadList, '/fees/heads')
    if (!found.ok) return found.outcome
    const list = capped(found.body)
    return ok(
      {
        fees: list.items.map((head) => ({ id: head.id, name: head.name, category: head.category, appliesTo: head.appliesTo, frequency: head.frequency, active: head.active })),
        shown: list.items.length,
        total: list.total,
      },
      tableCard({
        title: 'Fees',
        columns: [
          { key: 'name', label: 'Fee' },
          { key: 'category', label: 'Category' },
          { key: 'applies', label: 'Charged to' },
          { key: 'frequency', label: 'How often' },
          { key: 'active', label: 'Status' },
        ],
        rows: list.items.map((head) => ({
          cells: {
            name: text(head.name),
            category: text(humanise(head.category)),
            applies: text(head.appliesTo === 'class' ? 'Whole class' : 'Pupils who take it'),
            frequency: text(humanise(head.frequency)),
            active: tag(head.active ? 'In use' : 'Retired'),
          },
        })),
        total: list.total,
      }),
      source('Fee setup', '/fees/setup'),
    )
  },
})

export const feeStructures = readTool({
  name: 'fee_structures',
  description: 'The fee setup: what each fee costs per instalment for each class in a year. Not what anyone owes; for that use fee_dues.',
  permission: 'fees.read',
  input: z.object({ gradeId: IdInput('Only this class.').optional(), academicYearId: YearInput() }),
  async run(input, context) {
    const academicYearId = yearFor(input, context)
    if (academicYearId === null) return NO_YEAR
    const found = await fetchParsed(context, FeeStructureList, '/fees/structures', { academicYearId, gradeId: input.gradeId })
    if (!found.ok) return found.outcome
    const list = capped(found.body)
    return ok(
      {
        academicYearId,
        structures: list.items.map((row) => ({
          fee: row.head.name,
          class: row.grade?.name ?? 'every class',
          amountPerInstalmentRupees: rupees(row.amountPaise),
          frequency: row.frequency,
          appliesTo: row.appliesTo,
        })),
        shown: list.items.length,
        total: list.total,
      },
      tableCard({
        title: list.items[0] ? `Fee amounts, ${list.items[0].academicYear.name}` : 'Fee amounts',
        columns: [
          { key: 'fee', label: 'Fee' },
          { key: 'class', label: 'Class' },
          { key: 'frequency', label: 'How often' },
          { key: 'amount', label: 'Per instalment', align: 'end' },
        ],
        rows: list.items.map((row) => ({
          cells: { fee: text(row.head.name), class: text(row.grade?.name ?? 'Every class'), frequency: text(humanise(row.frequency)), amount: money(row.amountPaise) },
        })),
        total: list.total,
      }),
      source('Fee setup', '/fees/setup'),
    )
  },
})

export const FEE_TOOLS = toolList(feeDues, studentFeeStatement, feeReceipts, feeReceipt, feeHeads, feeStructures)
