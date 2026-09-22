/**
 * Plain words for the fee vocabulary.
 *
 * The contracts use short codes (`credit_adjustment`, `half_yearly`); nobody in a school office
 * says those out loud, so every screen reads the words from here and nowhere else.
 */
import type {
  FeeAppliesTo,
  FeeFrequency,
  FeeHeadCategory,
  FeePaymentMode,
  FeeReceiptKind,
} from '@erp/contracts'
import { Tag, type TagColor } from '@/components/shared/tag'
import { formatPaise } from '@/lib/utils'

export const RECEIPT_KIND_LABEL: Record<FeeReceiptKind, string> = {
  payment: 'Payment',
  refund: 'Refund',
  cancellation: 'Cancelled receipt',
  credit_adjustment: 'Waiver',
  debit_adjustment: 'Extra charge',
}

export const PAYMENT_MODE_LABEL: Record<FeePaymentMode, string> = {
  cash: 'Cash',
  cheque: 'Cheque',
  upi: 'UPI',
  bank_transfer: 'Bank transfer',
  demand_draft: 'Demand draft',
}

export const PAYMENT_MODES = Object.keys(PAYMENT_MODE_LABEL) as FeePaymentMode[]
export const RECEIPT_KINDS = Object.keys(RECEIPT_KIND_LABEL) as FeeReceiptKind[]

export const FREQUENCY_LABEL: Record<FeeFrequency, string> = {
  one_time: 'Once',
  yearly: 'Once a year',
  half_yearly: 'Twice a year',
  quarterly: 'Every quarter',
  monthly: 'Every month',
}
export const FREQUENCIES = Object.keys(FREQUENCY_LABEL) as FeeFrequency[]

export const APPLIES_TO_LABEL: Record<FeeAppliesTo, string> = {
  class: 'Everyone in a class',
  opt_in: 'Only pupils who take it',
}
export const APPLIES_TO = Object.keys(APPLIES_TO_LABEL) as FeeAppliesTo[]

export const HEAD_CATEGORY_LABEL: Record<FeeHeadCategory, string> = {
  tuition: 'Tuition',
  admission: 'Admission',
  transport: 'Transport',
  lab: 'Laboratory',
  sports: 'Sports',
  activity: 'Activity',
  library: 'Library',
  exam: 'Examination',
  uniform: 'Uniform',
  hostel: 'Hostel',
  late_fee: 'Late fee',
  other: 'Other',
}
export const HEAD_CATEGORIES = Object.keys(HEAD_CATEGORY_LABEL) as FeeHeadCategory[]

export const CONCESSION_CATEGORY_LABEL = {
  sibling: 'Sibling',
  staff_child: 'Staff child',
  scholarship: 'Scholarship',
  hardship: 'Hardship',
  other: 'Other',
} as const
export type ConcessionCategoryKey = keyof typeof CONCESSION_CATEGORY_LABEL
export const CONCESSION_CATEGORIES = Object.keys(CONCESSION_CATEGORY_LABEL) as ConcessionCategoryKey[]

const RECEIPT_STATE_LABEL = {
  standing: 'Standing',
  partly_refunded: 'Partly refunded',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
} as const
type ReceiptStateKey = keyof typeof RECEIPT_STATE_LABEL

const RECEIPT_STATE_COLOR: Record<ReceiptStateKey, TagColor> = {
  standing: 'green',
  partly_refunded: 'orange',
  refunded: 'grey',
  cancelled: 'red',
}

/** What has happened to a payment since it was taken. Nothing to show on any other kind. */
export function ReceiptStateTag({ state }: { state: ReceiptStateKey | undefined }) {
  if (!state) return <span className="text-muted-foreground/60">—</span>
  return <Tag color={RECEIPT_STATE_COLOR[state]}>{RECEIPT_STATE_LABEL[state]}</Tag>
}

/**
 * What a family owes right now: a red pill when money is owed, plain words when the year is
 * settled, and "Paid ahead" when they have paid more than has fallen due.
 */
export function BalanceCell({ paise }: { paise: number }) {
  if (paise > 0) return <Tag color="red">{formatPaise(paise)}</Tag>
  if (paise < 0) return <Tag color="green">Paid ahead {formatPaise(-paise)}</Tag>
  return <span className="tabular-nums text-muted-foreground">{formatPaise(0)}</span>
}

/** A money figure in a table cell: right-reading digits, nothing else. */
export function Money({ paise }: { paise: number }) {
  return <span className="tabular-nums">{formatPaise(paise)}</span>
}
