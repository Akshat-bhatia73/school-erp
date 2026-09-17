/**
 * The six digits an authenticator app would show. RFC 6238 with the defaults
 * the API's provider uses: HMAC-SHA1, a 30 second step and six digits, over
 * the base32 secret published by the enrolment response.
 *
 * `apps/api/scripts/totp-secret.ts` decodes the same secret for `dev:totp`;
 * this suite cannot call the provider's generator because it never loads the
 * API into the test process.
 */
import { createHmac } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function decodeBase32(secret: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function totpCode(base32Secret: string, at: number = Date.now()): string {
  const counter = Math.floor(at / 1000 / 30)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', decodeBase32(base32Secret)).update(message).digest()
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff)
  return String(binary % 1_000_000).padStart(6, '0')
}

export function secretFromTotpUri(totpURI: string): string {
  const secret = new URL(totpURI).searchParams.get('secret')
  if (!secret) throw new Error('the enrolment response carried no TOTP secret')
  return secret
}
