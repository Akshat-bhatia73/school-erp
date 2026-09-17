/**
 * The otpauth URI carries the base32 secret an authenticator app scans; the
 * provider's own code generator takes the decoded bytes. This is the same
 * decoding the API test harness does, so a seeded account, the harness and
 * dev:totp all agree on one code.
 */
export function decodeBase32(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let out = ''
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char)
    if (index < 0) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out += String.fromCharCode((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return out
}
