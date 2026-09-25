import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { aadhaarLast4, panLast4 } from '@erp/contracts'

/**
 * Sealed sensitive text (Task 12). The key lives in the API configuration and
 * never reaches the database, so a database copy on its own reveals nothing.
 * The version prefix lets a later key or algorithm sit beside these rows.
 */
const VERSION = 'v1'
const IV_BYTES = 12
const KEY_BYTES = 32

function keyBytes(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error('DATA_ENCRYPTION_KEY must be the base64 of exactly 32 bytes')
  }
  return key
}

/** `v1.<iv>.<tag>.<ciphertext>`, every part base64url. */
export function seal(plain: string, keyBase64: string): string {
  // A fresh initialisation vector per value: reusing one under GCM would leak
  // the relationship between two sealed values.
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(keyBase64), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    body.toString('base64url'),
  ].join('.')
}

/** The plain text again, or a thrown error when anything has been altered. */
export function open(sealed: string, keyBase64: string): string {
  const parts = sealed.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('sealed value is not in the v1 format')
  }
  const iv = Buffer.from(parts[1] as string, 'base64url')
  const tag = Buffer.from(parts[2] as string, 'base64url')
  const body = Buffer.from(parts[3] as string, 'base64url')
  if (iv.length !== IV_BYTES) throw new Error('sealed value has a malformed nonce')
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(keyBase64), iv)
  decipher.setAuthTag(tag)
  // final() throws when the tag does not match, which is what tampering looks
  // like; the caller must not treat a failure here as "no value".
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/** The only form of an APAAR id a list or a detail response may carry. */
export function maskApaar(last4: string): string {
  return `XXXX-XXXX-${last4}`
}

/**
 * The sealed form of an identity number and the digits a screen may show.
 * Both columns always move together, so a record can never carry a mask with
 * no number behind it, or a number with the wrong mask in front of it. The
 * admission form and the bulk import both seal through these two.
 */
export interface SealedNumber {
  readonly ciphertext: string
  readonly last4: string
}

export function sealAadhaar(value: string, encryptionKey: string): SealedNumber {
  return { ciphertext: seal(value, encryptionKey), last4: aadhaarLast4(value) }
}

export function sealPan(value: string, encryptionKey: string): SealedNumber {
  return { ciphertext: seal(value, encryptionKey), last4: panLast4(value) }
}
