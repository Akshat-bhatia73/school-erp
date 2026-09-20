/** Indian identity numbers the office types in: Aadhaar and PAN. */
import { z } from 'zod'

/**
 * The Verhoeff tables Aadhaar uses for its last digit. They are the published
 * dihedral group tables, copied as data: a wrong number that is only a typo
 * away from a real one is caught here instead of being stored.
 */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]

/** True when the twelve digits end in the check digit Aadhaar expects. */
export function isVerhoeffValid(digits: string): boolean {
  let check = 0
  const reversed = digits.split('').reverse()
  for (let index = 0; index < reversed.length; index += 1) {
    const digit = Number(reversed[index])
    if (!Number.isInteger(digit)) return false
    check = VERHOEFF_D[check]![VERHOEFF_P[index % 8]![digit]!]!
  }
  return check === 0
}

/** Spaces are how people write Aadhaar, so typing it in groups is allowed. */
export function normaliseAadhaar(value: string): string {
  return value.replace(/\s+/g, '')
}

/**
 * The whole twelve digit Aadhaar number. It is only ever a request field: a
 * response carries the last four digits, and the stored form is sealed.
 */
export const AadhaarNumber = z
  .string()
  .transform(normaliseAadhaar)
  .refine((value) => /^\d{12}$/.test(value), 'Enter the 12 digit Aadhaar number')
  .refine(
    (value) => !/^\d{12}$/.test(value) || isVerhoeffValid(value),
    'Check the Aadhaar number, those 12 digits are not a valid number',
  )

/** The ten character PAN, written in capitals however it was typed. */
export const PanNumber = z
  .string()
  .transform((value) => value.trim().toUpperCase())
  .refine(
    (value) => /^[A-Z]{5}\d{4}[A-Z]$/.test(value),
    'Enter the 10 character PAN, like AAAAA9999A',
  )

export type AadhaarNumber = z.infer<typeof AadhaarNumber>
export type PanNumber = z.infer<typeof PanNumber>

/** The last digits of each number a screen, a list, an export or a PDF shows. */
export function aadhaarLast4(value: string): string {
  return normaliseAadhaar(value).slice(-4)
}

export function panLast4(value: string): string {
  return value.trim().toUpperCase().slice(-4)
}
