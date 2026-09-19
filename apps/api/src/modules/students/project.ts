import type { z } from 'zod'
import {
  EnrollmentSummary,
  GuardianContact,
  GuardianPrivate,
  StudentBasic,
  StudentMedical,
  StudentSensitive,
} from '@erp/contracts'
import type { SubjectGuardian } from '@erp/contracts'
import { maskApaar } from '../shared/index.ts'
import type { StudentRow } from './reads.ts'

type Basic = z.infer<typeof StudentBasic>
type Sensitive = z.infer<typeof StudentSensitive>
type Medical = z.infer<typeof StudentMedical>
type Contact = z.infer<typeof GuardianContact>
type Private = z.infer<typeof GuardianPrivate>
type Enrollment = z.infer<typeof EnrollmentSummary>

const STATUSES = ['active', 'left', 'alumni', 'suspended'] as const
const OUTCOMES = ['ongoing', 'promoted', 'detained', 'left'] as const
const GENDERS = ['male', 'female', 'other'] as const
const RELATIONS = ['father', 'mother', 'guardian', 'grandparent', 'sibling', 'other'] as const

function oneOf<T extends string>(values: readonly T[], value: unknown): T | undefined {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

/** Drops empty strings so an optional contract field is omitted, never null. */
function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed.slice(0, max)
}

/**
 * The contract stores telephone numbers in international form. Existing rows
 * hold either ten Indian digits or an already international number, so the ten
 * digit form is widened here and anything else is treated as no number at all.
 */
export function toE164(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (/^\+[1-9]\d{6,14}$/.test(raw)) return raw
  const digits = raw.replace(/[\s-]/g, '')
  if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`
  return undefined
}

function enrollmentOf(row: StudentRow): Enrollment | undefined {
  if (
    row.enrollment_id === null ||
    row.year_id === null ||
    row.year_name === null ||
    row.section_id === null ||
    row.section_name === null ||
    row.grade_id === null ||
    row.grade_name === null
  ) {
    return undefined
  }
  const outcome = oneOf(OUTCOMES, row.outcome) ?? 'ongoing'
  return {
    id: row.enrollment_id,
    academicYear: { id: row.year_id, name: row.year_name },
    section: { id: row.section_id, name: row.section_name },
    grade: { id: row.grade_id, name: row.grade_name },
    ...(row.roll_number === null ? {} : { rollNumber: Number(row.roll_number) }),
    outcome,
  }
}

export function toStudentBasic(row: StudentRow): Basic {
  return {
    id: row.id,
    schoolId: row.school_id,
    version: Number(row.version),
    firstName: row.first_name,
    ...(optionalText(row.last_name, 160) === undefined
      ? {}
      : { lastName: optionalText(row.last_name, 160) as string }),
    admissionNumber: row.admission_number,
    status: oneOf(STATUSES, row.status) ?? 'active',
    anonymised: row.anonymised_at !== null,
    ...(enrollmentOf(row) === undefined ? {} : { enrollment: enrollmentOf(row) as Enrollment }),
  }
}

/**
 * The restricted block only exists when the record actually carries the
 * fields the contract makes mandatory. An older row with no date of birth
 * simply has no sensitive block rather than a fabricated one.
 */
export function toStudentSensitive(row: StudentRow): Sensitive | undefined {
  // An anonymised record has nothing restricted left; the block is omitted
  // rather than answered with a shell of empty fields.
  if (row.anonymised_at !== null) return undefined
  const gender = oneOf(GENDERS, row.gender)
  if (
    row.date_of_birth === null ||
    row.date_of_birth === undefined ||
    gender === undefined ||
    row.admission_date === null ||
    row.admission_date === undefined
  ) {
    return undefined
  }
  const category = optionalText(row.category, 50)
  const admissionType = optionalText(row.admission_type, 50)
  // Only the last four digits ever leave the database in a detail response;
  // the full identifier comes from the audited reveal route.
  const apaarMasked =
    typeof row.apaar_last4 === 'string' && /^\d{4}$/.test(row.apaar_last4)
      ? maskApaar(row.apaar_last4)
      : undefined
  const address = optionalText(row.address, 1000)
  const aadhaar = typeof row.aadhaar_last4 === 'string' && /^\d{4}$/.test(row.aadhaar_last4)
    ? row.aadhaar_last4
    : undefined
  return {
    dateOfBirth: row.date_of_birth,
    gender,
    ...(category === undefined ? {} : { category }),
    ...(admissionType === undefined ? {} : { admissionType }),
    admissionDate: row.admission_date,
    ...(apaarMasked === undefined ? {} : { apaarMasked }),
    ...(aadhaar === undefined ? {} : { aadhaarLast4: aadhaar }),
    ...(address === undefined ? {} : { address }),
  }
}

export function toStudentMedical(row: StudentRow): Medical | undefined {
  if (row.anonymised_at !== null) return undefined
  const bloodGroup = optionalText(row.blood_group, 20)
  const notes = optionalText(row.medical_notes, 4000)
  return {
    ...(bloodGroup === undefined ? {} : { bloodGroup }),
    ...(notes === undefined ? {} : { medicalNotes: notes }),
  }
}

export interface GuardianRow extends Record<string, unknown> {
  id: string
  first_name: string
  last_name: string | null
  phone: string | null
  occupation: string | null
  annual_income: string | null
  address: string | null
  relation: string | null
  version: number
}

function displayName(row: GuardianRow): string {
  return [row.first_name, row.last_name].filter((part) => typeof part === 'string' && part.trim() !== '').join(' ')
}

/** A contact is only offered when it carries a number the contract accepts. */
export function toGuardianContact(row: GuardianRow): Contact | undefined {
  const phone = toE164(row.phone)
  if (phone === undefined) return undefined
  return {
    id: row.id,
    displayName: displayName(row),
    relation: oneOf(RELATIONS, row.relation) ?? 'other',
    phone,
  }
}

export function toGuardianPrivate(row: GuardianRow): Private | undefined {
  const phone = toE164(row.phone)
  if (phone === undefined) return undefined
  const occupation = optionalText(row.occupation, 200)
  const address = optionalText(row.address, 1000)
  const income = row.annual_income === null ? undefined : Number(row.annual_income)
  return {
    id: row.id,
    displayName: displayName(row),
    phone,
    ...(occupation === undefined ? {} : { occupation }),
    ...(income === undefined || Number.isNaN(income) || income < 0 ? {} : { annualIncome: income }),
    ...(address === undefined ? {} : { address }),
  }
}

/**
 * A guardian for the subject access export. Unlike the screen projections this
 * one never drops a person: a guardian with no usable telephone number is
 * still part of their child's record, so the field is omitted, not the row.
 * `full` is the caller's guardian-detail permission; without it only the
 * fields a contact card already shows are named.
 */
export function toSubjectGuardian(row: GuardianRow, full: boolean): SubjectGuardian {
  const phone = toE164(row.phone)
  const named = {
    id: row.id,
    displayName: displayName(row),
    relation: oneOf(RELATIONS, row.relation) ?? 'other',
    ...(phone === undefined ? {} : { phone }),
  }
  if (!full) return named
  const occupation = optionalText(row.occupation, 200)
  const address = optionalText(row.address, 1000)
  const income = row.annual_income === null ? undefined : Number(row.annual_income)
  return {
    ...named,
    ...(occupation === undefined ? {} : { occupation }),
    ...(income === undefined || Number.isNaN(income) || income < 0 ? {} : { annualIncome: income }),
    ...(address === undefined ? {} : { address }),
  }
}
