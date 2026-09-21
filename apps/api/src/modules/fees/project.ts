import {
  FeeConcession,
  FeeHead,
  FeeOptIn,
  FeeStructure,
  type PermissionKey,
} from '@erp/contracts'
import { toPaise } from './charges.ts'

/**
 * Row to contract, for the four editable fee records. Every route that answers
 * one of them goes through here, so a head reads the same on the setup screen,
 * on a statement and after a save. Amounts leave the database as bigint
 * strings and leave here as whole paise.
 */

const asDate = (value: unknown): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)

export interface FeeHeadRow extends Record<string, unknown> {
  id: string
  name: string
  category: string
  applies_to: string
  frequency: string
  active: boolean
  version: number
}

/** `SELECT ${FEE_HEAD_COLUMNS} FROM fee_heads` gives a FeeHeadRow. */
export const FEE_HEAD_COLUMNS =
  'fee_heads.id, fee_heads.name, fee_heads.category, fee_heads.applies_to, fee_heads.frequency, fee_heads.active, fee_heads.version'

export function projectFeeHead(row: FeeHeadRow, allowedActions: readonly PermissionKey[]): FeeHead {
  return FeeHead.parse({
    id: row.id,
    name: row.name,
    category: row.category,
    appliesTo: row.applies_to,
    frequency: row.frequency,
    active: row.active,
    version: Number(row.version),
    allowedActions: [...allowedActions],
  })
}

export interface FeeStructureRow extends Record<string, unknown> {
  id: string
  academic_year_id: string
  academic_year_name: string
  fee_head_id: string
  fee_head_name: string
  frequency: string
  applies_to: string
  grade_id: string | null
  grade_name: string | null
  amount_paise: string | number
  version: number
}

export function projectFeeStructure(
  row: FeeStructureRow,
  allowedActions: readonly PermissionKey[],
): FeeStructure {
  return FeeStructure.parse({
    id: row.id,
    academicYear: { id: row.academic_year_id, name: row.academic_year_name },
    head: { id: row.fee_head_id, name: row.fee_head_name },
    ...(row.grade_id === null || row.grade_name === null
      ? {}
      : { grade: { id: row.grade_id, name: row.grade_name } }),
    amountPaise: toPaise(row.amount_paise),
    frequency: row.frequency,
    appliesTo: row.applies_to,
    version: Number(row.version),
    allowedActions: [...allowedActions],
  })
}

export interface FeeOptInRow extends Record<string, unknown> {
  id: string
  fee_head_id: string
  fee_head_name: string
  amount_paise: string | number | null
  starts_on: string | Date
  ends_on: string | Date | null
  version: number
}

export function projectFeeOptIn(row: FeeOptInRow): FeeOptIn {
  return FeeOptIn.parse({
    id: row.id,
    head: { id: row.fee_head_id, name: row.fee_head_name },
    ...(row.amount_paise === null ? {} : { amountPaise: toPaise(row.amount_paise) }),
    startsOn: asDate(row.starts_on),
    ...(row.ends_on === null ? {} : { endsOn: asDate(row.ends_on) }),
    version: Number(row.version),
  })
}

export interface FeeConcessionRow extends Record<string, unknown> {
  id: string
  fee_head_id: string | null
  fee_head_name: string | null
  category: string
  kind: string
  percent_bp: number | null
  amount_paise: string | number | null
  version: number
}

export function projectFeeConcession(row: FeeConcessionRow): FeeConcession {
  return FeeConcession.parse({
    id: row.id,
    ...(row.fee_head_id === null || row.fee_head_name === null
      ? {}
      : { head: { id: row.fee_head_id, name: row.fee_head_name } }),
    category: row.category,
    kind: row.kind,
    ...(row.percent_bp === null ? {} : { percentBp: Number(row.percent_bp) }),
    ...(row.amount_paise === null ? {} : { amountPaise: toPaise(row.amount_paise) }),
    version: Number(row.version),
  })
}

/**
 * The optional fees and the concessions of one pupil in one year. The caller
 * has already decided `fees.read` on that pupil; these two reads are bounded by
 * the school and the pupil and nothing else.
 */
export const OPT_INS_OF_PUPIL = `
  SELECT o.id, o.fee_head_id, h.name AS fee_head_name, o.amount_paise, o.starts_on, o.ends_on, o.version
    FROM fee_student_heads o
    JOIN fee_heads h ON h.school_id = o.school_id AND h.id = o.fee_head_id
   WHERE o.school_id = $1 AND o.student_id = $2 AND o.academic_year_id = $3
   ORDER BY h.name, o.id`

export const CONCESSIONS_OF_PUPIL = `
  SELECT c.id, c.fee_head_id, h.name AS fee_head_name, c.category, c.kind, c.percent_bp, c.amount_paise, c.version
    FROM fee_concessions c
    LEFT JOIN fee_heads h ON h.school_id = c.school_id AND h.id = c.fee_head_id
   WHERE c.school_id = $1 AND c.student_id = $2 AND c.academic_year_id = $3
   ORDER BY c.created_at, c.id`
