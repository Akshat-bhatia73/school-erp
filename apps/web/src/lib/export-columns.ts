/**
 * The column choice for the student and staff list exports.
 *
 * The lists and the key each column needs live in `@erp/contracts`. The screen offers a column
 * only when the person holds its key at school level; the producer decides the key again for every
 * row, so this is never an authorization decision, only what is worth offering. The last choice is
 * a browser preference, kept per school and list in localStorage.
 */
import {
  STAFF_EXPORT_COLUMNS, STUDENT_EXPORT_COLUMNS, type PermissionKey,
} from '@erp/contracts'

export type ExportColumnList = 'students' | 'staff'

export interface ExportColumnOption {
  key: string
  label: string
  byDefault: boolean
}

type Spec = Record<string, { readonly label: string; readonly permission?: PermissionKey; readonly byDefault: boolean }>

const SPECS: Record<ExportColumnList, Spec> = {
  students: STUDENT_EXPORT_COLUMNS,
  staff: STAFF_EXPORT_COLUMNS,
}

/** The whole-number Aadhaar columns, which carry a warning when offered. */
export const FULL_IDENTITY_COLUMNS: ReadonlySet<string> = new Set(['aadhaar'])

/** The columns this person may choose, in file order. A column with no key is always offered. */
export function offeredColumns(list: ExportColumnList, hasPermission: (key: PermissionKey) => boolean): ExportColumnOption[] {
  return Object.entries(SPECS[list])
    .filter(([, spec]) => spec.permission === undefined || hasPermission(spec.permission))
    .map(([key, spec]) => ({ key, label: spec.label, byDefault: spec.byDefault }))
}

/** The columns the file has when the request names none. */
export function defaultColumns(list: ExportColumnList): string[] {
  return Object.entries(SPECS[list]).filter(([, spec]) => spec.byDefault).map(([key]) => key)
}

/** The chosen keys in file order, whatever order they were ticked in. */
export function inFileOrder(list: ExportColumnList, chosen: Iterable<string>): string[] {
  const set = new Set(chosen)
  return Object.keys(SPECS[list]).filter((key) => set.has(key))
}

/**
 * What the request carries: nothing when the choice is exactly the default columns, so the file
 * is the one the list always made; otherwise the chosen keys in file order.
 */
export function columnsToSend(list: ExportColumnList, chosen: Iterable<string>): string[] | undefined {
  const ordered = inFileOrder(list, chosen)
  const defaults = defaultColumns(list)
  const same = ordered.length === defaults.length && ordered.every((key, index) => key === defaults[index])
  return same ? undefined : ordered
}

const storageKey = (schoolId: string, list: ExportColumnList) => `erp.exportColumns.${schoolId}.${list}`

/**
 * The columns to start the dialog with: the last choice in this browser, cut to what is still
 * offered, or the default columns the person may see.
 */
export function initialColumns(schoolId: string, list: ExportColumnList, offered: ExportColumnOption[]): string[] {
  const offeredKeys = new Set(offered.map((option) => option.key))
  let stored: unknown = null
  try {
    stored = JSON.parse(window.localStorage.getItem(storageKey(schoolId, list)) ?? 'null')
  } catch {
    stored = null
  }
  if (Array.isArray(stored)) {
    const kept = inFileOrder(list, stored.filter((key): key is string => typeof key === 'string' && offeredKeys.has(key)))
    if (kept.length > 0) return kept
  }
  return offered.filter((option) => option.byDefault).map((option) => option.key)
}

export function rememberColumns(schoolId: string, list: ExportColumnList, chosen: Iterable<string>): void {
  try {
    window.localStorage.setItem(storageKey(schoolId, list), JSON.stringify(inFileOrder(list, chosen)))
  } catch {
    // A browser with storage blocked starts from the defaults each time.
  }
}
