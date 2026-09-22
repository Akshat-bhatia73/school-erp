/** Task 19 request and response contracts owned by the fees module. */
import { z } from 'zod'
import { CalendarDate, DisplayName, Id, PageRequest, Reason, Timestamp, Version } from './common.ts'
import { AllowedActions, ExportFileFormat, ExportJobSummary, NamedReference } from './responses.ts'

/**
 * Money is whole paise everywhere: the database, these contracts and screen
 * state. It is never a float and never rupees. One hundred crore rupees is the
 * ceiling of a single amount, which matches the CHECK on every money column.
 */
export const FEE_MAX_PAISE = 100_000_000_000

/** An amount somebody enters or the school charges: more than nothing. */
export const FeeAmountPaise = z.number().int().positive().max(FEE_MAX_PAISE)
/** A total that may be nothing. */
export const FeeTotalPaise = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
/** A balance: negative when a family has paid ahead of what has fallen due. */
export const FeeBalancePaise = z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)

/**
 * A category only groups the school's heads on a screen and in a file. The
 * head itself is the school's own: its name is whatever the school calls it.
 */
export const FeeHeadCategory = z.enum([
  'tuition', 'admission', 'transport', 'lab', 'sports', 'activity',
  'library', 'exam', 'uniform', 'hostel', 'late_fee', 'other',
])
export type FeeHeadCategory = z.infer<typeof FeeHeadCategory>

/** Charged to everybody in a class, or only to a pupil who takes it. */
export const FeeAppliesTo = z.enum(['class', 'opt_in'])
export type FeeAppliesTo = z.infer<typeof FeeAppliesTo>

export const FeeFrequency = z.enum(['one_time', 'yearly', 'half_yearly', 'quarterly', 'monthly'])
export type FeeFrequency = z.infer<typeof FeeFrequency>

/**
 * Instalments in one academic year. They fall due on the first day of each
 * period, counted from the first day of the year: a monthly head is due on the
 * first of every month, a quarterly head every three months.
 */
export const FEE_INSTALMENTS_PER_YEAR = {
  one_time: 1,
  yearly: 1,
  half_yearly: 2,
  quarterly: 4,
  monthly: 12,
} as const satisfies Record<FeeFrequency, number>

export const FeeConcessionCategory = z.enum(['sibling', 'staff_child', 'scholarship', 'hardship', 'other'])
export type FeeConcessionCategory = z.infer<typeof FeeConcessionCategory>
export const FeeConcessionKind = z.enum(['percent', 'amount'])

/**
 * The kinds of ledger row. A payment brings money in and a refund sends it
 * back; a cancellation voids a payment that never really happened (a bounced
 * cheque, a slip of the hand); a credit adjustment lowers what is due and a
 * debit adjustment raises it, with no money moving.
 */
export const FeeReceiptKind = z.enum(['payment', 'refund', 'cancellation', 'credit_adjustment', 'debit_adjustment'])
export type FeeReceiptKind = z.infer<typeof FeeReceiptKind>

/** Payments are recorded by hand. There is no gateway and no online payment. */
export const FeePaymentMode = z.enum(['cash', 'cheque', 'upi', 'bank_transfer', 'demand_draft'])
export type FeePaymentMode = z.infer<typeof FeePaymentMode>

const FeeReference = z.string().trim().min(1).max(80)

// ---------------------------------------------------------------------------
// Fee heads and structures: what the school charges.

export const FeeHead = z.strictObject({
  id: Id,
  name: DisplayName.max(80),
  category: FeeHeadCategory,
  appliesTo: FeeAppliesTo,
  frequency: FeeFrequency,
  active: z.boolean(),
  version: Version,
  allowedActions: AllowedActions,
})
export type FeeHead = z.infer<typeof FeeHead>
export const FeeHeadList = z.array(FeeHead).max(500)

export const FeeHeadCreateRequest = z.strictObject({
  name: DisplayName.max(80),
  category: FeeHeadCategory,
  appliesTo: FeeAppliesTo,
  frequency: FeeFrequency,
})
export type FeeHeadCreateRequest = z.infer<typeof FeeHeadCreateRequest>

/**
 * Who a head applies to and how often it is charged are fixed once it exists:
 * changing either would silently change what every pupil already owes. A
 * school that needs a different shape makes a new head and retires this one.
 */
export const FeeHeadUpdateRequest = z.strictObject({
  name: DisplayName.max(80),
  category: FeeHeadCategory,
  active: z.boolean(),
  expectedVersion: Version,
})
export type FeeHeadUpdateRequest = z.infer<typeof FeeHeadUpdateRequest>

export const FeeStructure = z.strictObject({
  id: Id,
  academicYear: NamedReference,
  head: NamedReference,
  /** Absent when the amount is for every class. */
  grade: NamedReference.optional(),
  /** Per instalment. */
  amountPaise: FeeAmountPaise,
  frequency: FeeFrequency,
  appliesTo: FeeAppliesTo,
  version: Version,
  allowedActions: AllowedActions,
})
export type FeeStructure = z.infer<typeof FeeStructure>
export const FeeStructureList = z.array(FeeStructure).max(2000)

export const FeeStructureListRequest = z.strictObject({
  academicYearId: Id,
  gradeId: Id.optional(),
})
export type FeeStructureListRequest = z.infer<typeof FeeStructureListRequest>

export const FeeStructureCreateRequest = z.strictObject({
  academicYearId: Id,
  feeHeadId: Id,
  gradeId: Id.optional(),
  amountPaise: FeeAmountPaise,
})
export type FeeStructureCreateRequest = z.infer<typeof FeeStructureCreateRequest>

export const FeeStructureUpdateRequest = z.strictObject({
  amountPaise: FeeAmountPaise,
  expectedVersion: Version,
})
export type FeeStructureUpdateRequest = z.infer<typeof FeeStructureUpdateRequest>

/** A delete names the version in the query string, because it has no body. */
export const FeeDeleteQuery = z.strictObject({ expectedVersion: Version })
export type FeeDeleteQuery = z.infer<typeof FeeDeleteQuery>

// ---------------------------------------------------------------------------
// One pupil: optional fees and concessions.

export const FeeOptIn = z.strictObject({
  id: Id,
  head: NamedReference,
  /** This pupil's own amount per instalment; absent takes the structure's. */
  amountPaise: FeeAmountPaise.optional(),
  startsOn: CalendarDate,
  endsOn: CalendarDate.optional(),
  version: Version,
})
export type FeeOptIn = z.infer<typeof FeeOptIn>

export const FeeOptInCreateRequest = z
  .strictObject({
    academicYearId: Id,
    feeHeadId: Id,
    amountPaise: FeeAmountPaise.optional(),
    startsOn: CalendarDate,
    endsOn: CalendarDate.optional(),
  })
  .refine((value) => value.endsOn === undefined || value.endsOn >= value.startsOn, 'The end date is before the start date')
export type FeeOptInCreateRequest = z.infer<typeof FeeOptInCreateRequest>

/** `null` clears the pupil's own amount or the end date. */
export const FeeOptInUpdateRequest = z.strictObject({
  amountPaise: FeeAmountPaise.nullable(),
  endsOn: CalendarDate.nullable(),
  expectedVersion: Version,
})
export type FeeOptInUpdateRequest = z.infer<typeof FeeOptInUpdateRequest>

export const FeeConcession = z.strictObject({
  id: Id,
  /** Absent when the concession applies to every head. */
  head: NamedReference.optional(),
  category: FeeConcessionCategory,
  kind: FeeConcessionKind,
  /** Basis points: 2500 is twenty-five per cent. */
  percentBp: z.number().int().min(1).max(10_000).optional(),
  /** Off every instalment of the head. */
  amountPaise: FeeAmountPaise.optional(),
  version: Version,
})
export type FeeConcession = z.infer<typeof FeeConcession>

/**
 * The reason is what somebody typed, so it goes to the audit note and is
 * stored nowhere else. The category is the closed list a screen can show.
 */
export const FeeConcessionCreateRequest = z
  .strictObject({
    academicYearId: Id,
    feeHeadId: Id.optional(),
    category: FeeConcessionCategory,
    kind: FeeConcessionKind,
    percentBp: z.number().int().min(1).max(10_000).optional(),
    amountPaise: FeeAmountPaise.optional(),
    reason: Reason,
  })
  .refine(
    (value) =>
      value.kind === 'percent'
        ? value.percentBp !== undefined && value.amountPaise === undefined
        : value.amountPaise !== undefined && value.percentBp === undefined && value.feeHeadId !== undefined,
    'A percent concession names a percentage; an amount concession names an amount and a fee',
  )
export type FeeConcessionCreateRequest = z.infer<typeof FeeConcessionCreateRequest>

export const FeeConcessionRemoveRequest = z.strictObject({ reason: Reason, expectedVersion: Version })
export type FeeConcessionRemoveRequest = z.infer<typeof FeeConcessionRemoveRequest>

// ---------------------------------------------------------------------------
// The ledger.

/** The pupil a fee row belongs to, named no further than a roster names them. */
export const FeeStudent = z.strictObject({
  id: Id,
  name: DisplayName,
  admissionNumber: z.string().min(1).max(100),
  grade: NamedReference.optional(),
  section: NamedReference.optional(),
})
export type FeeStudent = z.infer<typeof FeeStudent>

export const FeeLine = z.strictObject({ feeHeadId: Id, amountPaise: FeeAmountPaise })
const FeeLines = z
  .array(FeeLine)
  .min(1)
  .max(30)
  .refine((lines) => new Set(lines.map((line) => line.feeHeadId)).size === lines.length, 'A fee may appear once')

/** What has happened to a payment since it was taken. */
export const FeeReceiptState = z.enum(['standing', 'partly_refunded', 'refunded', 'cancelled'])

export const FeeReceiptSummary = z.strictObject({
  id: Id,
  receiptNumber: z.string().min(1).max(60),
  kind: FeeReceiptKind,
  amountPaise: FeeAmountPaise,
  mode: FeePaymentMode.optional(),
  receivedOn: CalendarDate,
  student: FeeStudent,
  academicYear: NamedReference,
  /** Only on a payment. */
  state: FeeReceiptState.optional(),
  /** The row this one reverses, on a refund or a cancellation. */
  reverses: z.strictObject({ id: Id, receiptNumber: z.string().min(1).max(60) }).optional(),
  allowedActions: AllowedActions,
})
export type FeeReceiptSummary = z.infer<typeof FeeReceiptSummary>

export const FeeReceiptDetail = FeeReceiptSummary.extend({
  lines: z.array(z.strictObject({ head: NamedReference, amountPaise: FeeAmountPaise })).min(1).max(30),
  reference: FeeReference.optional(),
  payerName: DisplayName.max(120).optional(),
  recordedAt: Timestamp,
  /** What may still be refunded from a payment. */
  refundablePaise: FeeTotalPaise.optional(),
  reversedBy: z
    .array(
      z.strictObject({
        id: Id,
        receiptNumber: z.string().min(1).max(60),
        kind: FeeReceiptKind,
        amountPaise: FeeAmountPaise,
        receivedOn: CalendarDate,
      }),
    )
    .max(50),
})
export type FeeReceiptDetail = z.infer<typeof FeeReceiptDetail>

/**
 * A collection. The receipt number is absent on purpose: the server assigns it
 * from the school's counter for the academic year, and a strict object turns an
 * attempt to send one into a refused request.
 */
export const FeeCollectRequest = z.strictObject({
  academicYearId: Id,
  lines: FeeLines,
  mode: FeePaymentMode,
  reference: FeeReference.optional(),
  receivedOn: CalendarDate,
  payerName: DisplayName.max(120).optional(),
})
export type FeeCollectRequest = z.infer<typeof FeeCollectRequest>

export const FeeRefundRequest = z.strictObject({
  lines: FeeLines,
  mode: FeePaymentMode,
  reference: FeeReference.optional(),
  refundedOn: CalendarDate,
  reason: Reason,
})
export type FeeRefundRequest = z.infer<typeof FeeRefundRequest>

export const FeeCancelRequest = z.strictObject({ reason: Reason })
export type FeeCancelRequest = z.infer<typeof FeeCancelRequest>

export const FeeAdjustmentRequest = z.strictObject({
  academicYearId: Id,
  /** `credit` lowers what is due (a waiver); `debit` raises it (a fine). */
  direction: z.enum(['credit', 'debit']),
  lines: FeeLines,
  reason: Reason,
})
export type FeeAdjustmentRequest = z.infer<typeof FeeAdjustmentRequest>

export const FeeReceiptListRequest = PageRequest.extend({
  academicYearId: Id.optional(),
  studentId: Id.optional(),
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  mode: FeePaymentMode.optional(),
  kind: FeeReceiptKind.optional(),
  /** A receipt number, an admission number or part of a pupil's name. */
  q: z.string().trim().min(1).max(100).optional(),
})
export type FeeReceiptListRequest = z.infer<typeof FeeReceiptListRequest>

/**
 * Totals over every row the filters and the caller's plan select, not over the
 * page. A cancelled payment is not money, so it counts in `cancelledPaise` and
 * not in `collectedPaise`.
 */
export const FeeReceiptPage = z.strictObject({
  items: z.array(FeeReceiptSummary).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  totals: z.strictObject({
    collectedPaise: FeeTotalPaise,
    refundedPaise: FeeTotalPaise,
    cancelledPaise: FeeTotalPaise,
    netPaise: FeeBalancePaise,
  }),
})
export type FeeReceiptPage = z.infer<typeof FeeReceiptPage>

// ---------------------------------------------------------------------------
// The statement and the dues list.

export const FeeStatementRequest = z.strictObject({ academicYearId: Id.optional() })
export type FeeStatementRequest = z.infer<typeof FeeStatementRequest>

/**
 * One head on one pupil's statement.
 *
 * - `chargedYearPaise`: every instalment of the year, before any concession.
 * - `concessionYearPaise`: what concessions take off over the year.
 * - `adjustmentPaise`: debit adjustments less credit adjustments.
 * - `dueToDatePaise`: instalments that have fallen due, less their
 *   concessions, plus the adjustments.
 * - `paidPaise`: payments that stand, less refunds.
 * - `balancePaise`: `dueToDatePaise - paidPaise`. Negative means paid ahead.
 * - `yearBalancePaise`: what is left of the whole year.
 */
const FeeFigures = {
  chargedYearPaise: FeeTotalPaise,
  concessionYearPaise: FeeTotalPaise,
  adjustmentPaise: FeeBalancePaise,
  dueToDatePaise: FeeBalancePaise,
  paidPaise: FeeBalancePaise,
  balancePaise: FeeBalancePaise,
  yearBalancePaise: FeeBalancePaise,
}

export const FeeStatementLine = z.strictObject({
  head: NamedReference,
  category: FeeHeadCategory,
  appliesTo: FeeAppliesTo,
  frequency: FeeFrequency,
  /** Instalments charged this year, and how many of them have fallen due. */
  instalments: z.number().int().nonnegative().max(12),
  instalmentsDue: z.number().int().nonnegative().max(12),
  ...FeeFigures,
})
export type FeeStatementLine = z.infer<typeof FeeStatementLine>

export const FeeStatement = z.strictObject({
  student: FeeStudent,
  academicYear: NamedReference,
  /** The day "fallen due" is measured against: today in the school's timezone. */
  asOf: CalendarDate,
  lines: z.array(FeeStatementLine).max(200),
  totals: z.strictObject(FeeFigures),
  optIns: z.array(FeeOptIn).max(100),
  concessions: z.array(FeeConcession).max(100),
  receipts: z.array(FeeReceiptSummary).max(500),
  allowedActions: AllowedActions,
})
export type FeeStatement = z.infer<typeof FeeStatement>

export const FeeDuesRequest = PageRequest.extend({
  academicYearId: Id.optional(),
  gradeId: Id.optional(),
  sectionId: Id.optional(),
  /** `due` keeps only pupils who owe something today. */
  show: z.enum(['all', 'due']).default('all'),
  q: z.string().trim().min(1).max(100).optional(),
})
export type FeeDuesRequest = z.infer<typeof FeeDuesRequest>

export const FeeDuesRow = z.strictObject({
  student: FeeStudent,
  chargedYearPaise: FeeTotalPaise,
  dueToDatePaise: FeeBalancePaise,
  paidPaise: FeeBalancePaise,
  balancePaise: FeeBalancePaise,
  allowedActions: AllowedActions,
})
export type FeeDuesRow = z.infer<typeof FeeDuesRow>

/** Totals cover every pupil the filters and the caller's plan select. */
export const FeeDuesPage = z.strictObject({
  items: z.array(FeeDuesRow).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
  academicYear: NamedReference,
  asOf: CalendarDate,
  totals: z.strictObject({
    dueToDatePaise: FeeBalancePaise,
    paidPaise: FeeBalancePaise,
    /** The sum of what each pupil still owes; a pupil paid ahead adds nothing. */
    outstandingPaise: FeeTotalPaise,
    studentsWithDues: z.number().int().nonnegative(),
  }),
})
export type FeeDuesPage = z.infer<typeof FeeDuesPage>

// ---------------------------------------------------------------------------
// Files.

/** One receipt as a document. The receipt is named in the path. */
export const FeeReceiptExportRequest = z.strictObject({})
export type FeeReceiptExportRequest = z.infer<typeof FeeReceiptExportRequest>

export const FeeDuesExportRequest = z.strictObject({
  academicYearId: Id,
  gradeId: Id.optional(),
  sectionId: Id.optional(),
  show: z.enum(['all', 'due']).default('all'),
  format: ExportFileFormat,
})
export type FeeDuesExportRequest = z.infer<typeof FeeDuesExportRequest>

/** The longest window one collection register may cover, in days. */
export const FEE_EXPORT_MAX_DAYS = 366

export const FeeCollectionsExportRequest = z
  .strictObject({
    from: CalendarDate,
    to: CalendarDate,
    mode: FeePaymentMode.optional(),
    format: ExportFileFormat,
  })
  .refine((value) => value.to >= value.from, 'The end date is before the start date')
export type FeeCollectionsExportRequest = z.infer<typeof FeeCollectionsExportRequest>

export const FeeExportJob = ExportJobSummary
