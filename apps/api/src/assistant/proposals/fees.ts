import { z } from 'zod'
import {
  AcademicYearList,
  FEE_MAX_PAISE,
  FeeConcessionCategory,
  FeeConcessionPreview,
  FeeDuesPage,
  FeeHeadList,
  FeeOptInPreview,
  FeePaymentMode,
  FeePaymentPreview,
  FeeReceiptDetail,
  FeeStatement,
  FeeStructureList,
  oldestDueFirst,
  splitFeePayment,
  type FeeCollectRequest,
  type FeeConcessionCreateRequest,
  type FeeDuesRow,
  type FeeOptInCreateRequest,
  type FeePaymentDue,
  type FeeStructure,
} from '@erp/contracts'
import type { ToolCallContext } from '../tools/types.ts'
import { appPath, className, clip, dateLabel, fetchParsed, inEnglishLetters, notInEnglishLetters, seg } from '../tools/present.ts'
import { proposeTool, type PrepareOutcome } from './types.ts'
import { invalid, listed, matchPerson, sameJson, typedReason, without } from './match.ts'

/**
 * Fees through the assistant (24d): recording a payment, giving a concession
 * and adding an optional fee such as transport, each for one pupil.
 *
 * The pupil is found through the dues list's own search, the lookup the Fees
 * screen uses, so it is scoped by the same fee plans (an accountant holds no
 * enrolment key, so the pupil search is not theirs to use). Everything else is
 * read from the pupil's statement, which is also the check route. Refunds,
 * cancelling a receipt, adjustments, removing a concession and the school's
 * fee setup stay on the Fees screen. See docs/assistant/ARCHITECTURE.md
 * section 5, "Fees (24d)".
 */

// ---------------------------------------------------------------------------
// Money and words.

/** "₹12,000", or "₹1,250.50" when there are paise, as the Fees screen shows money. */
export function rupeesLabel(paise: number): string {
  const sign = paise < 0 ? '-' : ''
  const whole = Math.abs(Math.trunc(paise))
  const rest = whole % 100
  const base = `₹${new Intl.NumberFormat('en-IN').format(Math.floor(whole / 100))}`
  return `${sign}${base}${rest === 0 ? '' : `.${String(rest).padStart(2, '0')}`}`
}

/** Rupees as the model said them, as whole paise; null when there is more than paise in it. */
export function paiseOf(rupees: number): number | null {
  const paise = Math.round(rupees * 100)
  return Math.abs(rupees * 100 - paise) < 1e-6 && paise > 0 && paise <= FEE_MAX_PAISE ? paise : null
}

const MODE_WORDS: Readonly<Record<FeePaymentMode, string>> = {
  cash: 'cash',
  cheque: 'cheque',
  upi: 'UPI',
  bank_transfer: 'bank transfer',
  demand_draft: 'demand draft',
}

/** "25%", "12.5%", from basis points. */
function percentLabel(basisPoints: number): string {
  return `${basisPoints / 100}%`
}

const PUPIL = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .describe("The pupil's name or admission number, in English letters, as the school writes it.")

const RUPEES = z.number().positive().max(FEE_MAX_PAISE / 100)

/** "All", "every fee", "all fees": a percentage off everything. */
const EVERY_FEE = /^(all|every|everything|all fees|every fee|all the fees|each fee|whole fee|total fee|total fees)$/i

// ---------------------------------------------------------------------------
// The pupil and their statement.

/** "Aarav Shah, Class 9 A (SPS/0012)". */
function pupilLabel(student: FeeDuesRow['student']): string {
  const where = className(student.grade, student.section)
  return clip(where ? `${student.name}, ${where} (${student.admissionNumber})` : `${student.name} (${student.admissionNumber})`, 200)
}

interface FoundPupil {
  readonly student: FeeDuesRow['student']
  readonly label: string
  readonly academicYearId: string
  readonly academicYearName: string
}

type PupilFound = { readonly ok: true; readonly found: FoundPupil } | { readonly ok: false; readonly outcome: PrepareOutcome<never> }

/**
 * One pupil on the fee register of the current year, by name or admission
 * number, through the dues list's search. The search takes a name or its
 * first word, as a person types it into the screen's box.
 */
async function findFeePupil(context: ToolCallContext, said: string): Promise<PupilFound> {
  const trimmed = said.trim()
  if (notInEnglishLetters(trimmed)) return { ok: false, outcome: invalid(inEnglishLetters(trimmed)) }
  let page: FeeDuesPage | null = null
  for (const term of [...new Set([trimmed, trimmed.split(/\s+/)[0]!])]) {
    const searched = await fetchParsed(context, FeeDuesPage, '/fees/dues', { show: 'all', q: term, page: 1, pageSize: 50 })
    if (!searched.ok) return { ok: false, outcome: searched.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' } }
    page = searched.body
    if (page.items.length > 0) break
  }
  if (page === null) return { ok: false, outcome: { status: 'failed' } }
  const candidates = page.items.map((row) => ({ item: row, name: row.student.name, code: row.student.admissionNumber, label: pupilLabel(row.student) }))
  const match = matchPerson(trimmed, candidates)
  if (match.status === 'none') return { ok: false, outcome: invalid(`No pupil on the fee register is called ${trimmed}.`) }
  if (match.status === 'many') {
    return { ok: false, outcome: invalid(`More than one pupil on the fee register could be ${trimmed}: ${listed(match.names)}. Say which one.`) }
  }
  const student = match.item.student
  return {
    ok: true,
    found: { student, label: pupilLabel(student), academicYearId: page.academicYear.id, academicYearName: clip(page.academicYear.name, 60) },
  }
}

type StatementRead =
  | { readonly ok: true; readonly statement: FeeStatement; readonly checkPath: string; readonly href: string }
  | { readonly ok: false; readonly outcome: PrepareOutcome<never> }

/** The pupil's statement for the year, read once with the year named, exactly as the check route reads it again. */
async function readStatement(context: ToolCallContext, pupil: FoundPupil): Promise<StatementRead> {
  const path = `/fees/students/${seg(pupil.student.id)}/statement`
  const read = await fetchParsed(context, FeeStatement, path, { academicYearId: pupil.academicYearId })
  if (!read.ok) return { ok: false, outcome: read.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' } }
  return {
    ok: true,
    statement: read.body,
    checkPath: appPath(path, { academicYearId: pupil.academicYearId }),
    href: appPath(`/fees/students/${seg(pupil.student.id)}`, { academicYearId: pupil.academicYearId }),
  }
}

/**
 * The part of a statement a fee change depends on: each fee's figures and
 * oldest due date, the receipts and their state, the optional fees and the
 * concessions with their versions. The day it was read, the names and the
 * allowed actions are left out, so a statement read again on Confirm is the
 * same unless the money or the fees moved.
 */
export function feeStatementCheckView(body: unknown): unknown {
  const parsed = FeeStatement.safeParse(body)
  if (!parsed.success) return body
  const statement = parsed.data
  return {
    studentId: statement.student.id,
    academicYearId: statement.academicYear.id,
    lines: statement.lines.map((line) => ({
      feeHeadId: line.head.id,
      dueToDatePaise: line.dueToDatePaise,
      paidPaise: line.paidPaise,
      balancePaise: line.balancePaise,
      yearBalancePaise: line.yearBalancePaise,
      oldestDueOn: line.oldestDueOn ?? null,
    })),
    receipts: statement.receipts.map((receipt) => ({ id: receipt.id, kind: receipt.kind, state: receipt.state ?? null, amountPaise: receipt.amountPaise })),
    optIns: statement.optIns.map((optIn) => ({ id: optIn.id, version: optIn.version })),
    concessions: statement.concessions.map((concession) => ({ id: concession.id, version: concession.version })),
  }
}

/** The pupil and year every fee preview carries. */
function feePupilOf(pupil: FoundPupil, statement: FeeStatement) {
  return {
    studentId: statement.student.id,
    studentLabel: pupil.label,
    academicYearId: statement.academicYear.id,
    academicYearName: clip(statement.academicYear.name, 60),
  }
}

/** What is due today, fee by fee, in the order a payment goes to it: oldest due first. */
export function duesOf(statement: FeeStatement): FeePaymentDue[] {
  return oldestDueFirst(
    statement.lines
      .filter((line) => line.balancePaise > 0)
      .map((line) => ({ feeHeadId: line.head.id, name: clip(line.head.name, 80), balancePaise: line.balancePaise, oldestDueOn: line.oldestDueOn ?? null })),
  ).slice(0, 30)
}

/** How a payment of this much goes across what is due, as the model reads it. */
function splitForModel(amountPaise: number, dues: readonly FeePaymentDue[]) {
  const names = new Map(dues.map((due) => [due.feeHeadId, due.name]))
  return (splitFeePayment(amountPaise, dues) ?? []).map((line) => ({ fee: names.get(line.feeHeadId) ?? 'fee', rupees: line.amountPaise / 100 }))
}

function sumOf(dues: readonly FeePaymentDue[]): number {
  return dues.reduce((sum, due) => sum + due.balancePaise, 0)
}

// ---------------------------------------------------------------------------
// A payment.

const PaymentInput = z.object({
  pupil: PUPIL,
  amountRupees: RUPEES.optional().describe('How much was paid, in rupees, as the person said it. Leave out to take everything due today.'),
  mode: FeePaymentMode.optional().describe('How it was paid: cash, cheque, upi, bank_transfer or demand_draft. Leave out for cash.'),
  reference: z.string().trim().min(1).max(80).optional().describe('The cheque number, UPI transaction id or bank reference, if the person gave one.'),
  payerName: z.string().trim().min(1).max(120).optional().describe('Who paid, in English letters, only if the person said.'),
})
type PaymentInput = z.infer<typeof PaymentInput>

export const proposeFeePayment = proposeTool<PaymentInput, FeePaymentPreview>({
  name: 'propose_fee_payment',
  description:
    "Proposes recording a fee payment for one pupil, dated today: the amount is split across what is due, oldest due first. Only what is due today can be paid here. Nothing is saved: the person checks the card and presses Confirm.",
  kind: 'fee_payment',
  permission: 'fees.collect',
  input: PaymentInput,
  preview: FeePaymentPreview,
  async prepare(input, context) {
    if (input.payerName !== undefined && notInEnglishLetters(input.payerName)) return invalid(inEnglishLetters(input.payerName, "the payer's name"))
    const asked = input.amountRupees === undefined ? undefined : paiseOf(input.amountRupees)
    if (asked === null) return invalid('An amount can have at most two decimal places.')
    const pupil = await findFeePupil(context, input.pupil)
    if (!pupil.ok) return pupil.outcome
    const read = await readStatement(context, pupil.found)
    if (!read.ok) return read.outcome
    const { statement } = read
    const name = statement.student.name

    const dues = duesOf(statement)
    if (dues.length === 0) return invalid(`Nothing is due today for ${name}. To take fees ahead, use the Fees screen.`)
    const dueToday = sumOf(dues)
    const amountPaise = asked ?? dueToday
    if (amountPaise > dueToday) {
      return invalid(`${rupeesLabel(amountPaise)} is more than the ${rupeesLabel(dueToday)} due today for ${name}. To take fees ahead, use the Fees screen.`)
    }
    const mode = input.mode ?? 'cash'
    const paidToday = statement.receipts
      .filter((receipt) => receipt.kind === 'payment' && receipt.receivedOn === statement.asOf && receipt.state !== 'cancelled')
      .slice(0, 20)
      .map((receipt) => ({ receiptNumber: receipt.receiptNumber, amountPaise: receipt.amountPaise, ...(receipt.mode === undefined ? {} : { mode: receipt.mode }) }))

    const preview: FeePaymentPreview = {
      kind: 'fee_payment',
      ...feePupilOf(pupil.found, statement),
      receivedOn: statement.asOf,
      dues,
      balancePaise: statement.totals.balancePaise,
      paidToday,
      proposed: { amountPaise, mode, reference: input.reference ?? null, payerName: input.payerName ?? null },
    }
    const needsReference = mode !== 'cash' && preview.proposed.reference === null
    return {
      status: 'ok',
      draft: {
        kind: 'fee_payment',
        title: clip(`Record a payment for ${name}`, 200),
        preview,
        checkPath: read.checkPath,
        forModel: {
          summary: `Recording ${rupeesLabel(amountPaise)} by ${MODE_WORDS[mode]} for ${pupil.found.label}, split oldest due first. Nothing is saved until the person presses Confirm.`,
          split: splitForModel(amountPaise, dues),
          dueTodayRupees: dueToday / 100,
          balanceBeforeRupees: statement.totals.balancePaise / 100,
          balanceAfterRupees: (statement.totals.balancePaise - amountPaise) / 100,
          ...(paidToday.length === 0
            ? {}
            : {
                warning: `A payment was already recorded for ${name} today: ${listed(paidToday.map((row) => `${row.receiptNumber} for ${rupeesLabel(row.amountPaise)}`))}. Check it is not the same money.`,
              }),
          ...(needsReference ? { needsReference: `The card needs the ${MODE_WORDS[mode]} reference before Confirm.` } : {}),
        },
        href: read.href,
      },
    }
  },
  // Only the amount, the method, the reference and who paid are the card's to change.
  sameTarget: (original, edited) => sameJson(without(original, ['proposed']), without(edited, ['proposed'])),
  write(preview) {
    const { amountPaise, mode, reference, payerName } = preview.proposed
    const split = splitFeePayment(amountPaise, preview.dues)
    if (split === null || split.length === 0) {
      return { problem: `${rupeesLabel(amountPaise)} is more than the ${rupeesLabel(sumOf(preview.dues))} due today.` }
    }
    if (mode !== 'cash' && reference === null) return { problem: `Add the reference for this ${MODE_WORDS[mode]} payment.` }
    const body: FeeCollectRequest = {
      academicYearId: preview.academicYearId,
      lines: split,
      mode,
      receivedOn: preview.receivedOn,
      ...(reference === null ? {} : { reference }),
      ...(payerName === null ? {} : { payerName }),
    }
    return { method: 'POST', path: `/fees/students/${seg(preview.studentId)}/collect`, body }
  },
  // A plain column: no pupil, no payer, no receipt number.
  describeDone: (preview) => `Recorded ${rupeesLabel(preview.proposed.amountPaise)} by ${MODE_WORDS[preview.proposed.mode]}.`,
  checkView: feeStatementCheckView,
  doneHref(answer) {
    const receipt = FeeReceiptDetail.safeParse(answer)
    return receipt.success ? `/fees/receipts/${seg(receipt.data.id)}` : undefined
  },
})

// ---------------------------------------------------------------------------
// A concession.

const ConcessionInput = z.object({
  pupil: PUPIL,
  fee: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe('Which fee it comes off, by its name on the pupil\'s statement, such as "Tuition". Leave out, or say "every fee", for a percentage off every fee.'),
  percent: z.number().gt(0).max(100).optional().describe('A percentage off, such as 25. Give this or amountRupees.'),
  amountRupees: RUPEES.optional().describe('A fixed amount off each instalment of one fee, in rupees. Give this or percent.'),
  category: FeeConcessionCategory.optional().describe('sibling, staff_child, scholarship, hardship or other. Leave out unless the person said.'),
  reason: z.string().trim().min(3).max(500).optional().describe('Why it is given, only if the person said. The card asks for it otherwise.'),
})
type ConcessionInput = z.infer<typeof ConcessionInput>

/** The fee a person named among the pupil's statement lines. */
function matchFee<T>(said: string, items: readonly { item: T; name: string }[], where: string, all: readonly string[]):
  | { readonly ok: true; readonly item: T }
  | { readonly ok: false; readonly outcome: PrepareOutcome<never> } {
  if (notInEnglishLetters(said)) return { ok: false, outcome: invalid(inEnglishLetters(said, "the fee's name")) }
  const match = matchPerson(said, items)
  if (match.status === 'one') return { ok: true, item: match.item }
  if (match.status === 'many') return { ok: false, outcome: invalid(`More than one fee could be ${said}: ${listed(match.names)}. Say which one.`) }
  return {
    ok: false,
    outcome: invalid(all.length === 0 ? `There is no fee called ${said} ${where}.` : `There is no fee called ${said} ${where}. They are ${listed(all, 12)}.`),
  }
}

export const proposeFeeConcession = proposeTool<ConcessionInput, FeeConcessionPreview>({
  name: 'propose_fee_concession',
  description:
    "Proposes a concession for one pupil this year: a percentage off one fee or every fee, or a fixed amount off each instalment of one fee. The card asks for the reason; nothing is saved until the person presses Confirm.",
  kind: 'fee_concession',
  permission: 'fees.manage',
  input: ConcessionInput,
  preview: FeeConcessionPreview,
  async prepare(input, context) {
    if ((input.percent === undefined) === (input.amountRupees === undefined)) {
      return invalid('Say the concession as a percentage, or as an amount off each instalment of one fee.')
    }
    const percentBp = input.percent === undefined ? null : Math.round(input.percent * 100)
    if (input.percent !== undefined && Math.abs(input.percent * 100 - (percentBp ?? 0)) > 1e-6) return invalid('A percentage can have at most two decimal places.')
    const amountPaise = input.amountRupees === undefined ? null : paiseOf(input.amountRupees)
    if (input.amountRupees !== undefined && amountPaise === null) return invalid('An amount can have at most two decimal places.')
    const everyFee = input.fee === undefined || EVERY_FEE.test(input.fee.trim())
    if (everyFee && amountPaise !== null) return invalid('A fixed amount needs one fee; choose a percentage for every fee.')

    const pupil = await findFeePupil(context, input.pupil)
    if (!pupil.ok) return pupil.outcome
    const read = await readStatement(context, pupil.found)
    if (!read.ok) return read.outcome
    const { statement } = read
    const name = statement.student.name

    let head: { id: string; name: string } | null = null
    if (!everyFee) {
      const found = matchFee(
        input.fee!,
        statement.lines.map((line) => ({ item: line, name: line.head.name })),
        `on ${name}'s statement`,
        statement.lines.map((line) => line.head.name),
      )
      if (!found.ok) return found.outcome
      head = { id: found.item.head.id, name: clip(found.item.head.name, 80) }
    }
    const fees = statement.lines
      .filter((line) => (head === null ? line.chargedYearPaise > 0 : line.head.id === head.id))
      .slice(0, 30)
      .map((line) => ({ feeHeadId: line.head.id, name: clip(line.head.name, 80), chargedYearPaise: line.chargedYearPaise, instalments: line.instalments }))
    const existing = statement.concessions.slice(0, 100).map((concession) => ({
      headName: concession.head === undefined ? null : clip(concession.head.name, 80),
      category: concession.category,
      kind: concession.kind,
      percentBp: concession.percentBp ?? null,
      amountPaise: concession.amountPaise ?? null,
    }))
    const category = input.category ?? 'other'
    const reason = typedReason(input.reason)
    const preview: FeeConcessionPreview = {
      kind: 'fee_concession',
      ...feePupilOf(pupil.found, statement),
      head,
      fees,
      existing,
      proposed: { category, kind: percentBp === null ? 'amount' : 'percent', percentBp, amountPaise },
      ...(reason === undefined ? {} : { reason }),
    }
    const what = percentBp !== null ? `A ${percentLabel(percentBp)} ${category.replace('_', ' ')} concession` : `${rupeesLabel(amountPaise!)} off each instalment`
    return {
      status: 'ok',
      draft: {
        kind: 'fee_concession',
        title: clip(`Concession for ${name}`, 200),
        preview,
        checkPath: read.checkPath,
        forModel: {
          summary: `${what} on ${head === null ? 'every fee' : head.name} for ${pupil.found.label}. Nothing is saved until the person presses Confirm.`,
          ...(existing.length === 0
            ? {}
            : { existing: existing.map((row) => `${row.percentBp !== null ? percentLabel(row.percentBp) : rupeesLabel(row.amountPaise ?? 0)} on ${row.headName ?? 'every fee'} (${row.category})`) }),
          needsReason: reason === undefined,
        },
        href: read.href,
      },
    }
  },
  sameTarget: (original, edited) => sameJson(without(original, ['proposed', 'reason']), without(edited, ['proposed', 'reason'])),
  write(preview) {
    const reason = typedReason(preview.reason)
    if (reason === undefined) return { problem: 'Add a reason for the concession.' }
    const { category, kind, percentBp, amountPaise } = preview.proposed
    if (kind === 'percent' && (percentBp === null || amountPaise !== null)) return { problem: 'Add the percentage off.' }
    if (kind === 'amount' && (amountPaise === null || percentBp !== null)) return { problem: 'Add the amount off each instalment.' }
    if (kind === 'amount' && preview.head === null) return { problem: 'A fixed amount needs one fee; choose a percentage for every fee.' }
    const body: FeeConcessionCreateRequest = {
      academicYearId: preview.academicYearId,
      ...(preview.head === null ? {} : { feeHeadId: preview.head.id }),
      category,
      kind,
      ...(kind === 'percent' ? { percentBp: percentBp! } : { amountPaise: amountPaise! }),
      reason,
    }
    return { method: 'POST', path: `/fees/students/${seg(preview.studentId)}/concessions`, body }
  },
  describeDone(preview) {
    const { kind, percentBp, amountPaise } = preview.proposed
    if (kind === 'amount') return `Applied ${rupeesLabel(amountPaise ?? 0)} off each ${preview.head?.name ?? 'fee'} instalment.`
    return `Applied a ${percentLabel(percentBp ?? 0)} concession on ${preview.head === null ? 'every fee' : preview.head.name}.`
  },
  checkView: feeStatementCheckView,
})

// ---------------------------------------------------------------------------
// An optional fee.

const OptInInput = z.object({
  pupil: PUPIL,
  fee: z.string().trim().min(1).max(80).describe('The optional fee, by its name, such as "Transport" or "School bus".'),
  startsOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('The first day it is charged from, YYYY-MM-DD. Leave out for today.'),
  endsOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('The last day, YYYY-MM-DD, only if the person said.'),
  amountRupees: RUPEES.optional().describe("The pupil's own amount per instalment, in rupees, only if the person said. Leave out for the class's amount."),
})
type OptInInput = z.infer<typeof OptInInput>

/** A real calendar day. */
function isDay(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** Why the dates on an optional fee cannot be written, or null. */
function optInDateProblem(startsOn: string, endsOn: string | null, yearStartsOn: string, yearEndsOn: string): string | null {
  if (!isDay(startsOn)) return `${startsOn} is not a date.`
  if (endsOn !== null && !isDay(endsOn)) return `${endsOn} is not a date.`
  if (startsOn < yearStartsOn || startsOn > yearEndsOn) {
    return `The start must be inside the year, ${dateLabel(yearStartsOn)} to ${dateLabel(yearEndsOn)}.`
  }
  if (endsOn !== null && endsOn < startsOn) return 'The end date is before the start date.'
  return null
}

/** What the pupil's class is charged per instalment for a fee: its own row, else the row for every class. */
export function structureAmountFor(structures: readonly FeeStructure[], headId: string, gradeId: string | undefined): number | null {
  const rows = structures.filter((row) => row.head.id === headId)
  const own = gradeId === undefined ? undefined : rows.find((row) => row.grade?.id === gradeId)
  return (own ?? rows.find((row) => row.grade === undefined))?.amountPaise ?? null
}

export const proposeFeeOptIn = proposeTool<OptInInput, FeeOptInPreview>({
  name: 'propose_fee_opt_in',
  description:
    'Proposes adding an optional fee, such as transport or the school bus, for one pupil this year, from a start date. Nothing is saved: the person checks the card and presses Confirm.',
  kind: 'fee_opt_in',
  permission: 'fees.manage',
  input: OptInInput,
  preview: FeeOptInPreview,
  async prepare(input, context) {
    const amountPaise = input.amountRupees === undefined ? null : paiseOf(input.amountRupees)
    if (input.amountRupees !== undefined && amountPaise === null) return invalid('An amount can have at most two decimal places.')
    if (notInEnglishLetters(input.fee)) return invalid(inEnglishLetters(input.fee, "the fee's name"))
    const pupil = await findFeePupil(context, input.pupil)
    if (!pupil.ok) return pupil.outcome
    const read = await readStatement(context, pupil.found)
    if (!read.ok) return read.outcome
    const { statement } = read
    const name = statement.student.name

    const heads = await fetchParsed(context, FeeHeadList, '/fees/heads')
    if (!heads.ok) return heads.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' }
    const optional = heads.body.filter((head) => head.appliesTo === 'opt_in' && head.active)
    if (optional.length === 0) return invalid('The school has no optional fees. They are set up on the Fees screen.')
    const found = matchFee(
      input.fee,
      optional.map((head) => ({ item: head, name: head.name })),
      'among the optional fees',
      optional.map((head) => head.name),
    )
    if (!found.ok) return found.outcome
    const head = found.item
    const taken = statement.optIns.find((optIn) => optIn.head.id === head.id)
    if (taken) return invalid(`${name} already takes ${head.name} from ${dateLabel(taken.startsOn)}. Change it on the Fees screen.`)

    const years = await fetchParsed(context, AcademicYearList, '/academic-years')
    if (!years.ok) return years.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' }
    const year = years.body.find((row) => row.id === statement.academicYear.id)
    if (!year) return { status: 'failed' }
    const structures = await fetchParsed(context, FeeStructureList, '/fees/structures', {
      academicYearId: statement.academicYear.id,
      gradeId: statement.student.grade?.id,
    })
    if (!structures.ok) return structures.outcome.status === 'failed' ? { status: 'failed' } : { status: 'not_available' }
    const structureAmountPaise = structureAmountFor(structures.body, head.id, statement.student.grade?.id)

    const startsOn = input.startsOn ?? context.today
    const endsOn = input.endsOn ?? null
    const problem = optInDateProblem(startsOn, endsOn, year.startDate, year.endDate)
    if (problem !== null) return invalid(problem)

    const preview: FeeOptInPreview = {
      kind: 'fee_opt_in',
      ...feePupilOf(pupil.found, statement),
      yearStartsOn: year.startDate,
      yearEndsOn: year.endDate,
      head: { id: head.id, name: clip(head.name, 80) },
      frequency: head.frequency,
      structureAmountPaise,
      proposed: { amountPaise, startsOn, endsOn },
    }
    const perInstalment = amountPaise ?? structureAmountPaise
    return {
      status: 'ok',
      draft: {
        kind: 'fee_opt_in',
        title: clip(`Add ${head.name} for ${name}`, 200),
        preview,
        checkPath: read.checkPath,
        forModel: {
          summary: `Adding ${head.name} for ${pupil.found.label} from ${dateLabel(startsOn)}${endsOn === null ? '' : ` to ${dateLabel(endsOn)}`}. Nothing is saved until the person presses Confirm.`,
          frequency: head.frequency,
          ...(perInstalment === null
            ? { needsAmount: 'The class has no amount for this fee: the card needs the amount per instalment.' }
            : { perInstalmentRupees: perInstalment / 100, ownAmount: amountPaise !== null }),
        },
        href: read.href,
      },
    }
  },
  sameTarget: (original, edited) => sameJson(without(original, ['proposed']), without(edited, ['proposed'])),
  write(preview) {
    const { amountPaise, startsOn, endsOn } = preview.proposed
    if (amountPaise === null && preview.structureAmountPaise === null) return { problem: 'Add the amount per instalment: the class has none.' }
    const problem = optInDateProblem(startsOn, endsOn, preview.yearStartsOn, preview.yearEndsOn)
    if (problem !== null) return { problem }
    const body: FeeOptInCreateRequest = {
      academicYearId: preview.academicYearId,
      feeHeadId: preview.head.id,
      startsOn,
      ...(amountPaise === null ? {} : { amountPaise }),
      ...(endsOn === null ? {} : { endsOn }),
    }
    return { method: 'POST', path: `/fees/students/${seg(preview.studentId)}/opt-ins`, body }
  },
  describeDone: (preview) => `Added ${preview.head.name} from ${dateLabel(preview.proposed.startsOn)}.`,
  checkView: feeStatementCheckView,
})

/** The pure parts, for the tests. */
export const feeToolParts = { findFeePupil, matchFee, optInDateProblem }
