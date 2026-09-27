/**
 * The assistant's fee tools (Task 24d), on their own: recording a payment,
 * giving a concession and adding an optional fee.
 *
 * Each tool reads only through `context.get`, so these tests hand it a test
 * context that answers the fee routes with fixed bodies (parsed by the same
 * contracts the routes use) and records what was asked. That covers finding
 * the pupil, the order a payment goes to what is due, the problems a card
 * must fix before Confirm, what an edited card may change, and the words of a
 * done card. The end-to-end suite (assistant-fee-proposals.test.ts) sends the
 * writes through the real routes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AcademicYearList,
  FeeConcessionPreview,
  FeeDuesPage,
  FeeHeadList,
  FeeOptInPreview,
  FeePaymentPreview,
  FeeReceiptDetail,
  FeeStatement,
  FeeStructureList,
  ROLE_TEMPLATES,
  type AssistantProposalPreview,
  type FeeStatementLine,
  type FeeStructure,
  type FeeStudent,
  type PermissionKey,
} from '@erp/contracts'
import { proposeToolNamed, proposeToolsFor } from '../src/assistant/proposals/registry.ts'
import { feeStatementCheckView, paiseOf, rupeesLabel, structureAmountFor } from '../src/assistant/proposals/fees.ts'
import type { AnyProposeTool, PrepareOutcome, ProposalDraft, WriteRequest } from '../src/assistant/proposals/types.ts'
import type { RouteAnswer, ToolCallContext } from '../src/assistant/tools/types.ts'

// ---------------------------------------------------------------------------
// Fixed route answers.

const TODAY = '2026-09-28'
const YEAR = { id: 'year-2026', name: '2026-27' }
const GRADE = { id: 'grade-9', name: 'Class 9' }
const SECTION = { id: 'section-9a', name: 'A' }

function pupil(id: string, name: string, admissionNumber: string): FeeStudent {
  return { id, name, admissionNumber, grade: GRADE, section: SECTION }
}

const AARAV = pupil('pupil-aarav', 'Aarav Shah', 'SPS/0012')
const RIYA_S = pupil('pupil-riya-s', 'Riya Sharma', 'SPS/0020')
const RIYA_P = pupil('pupil-riya-p', 'Riya Patel', 'SPS/0021')
const REGISTER = [AARAV, RIYA_S, RIYA_P]

function duesPage(q: string | undefined): FeeDuesPage {
  const wanted = q?.toLowerCase()
  const items = REGISTER.filter(
    (student) => wanted === undefined || student.name.toLowerCase().split(' ').some((part) => part.includes(wanted)) || student.admissionNumber.toLowerCase().includes(wanted),
  ).map((student) => ({ student, chargedYearPaise: 0, dueToDatePaise: 0, paidPaise: 0, balancePaise: 0, allowedActions: [] }))
  return FeeDuesPage.parse({
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
    academicYear: YEAR,
    asOf: TODAY,
    totals: { dueToDatePaise: 0, paidPaise: 0, outstandingPaise: 0, studentsWithDues: 0 },
  })
}

function line(
  id: string,
  name: string,
  figures: { balance: number; oldestDueOn?: string; charged?: number; frequency?: FeeStatementLine['frequency']; instalments?: number },
): FeeStatementLine {
  return {
    head: { id, name },
    category: 'other',
    appliesTo: 'class',
    frequency: figures.frequency ?? 'monthly',
    instalments: figures.instalments ?? 12,
    instalmentsDue: 6,
    ...(figures.oldestDueOn === undefined ? {} : { oldestDueOn: figures.oldestDueOn }),
    chargedYearPaise: figures.charged ?? 0,
    concessionYearPaise: 0,
    adjustmentPaise: 0,
    dueToDatePaise: figures.balance,
    paidPaise: 0,
    balancePaise: figures.balance,
    yearBalancePaise: figures.balance,
  }
}

/** Tuition is monthly and a month behind; the lab (quarterly) and the exam fee fell due on the same day; a fine is owed; the library is paid. */
const LINES: FeeStatementLine[] = [
  line('head-tuition', 'Tuition fee', { balance: 440_000, oldestDueOn: '2026-08-01', charged: 2_640_000 }),
  line('head-lab', 'Science lab fee', { balance: 90_000, oldestDueOn: '2026-07-01', charged: 360_000, frequency: 'quarterly', instalments: 4 }),
  line('head-exam', 'Examination fee', { balance: 120_000, oldestDueOn: '2026-07-01', charged: 240_000, frequency: 'half_yearly', instalments: 2 }),
  line('head-late', 'Late fee', { balance: 10_000 }),
  line('head-library', 'Library fee', { balance: 0, charged: 80_000, frequency: 'yearly', instalments: 1 }),
]

type Receipt = FeeStatement['receipts'][number]

function receipt(id: string, number: string, amountPaise: number, receivedOn: string, state: Receipt['state'] = 'standing'): Receipt {
  return {
    id,
    receiptNumber: number,
    kind: 'payment',
    amountPaise,
    mode: 'cash',
    receivedOn,
    student: AARAV,
    academicYear: YEAR,
    state,
    allowedActions: [],
  }
}

function statementOf(student: FeeStudent, extra: Partial<FeeStatement> = {}): FeeStatement {
  const lines = extra.lines ?? LINES
  const sum = (key: keyof FeeStatementLine) => lines.reduce((total, row) => total + (row[key] as number), 0)
  return FeeStatement.parse({
    student,
    academicYear: YEAR,
    asOf: TODAY,
    lines,
    totals: {
      chargedYearPaise: sum('chargedYearPaise'),
      concessionYearPaise: 0,
      adjustmentPaise: 0,
      dueToDatePaise: sum('dueToDatePaise'),
      paidPaise: 0,
      balancePaise: sum('balancePaise'),
      yearBalancePaise: sum('yearBalancePaise'),
    },
    optIns: [],
    concessions: [],
    receipts: [],
    allowedActions: ['fees.read', 'fees.collect', 'fees.manage'],
    ...extra,
  })
}

const HEADS = FeeHeadList.parse([
  { id: 'head-bus', name: 'School bus', category: 'transport', appliesTo: 'opt_in', frequency: 'monthly', active: true, version: 1, allowedActions: [] },
  { id: 'head-music', name: 'Music club', category: 'activity', appliesTo: 'opt_in', frequency: 'half_yearly', active: true, version: 1, allowedActions: [] },
  { id: 'head-old-bus', name: 'Old bus route', category: 'transport', appliesTo: 'opt_in', frequency: 'monthly', active: false, version: 1, allowedActions: [] },
  { id: 'head-tuition', name: 'Tuition fee', category: 'tuition', appliesTo: 'class', frequency: 'monthly', active: true, version: 1, allowedActions: [] },
])

const YEARS = AcademicYearList.parse([
  { id: YEAR.id, schoolId: 'school-1', name: YEAR.name, startDate: '2026-04-01', endDate: '2027-03-31', status: 'current', version: 1, allowedActions: [] },
])

function structure(id: string, headId: string, headName: string, amountPaise: number, grade?: { id: string; name: string }) {
  return { id, academicYear: YEAR, head: { id: headId, name: headName }, ...(grade ? { grade } : {}), amountPaise, frequency: 'monthly', appliesTo: 'opt_in', version: 1, allowedActions: [] }
}

const STRUCTURES = FeeStructureList.parse([
  structure('s-bus-all', 'head-bus', 'School bus', 180_000),
  structure('s-bus-9', 'head-bus', 'School bus', 210_000, GRADE),
])

interface World {
  statements?: Readonly<Record<string, FeeStatement>>
  structures?: FeeStructure[]
}

/** A tool context answering the fee routes from fixed bodies, recording every GET. */
function contextFor(world: World = {}): ToolCallContext & { readonly asked: string[] } {
  const asked: string[] = []
  return {
    schoolId: 'school-1',
    today: TODAY,
    academicYearId: YEAR.id,
    asked,
    async get(path, query): Promise<RouteAnswer> {
      asked.push(path)
      const found = /^\/fees\/students\/([^/]+)\/statement$/.exec(path)
      if (found) {
        assert.equal(query?.academicYearId, YEAR.id, 'the statement is read with its year named')
        const statement = world.statements?.[decodeURIComponent(found[1]!)] ?? statementOf(REGISTER.find((row) => row.id === decodeURIComponent(found[1]!)) ?? AARAV)
        return { ok: true, status: 200, body: statement }
      }
      if (path === '/fees/dues') {
        assert.equal(query?.show, 'all')
        return { ok: true, status: 200, body: duesPage(query?.q === undefined ? undefined : String(query.q)) }
      }
      if (path === '/fees/heads') return { ok: true, status: 200, body: HEADS }
      if (path === '/academic-years') return { ok: true, status: 200, body: YEARS }
      if (path === '/fees/structures') return { ok: true, status: 200, body: world.structures ?? STRUCTURES }
      return { ok: false, status: 404, code: 'RESOURCE_NOT_FOUND' }
    },
  }
}

// ---------------------------------------------------------------------------
// Calling a tool.

function tool(name: string): AnyProposeTool {
  const found = proposeToolNamed(name)
  assert.ok(found, `no tool named ${name}`)
  return found
}

async function prepare(name: string, input: Record<string, unknown>, context = contextFor()): Promise<PrepareOutcome<AssistantProposalPreview>> {
  const definition = tool(name)
  const parsed = definition.input.parse(input)
  return (definition.prepare as (input: unknown, context: ToolCallContext) => Promise<PrepareOutcome<AssistantProposalPreview>>)(parsed, context)
}

function drafted<T extends AssistantProposalPreview>(outcome: PrepareOutcome<AssistantProposalPreview>, schema: { parse(value: unknown): T }): ProposalDraft<T> {
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome))
  if (outcome.status !== 'ok') throw new Error('unreachable')
  return { ...outcome.draft, preview: schema.parse(outcome.draft.preview) }
}

function problemOf(outcome: PrepareOutcome<AssistantProposalPreview>): string {
  assert.equal(outcome.status, 'invalid', JSON.stringify(outcome))
  if (outcome.status !== 'invalid') throw new Error('unreachable')
  return outcome.problem
}

const sameTarget = (name: string, original: AssistantProposalPreview, edited: AssistantProposalPreview) =>
  (tool(name).sameTarget as (a: AssistantProposalPreview, b: AssistantProposalPreview) => boolean)(original, edited)

function writeOf(name: string, preview: AssistantProposalPreview): WriteRequest | { readonly problem: string } {
  return (tool(name).write as (preview: AssistantProposalPreview) => WriteRequest | { readonly problem: string })(preview)
}

const describeDone = (name: string, preview: AssistantProposalPreview) => (tool(name).describeDone as (preview: AssistantProposalPreview) => string)(preview)

// ---------------------------------------------------------------------------
// The definitions and money.

test('the payment tool is offered to whoever may collect, the other two to whoever may manage fees; parents and pupils get none', () => {
  const names = (role: keyof typeof ROLE_TEMPLATES) =>
    proposeToolsFor(new Set<PermissionKey>(ROLE_TEMPLATES[role].grants.map((grant) => grant.permission)))
      .map((definition) => definition.name)
      .filter((name) => name.startsWith('propose_fee'))
  assert.equal(tool('propose_fee_payment').permission, 'fees.collect')
  assert.equal(tool('propose_fee_concession').permission, 'fees.manage')
  assert.equal(tool('propose_fee_opt_in').permission, 'fees.manage')
  assert.deepEqual(names('owner'), ['propose_fee_payment', 'propose_fee_concession', 'propose_fee_opt_in'])
  assert.deepEqual(names('accountant'), ['propose_fee_payment', 'propose_fee_concession', 'propose_fee_opt_in'])
  // The office counter takes money; it does not set fees.
  assert.deepEqual(names('admin'), ['propose_fee_payment'])
  for (const role of ['teacher', 'parent', 'student'] as const) assert.deepEqual(names(role), [], role)
})

test('money is shown as the Fees screen shows it, and rupees become whole paise', () => {
  assert.equal(rupeesLabel(1_200_000), '₹12,000')
  assert.equal(rupeesLabel(10_000_000), '₹1,00,000')
  assert.equal(rupeesLabel(125_050), '₹1,250.50')
  assert.equal(paiseOf(5000), 500_000)
  assert.equal(paiseOf(1250.5), 125_050)
  assert.equal(paiseOf(0.1 + 0.2), 30)
  assert.equal(paiseOf(12.345), null)
})

// ---------------------------------------------------------------------------
// Finding the pupil.

test('the pupil is found on the fee register by name or admission number, and only in English letters', async () => {
  const unknown = problemOf(await prepare('propose_fee_payment', { pupil: 'Zed Khan' }))
  assert.equal(unknown, 'No pupil on the fee register is called Zed Khan.')

  const several = problemOf(await prepare('propose_fee_payment', { pupil: 'Riya' }))
  assert.equal(several, 'More than one pupil on the fee register could be Riya: Riya Sharma, Class 9 A (SPS/0020) and Riya Patel, Class 9 A (SPS/0021). Say which one.')

  // The whole name matches nobody in the search box, so its first word is tried.
  const context = contextFor()
  const byName = drafted(await prepare('propose_fee_payment', { pupil: 'Riya Patel' }, context), FeePaymentPreview)
  assert.equal(byName.preview.studentId, RIYA_P.id)
  assert.deepEqual(context.asked.slice(0, 2), ['/fees/dues', '/fees/dues'])

  const byNumber = drafted(await prepare('propose_fee_payment', { pupil: 'sps/0012' }), FeePaymentPreview)
  assert.equal(byNumber.preview.studentId, AARAV.id)
  assert.equal(byNumber.preview.studentLabel, 'Aarav Shah, Class 9 A (SPS/0012)')

  const hindi = contextFor()
  assert.match(problemOf(await prepare('propose_fee_payment', { pupil: 'आरव शाह' }, hindi)), /in English letters/)
  assert.deepEqual(hindi.asked, [], 'nothing is looked up for a name in another script')
})

// ---------------------------------------------------------------------------
// A payment.

test('payment: what is due goes oldest first, ties by name and a fine last; the amount is split across it', async () => {
  const draft = drafted(await prepare('propose_fee_payment', { pupil: 'Aarav', amountRupees: 2500, mode: 'upi', reference: 'UPI1234' }), FeePaymentPreview)
  const { preview } = draft
  assert.equal(draft.title, 'Record a payment for Aarav Shah')
  assert.equal(draft.checkPath, `/fees/students/${AARAV.id}/statement?academicYearId=${YEAR.id}`)
  assert.equal(draft.href, `/fees/students/${AARAV.id}?academicYearId=${YEAR.id}`)
  // The quarterly lab fee and the half-yearly exam fee fell due on one day: by name. The paid-up library is not there.
  assert.deepEqual(
    preview.dues.map((due) => [due.name, due.oldestDueOn]),
    [
      ['Examination fee', '2026-07-01'],
      ['Science lab fee', '2026-07-01'],
      ['Tuition fee', '2026-08-01'],
      ['Late fee', null],
    ],
  )
  assert.equal(preview.receivedOn, TODAY)
  assert.deepEqual(preview.proposed, { amountPaise: 250_000, mode: 'upi', reference: 'UPI1234', payerName: null })
  assert.deepEqual(preview.paidToday, [])

  const request = writeOf('propose_fee_payment', preview) as WriteRequest
  assert.deepEqual(request, {
    method: 'POST',
    path: `/fees/students/${AARAV.id}/collect`,
    body: {
      academicYearId: YEAR.id,
      lines: [
        { feeHeadId: 'head-exam', amountPaise: 120_000 },
        { feeHeadId: 'head-lab', amountPaise: 90_000 },
        { feeHeadId: 'head-tuition', amountPaise: 40_000 },
      ],
      mode: 'upi',
      receivedOn: TODAY,
      reference: 'UPI1234',
    },
  })
  const forModel = draft.forModel as { summary: string; split: unknown; balanceBeforeRupees: number; balanceAfterRupees: number }
  assert.match(forModel.summary, /Nothing is saved until the person presses Confirm/)
  assert.deepEqual(forModel.split, [
    { fee: 'Examination fee', rupees: 1200 },
    { fee: 'Science lab fee', rupees: 900 },
    { fee: 'Tuition fee', rupees: 400 },
  ])
  assert.equal(forModel.balanceBeforeRupees, 6600)
  assert.equal(forModel.balanceAfterRupees, 4100)
})

test('payment: no amount takes everything due today; more than that, or nothing due, is refused', async () => {
  const whole = drafted(await prepare('propose_fee_payment', { pupil: 'Aarav' }), FeePaymentPreview)
  assert.equal(whole.preview.proposed.amountPaise, 660_000)
  assert.equal(whole.preview.proposed.mode, 'cash')

  assert.equal(
    problemOf(await prepare('propose_fee_payment', { pupil: 'Aarav', amountRupees: 7000 })),
    '₹7,000 is more than the ₹6,600 due today for Aarav Shah. To take fees ahead, use the Fees screen.',
  )
  assert.match(problemOf(await prepare('propose_fee_payment', { pupil: 'Aarav', amountRupees: 10.555 })), /two decimal places/)

  const paidUp = contextFor({ statements: { [AARAV.id]: statementOf(AARAV, { lines: [line('head-tuition', 'Tuition fee', { balance: -50_000, charged: 100_000 })] }) } })
  assert.equal(
    problemOf(await prepare('propose_fee_payment', { pupil: 'Aarav', amountRupees: 100 }, paidUp)),
    'Nothing is due today for Aarav Shah. To take fees ahead, use the Fees screen.',
  )
})

test('payment: a payment already recorded today is a warning on the card, a cancelled one is not', async () => {
  const receipts = [
    receipt('r-today', 'SPS/2026-27/R0101', 50_000, TODAY),
    receipt('r-bounced', 'SPS/2026-27/R0102', 70_000, TODAY, 'cancelled'),
    receipt('r-old', 'SPS/2026-27/R0050', 90_000, '2026-09-01'),
  ]
  const context = contextFor({ statements: { [AARAV.id]: statementOf(AARAV, { receipts }) } })
  const draft = drafted(await prepare('propose_fee_payment', { pupil: 'Aarav', amountRupees: 1000 }, context), FeePaymentPreview)
  assert.deepEqual(draft.preview.paidToday, [{ receiptNumber: 'SPS/2026-27/R0101', amountPaise: 50_000, mode: 'cash' }])
  const forModel = draft.forModel as { warning?: string }
  assert.equal(forModel.warning, 'A payment was already recorded for Aarav Shah today: SPS/2026-27/R0101 for ₹500. Check it is not the same money.')
})

test('payment: the card must add a reference for anything but cash, and an edited amount is split again or refused', async () => {
  const { preview } = drafted(await prepare('propose_fee_payment', { pupil: 'Aarav', amountRupees: 1000, mode: 'upi' }), FeePaymentPreview)
  assert.deepEqual(writeOf('propose_fee_payment', preview), { problem: 'Add the reference for this UPI payment.' })
  const cheque = { ...preview, proposed: { ...preview.proposed, mode: 'cheque' as const } }
  assert.deepEqual(writeOf('propose_fee_payment', cheque), { problem: 'Add the reference for this cheque payment.' })

  const edited: FeePaymentPreview = { ...preview, proposed: { ...preview.proposed, amountPaise: 300_000, reference: 'UPI99', payerName: 'Rakesh Shah' } }
  assert.equal(sameTarget('propose_fee_payment', preview, edited), true)
  const request = writeOf('propose_fee_payment', edited) as WriteRequest
  assert.deepEqual((request.body as { lines: unknown }).lines, [
    { feeHeadId: 'head-exam', amountPaise: 120_000 },
    { feeHeadId: 'head-lab', amountPaise: 90_000 },
    { feeHeadId: 'head-tuition', amountPaise: 90_000 },
  ])
  assert.equal((request.body as { payerName?: string }).payerName, 'Rakesh Shah')

  const tooMuch: FeePaymentPreview = { ...edited, proposed: { ...edited.proposed, amountPaise: 700_000 } }
  assert.deepEqual(writeOf('propose_fee_payment', tooMuch), { problem: '₹7,000 is more than the ₹6,600 due today.' })
})

test('payment: only the amount, method, reference and payer may change on the card', async () => {
  const { preview } = drafted(await prepare('propose_fee_payment', { pupil: 'Aarav', amountRupees: 1000 }), FeePaymentPreview)
  const name = 'propose_fee_payment'
  assert.equal(sameTarget(name, preview, { ...preview, studentId: RIYA_S.id }), false)
  assert.equal(sameTarget(name, preview, { ...preview, receivedOn: '2026-09-01' }), false)
  assert.equal(sameTarget(name, preview, { ...preview, dues: [...preview.dues].reverse() }), false)
  assert.equal(sameTarget(name, preview, { ...preview, dues: preview.dues.map((due) => ({ ...due, balancePaise: due.balancePaise + 100 })) }), false)
  assert.equal(sameTarget(name, preview, { ...preview, paidToday: [{ receiptNumber: 'X1', amountPaise: 100 }] }), false)
  assert.equal(sameTarget(name, preview, { ...preview, proposed: { ...preview.proposed, mode: 'bank_transfer', reference: 'NEFT1' } }), true)
})

test('payment: the done card names the amount and method only, and links to the receipt the write made', async () => {
  const { preview } = drafted(await prepare('propose_fee_payment', { pupil: 'Aarav', amountRupees: 1000, mode: 'upi', reference: 'UPI1', payerName: 'Rakesh Shah' }), FeePaymentPreview)
  const done = describeDone('propose_fee_payment', { ...preview, proposed: { ...preview.proposed, amountPaise: 1_200_000 } })
  assert.equal(done, 'Recorded ₹12,000 by UPI.')
  assert.doesNotMatch(done, /Aarav|Rakesh|SPS/)
  assert.equal(describeDone('propose_fee_payment', { ...preview, proposed: { ...preview.proposed, mode: 'bank_transfer' } }), 'Recorded ₹1,000 by bank transfer.')

  const answer = FeeReceiptDetail.parse({
    ...receipt('receipt-new', 'SPS/2026-27/R0200', 100_000, TODAY),
    lines: [{ head: { id: 'head-exam', name: 'Examination fee' }, amountPaise: 100_000 }],
    recordedAt: '2026-09-28T05:00:00.000Z',
    reversedBy: [],
  })
  const doneHref = tool('propose_fee_payment').doneHref as (answer: unknown) => string | undefined
  assert.equal(doneHref(answer), '/fees/receipts/receipt-new')
  assert.equal(doneHref({ nothing: true }), undefined)
  assert.equal(doneHref(null), undefined)
})

test("the check view keeps a statement's money and records, never the day, the names or the allowed actions", () => {
  const statement = statementOf(AARAV, { receipts: [receipt('r1', 'R1', 50_000, '2026-09-01')] })
  const view = feeStatementCheckView(statement)
  const renamed = { ...statement, asOf: '2026-09-29', allowedActions: [], student: { ...statement.student, name: 'Aarav S' }, lines: statement.lines.map((row) => ({ ...row, head: { ...row.head, name: `${row.head.name}!` } })) }
  assert.deepEqual(feeStatementCheckView(renamed), view)
  const paid = { ...statement, receipts: [...statement.receipts, receipt('r2', 'R2', 10_000, TODAY)] }
  assert.notDeepEqual(feeStatementCheckView(paid), view)
  const cancelled = { ...statement, receipts: [{ ...statement.receipts[0]!, state: 'cancelled' as const }] }
  assert.notDeepEqual(feeStatementCheckView(cancelled), view)
  const moved = { ...statement, lines: statement.lines.map((row, index) => (index === 0 ? { ...row, oldestDueOn: '2026-09-01' } : row)) }
  assert.notDeepEqual(feeStatementCheckView(moved), view)
  // Not a statement: the whole answer.
  assert.deepEqual(feeStatementCheckView({ other: 1 }), { other: 1 })
})

// ---------------------------------------------------------------------------
// A concession.

test('concession: a percentage on one fee named as people say it, with a reason the card requires', async () => {
  const draft = drafted(await prepare('propose_fee_concession', { pupil: 'Aarav', fee: 'tuition', percent: 25, category: 'sibling' }), FeeConcessionPreview)
  const { preview } = draft
  assert.equal(draft.title, 'Concession for Aarav Shah')
  assert.deepEqual(preview.head, { id: 'head-tuition', name: 'Tuition fee' })
  assert.deepEqual(preview.fees, [{ feeHeadId: 'head-tuition', name: 'Tuition fee', chargedYearPaise: 2_640_000, instalments: 12 }])
  assert.deepEqual(preview.proposed, { category: 'sibling', kind: 'percent', percentBp: 2500, amountPaise: null })
  assert.equal((draft.forModel as { needsReason: boolean }).needsReason, true)

  assert.deepEqual(writeOf('propose_fee_concession', preview), { problem: 'Add a reason for the concession.' })
  const reasoned: FeeConcessionPreview = { ...preview, reason: 'Younger sibling joined' }
  assert.equal(sameTarget('propose_fee_concession', preview, reasoned), true)
  assert.deepEqual(writeOf('propose_fee_concession', reasoned), {
    method: 'POST',
    path: `/fees/students/${AARAV.id}/concessions`,
    body: { academicYearId: YEAR.id, feeHeadId: 'head-tuition', category: 'sibling', kind: 'percent', percentBp: 2500, reason: 'Younger sibling joined' },
  })
  const done = describeDone('propose_fee_concession', reasoned)
  assert.equal(done, 'Applied a 25% concession on Tuition fee.')
  assert.doesNotMatch(done, /Aarav|sibling joined/)
  assert.equal(sameTarget('propose_fee_concession', preview, { ...preview, head: null }), false)
  assert.equal(sameTarget('propose_fee_concession', preview, { ...preview, studentId: RIYA_P.id }), false)
})

test('concession: every fee takes a percentage only; a fixed amount is off each instalment of one fee', async () => {
  const every = drafted(await prepare('propose_fee_concession', { pupil: 'Aarav', fee: 'every fee', percent: 12.5, reason: 'Scholarship award' }), FeeConcessionPreview)
  assert.equal(every.preview.head, null)
  // Every fee charged this year; the fine charges nothing, so it is left out.
  assert.deepEqual(every.preview.fees.map((fee) => fee.name), ['Tuition fee', 'Science lab fee', 'Examination fee', 'Library fee'])
  assert.equal(every.preview.proposed.category, 'other')
  const request = writeOf('propose_fee_concession', every.preview) as WriteRequest
  assert.equal((request.body as { feeHeadId?: string }).feeHeadId, undefined)
  assert.equal(describeDone('propose_fee_concession', every.preview), 'Applied a 12.5% concession on every fee.')

  assert.equal(
    problemOf(await prepare('propose_fee_concession', { pupil: 'Aarav', amountRupees: 500 })),
    'A fixed amount needs one fee; choose a percentage for every fee.',
  )
  assert.match(problemOf(await prepare('propose_fee_concession', { pupil: 'Aarav', fee: 'tuition' })), /as a percentage, or as an amount/)
  assert.match(problemOf(await prepare('propose_fee_concession', { pupil: 'Aarav', fee: 'tuition', percent: 10, amountRupees: 500 })), /as a percentage, or as an amount/)

  const amount = drafted(await prepare('propose_fee_concession', { pupil: 'Aarav', fee: 'Lab', amountRupees: 500, category: 'hardship', reason: 'Family hardship' }), FeeConcessionPreview)
  assert.deepEqual(amount.preview.proposed, { category: 'hardship', kind: 'amount', percentBp: null, amountPaise: 50_000 })
  assert.equal(describeDone('propose_fee_concession', amount.preview), 'Applied ₹500 off each Science lab fee instalment.')
  // A card switched to an amount with no amount, or an amount on every fee, is refused.
  assert.deepEqual(writeOf('propose_fee_concession', { ...amount.preview, proposed: { ...amount.preview.proposed, amountPaise: null } }), { problem: 'Add the amount off each instalment.' })
  assert.deepEqual(
    writeOf('propose_fee_concession', { ...every.preview, proposed: { ...every.preview.proposed, kind: 'amount', percentBp: null, amountPaise: 10_000 } }),
    { problem: 'A fixed amount needs one fee; choose a percentage for every fee.' },
  )

  assert.equal(
    problemOf(await prepare('propose_fee_concession', { pupil: 'Aarav', fee: 'Swimming', percent: 10 })),
    "There is no fee called Swimming on Aarav Shah's statement. They are Tuition fee, Science lab fee, Examination fee, Late fee and Library fee.",
  )
})

// ---------------------------------------------------------------------------
// An optional fee.

test('opt-in: an optional fee from a day, at the class amount, with its own amount or none', async () => {
  const draft = drafted(await prepare('propose_fee_opt_in', { pupil: 'Aarav', fee: 'bus', startsOn: '2026-10-01' }), FeeOptInPreview)
  const { preview } = draft
  assert.equal(draft.title, 'Add School bus for Aarav Shah')
  assert.deepEqual(preview.head, { id: 'head-bus', name: 'School bus' })
  assert.equal(preview.frequency, 'monthly')
  // The row for the pupil's own class wins over the row for every class.
  assert.equal(preview.structureAmountPaise, 210_000)
  assert.equal(preview.yearStartsOn, '2026-04-01')
  assert.deepEqual(preview.proposed, { amountPaise: null, startsOn: '2026-10-01', endsOn: null })
  assert.deepEqual(writeOf('propose_fee_opt_in', preview), {
    method: 'POST',
    path: `/fees/students/${AARAV.id}/opt-ins`,
    body: { academicYearId: YEAR.id, feeHeadId: 'head-bus', startsOn: '2026-10-01' },
  })
  assert.equal(describeDone('propose_fee_opt_in', preview), 'Added School bus from 1 Oct 2026.')

  // Today when no day is said.
  assert.equal(drafted(await prepare('propose_fee_opt_in', { pupil: 'Aarav', fee: 'School bus' }), FeeOptInPreview).preview.proposed.startsOn, TODAY)

  assert.equal(structureAmountFor(STRUCTURES, 'head-bus', 'grade-other'), 180_000)
  assert.equal(structureAmountFor(STRUCTURES, 'head-music', GRADE.id), null)
  const noAmount = drafted(await prepare('propose_fee_opt_in', { pupil: 'Aarav', fee: 'music' }), FeeOptInPreview)
  assert.equal(noAmount.preview.structureAmountPaise, null)
  assert.deepEqual(writeOf('propose_fee_opt_in', noAmount.preview), { problem: 'Add the amount per instalment: the class has none.' })
  const own = { ...noAmount.preview, proposed: { ...noAmount.preview.proposed, amountPaise: 300_000 } }
  assert.equal(sameTarget('propose_fee_opt_in', noAmount.preview, own), true)
  assert.equal((writeOf('propose_fee_opt_in', own) as WriteRequest).method, 'POST')
  assert.equal(sameTarget('propose_fee_opt_in', noAmount.preview, { ...own, structureAmountPaise: 1 }), false)
})

test('opt-in: a fee the pupil takes already, one that is not optional, and dates outside the year are refused', async () => {
  const taking = statementOf(AARAV, { optIns: [{ id: 'opt-1', head: { id: 'head-bus', name: 'School bus' }, startsOn: '2026-04-01', version: 1 }] })
  assert.equal(
    problemOf(await prepare('propose_fee_opt_in', { pupil: 'Aarav', fee: 'bus' }, contextFor({ statements: { [AARAV.id]: taking } }))),
    'Aarav Shah already takes School bus from 1 Apr 2026. Change it on the Fees screen.',
  )
  // Tuition is charged to the class and a retired fee is not offered.
  assert.equal(
    problemOf(await prepare('propose_fee_opt_in', { pupil: 'Aarav', fee: 'Tuition' })),
    'There is no fee called Tuition among the optional fees. They are School bus and Music club.',
  )
  assert.equal(
    problemOf(await prepare('propose_fee_opt_in', { pupil: 'Aarav', fee: 'bus', startsOn: '2027-05-01' })),
    'The start must be inside the year, 1 Apr 2026 to 31 Mar 2027.',
  )
  assert.equal(problemOf(await prepare('propose_fee_opt_in', { pupil: 'Aarav', fee: 'bus', startsOn: '2026-10-01', endsOn: '2026-09-01' })), 'The end date is before the start date.')

  const { preview } = drafted(await prepare('propose_fee_opt_in', { pupil: 'Aarav', fee: 'bus', startsOn: '2026-10-01' }), FeeOptInPreview)
  assert.deepEqual(writeOf('propose_fee_opt_in', { ...preview, proposed: { ...preview.proposed, startsOn: '2026-03-01' } }), {
    problem: 'The start must be inside the year, 1 Apr 2026 to 31 Mar 2027.',
  })
})
