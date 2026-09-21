import type { PermissionKey } from '@erp/contracts'
import { staff } from '@erp/db/schema'
import { z } from 'zod'
import {
  StaffDetailByAudience,
  StaffDirectory as StaffDirectoryFamily,
  StaffEmployment,
  StaffPay,
  StaffPrivate,
} from '@erp/contracts'

export type StaffRow = typeof staff.$inferSelect

export type StaffDirectoryDto = z.infer<typeof StaffDirectoryFamily>
export type StaffDetailDto = z.infer<typeof StaffDetailByAudience>

function displayName(row: StaffRow): string {
  return `${row.firstName} ${row.lastName ?? ''}`.trim()
}

/**
 * Stored text can be longer than the contract allows (an import, an older
 * column width). Trimming it degrades one field instead of failing the whole
 * endpoint, which is what an unparsable response would do.
 */
function fit(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().slice(0, max)
  return trimmed.length > 0 ? trimmed : undefined
}

/** Only a real 'YYYY-MM-DD' is a calendar date the contract accepts. */
function calendarDate(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined
}

/**
 * The directory projection: a name, what the person does and where. Nothing
 * here is private, so every reader who may see the row at all sees exactly
 * these fields.
 */
export function toDirectory(row: StaffRow): StaffDirectoryDto {
  const department = fit(row.department, 160)
  return {
    id: row.id,
    schoolId: row.schoolId,
    version: Number(row.version),
    // A row with no usable name still has to be listable, so fall back to the
    // employee code rather than sending a value the contract rejects.
    displayName: fit(displayName(row), 160) ?? fit(row.employeeCode, 160) ?? 'Staff member',
    designation: fit(row.designation, 160) ?? '',
    anonymised: row.anonymisedAt !== null,
    // The photograph itself only ever arrives through its own checked route;
    // the directory says whether there is one and when it last changed, and
    // never where the bytes live.
    hasPhoto: row.photoStorageKey !== null,
    ...(row.photoUpdatedAt === null
      ? {}
      : { photoUpdatedAt: new Date(row.photoUpdatedAt).toISOString() }),
    ...(department === undefined ? {} : { department }),
  }
}

const EMPLOYMENT_TYPES = ['permanent', 'contract', 'part_time', 'probation'] as const
const STATUSES = ['active', 'on_leave', 'resigned', 'retired'] as const

/**
 * Employment is only sent when the record actually carries the fields the
 * contract requires. A row imported before employment details were captured
 * simply has no employment block rather than a guessed one.
 */
export function toEmployment(row: StaffRow): StaffDetailDto['employment'] {
  const employmentType = EMPLOYMENT_TYPES.find((value) => value === row.employmentType)
  const status = STATUSES.find((value) => value === row.status)
  const joiningDate = calendarDate(row.joiningDate)
  if (!joiningDate || !employmentType || !status) return undefined
  // The leaving date is only set once someone has left, so it rides along only
  // when it is there. It belongs to this block, so it reaches the same readers.
  const leavingDate = calendarDate(row.leavingDate)
  const candidate = {
    employeeCode: fit(row.employeeCode, 100) ?? '',
    joiningDate,
    ...(leavingDate === undefined ? {} : { leavingDate }),
    employmentType,
    status,
  }
  const checked = StaffEmployment.safeParse(candidate)
  return checked.success ? checked.data : undefined
}

/** The address column holds JSON. Only a plain string is a displayable address. */
function addressOf(row: StaffRow): string | undefined {
  return typeof row.address === 'string' ? fit(row.address, 1000) : undefined
}

/**
 * Private contact and identity. A phone number is the one required field, so a
 * record without one has no private block instead of a half-filled one.
 */
export function toPrivate(row: StaffRow): StaffDetailDto['private'] {
  if (!row.phone) return undefined
  const address = addressOf(row)
  const dateOfBirth = calendarDate(row.dateOfBirth)
  const panLast4 = fit(row.panLast4, 4)
  const candidate = {
    phone: row.phone,
    ...(address === undefined ? {} : { address }),
    ...(dateOfBirth === undefined ? {} : { dateOfBirth }),
    ...(panLast4 === undefined ? {} : { panLast4 }),
    ...(row.bankAccountLast4 && /^\d{4}$/.test(row.bankAccountLast4)
      ? { bankAccountLast4: row.bankAccountLast4 }
      : {}),
  }
  // A stored phone that is not in the contract's international shape (an older
  // ten digit Indian number, say) must not fail the whole detail read: the
  // block is dropped and the rest of the record still answers.
  const checked = StaffPrivate.safeParse(candidate)
  return checked.success ? checked.data : undefined
}

/** Pay, for the very few readers who hold the key. numeric arrives as text. */
export function toPay(row: StaffRow): StaffDetailDto['pay'] {
  if (row.monthlySalary === null) return undefined
  const amount = Number(row.monthlySalary)
  const checked = StaffPay.safeParse({ monthlySalary: amount })
  return checked.success ? checked.data : undefined
}

export interface DetailProjection {
  readonly employment: boolean
  readonly private: boolean
  readonly pay: boolean
  readonly allowedActions: readonly PermissionKey[]
}

/** One detail response, assembled from the blocks the caller was allowed. */
export function toDetail(row: StaffRow, allowed: DetailProjection): StaffDetailDto {
  // An anonymised record keeps its employment history and nothing else: the
  // private and pay columns are already cleared, and an empty block would
  // still suggest there is something to look at.
  const anonymised = row.anonymisedAt !== null
  const employment = allowed.employment ? toEmployment(row) : undefined
  const privateBlock = allowed.private && !anonymised ? toPrivate(row) : undefined
  const pay = allowed.pay && !anonymised ? toPay(row) : undefined
  return {
    staff: toDirectory(row),
    ...(employment ? { employment } : {}),
    ...(privateBlock ? { private: privateBlock } : {}),
    ...(pay ? { pay } : {}),
    allowedActions: [...allowed.allowedActions],
  }
}
