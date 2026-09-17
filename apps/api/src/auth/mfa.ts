import { createHash } from 'node:crypto'
import type { Pool } from 'pg'

/**
 * Second-factor assurance.
 *
 * Better Auth records that an identity *has* two-factor enabled, but not that
 * this particular session completed it. `auth_session.mfa_verified_at` is our
 * own column: it is stamped only after the provider itself accepted a TOTP
 * code or a backup code, and it is what every privileged route checks.
 * Checking `twoFactorEnabled` alone would let a session that never answered a
 * challenge into privileged data.
 */

/** Provider paths that mean "the second factor was just proven". */
export const MFA_VERIFY_PATHS: readonly string[] = [
  '/two-factor/verify-totp',
  '/two-factor/verify-backup-code',
]

/**
 * Trusted devices are switched off. The plugin only sets its trust cookie when
 * the request body asks for it and only honours a cookie it previously signed,
 * so we remove both: the body flag on the way in and any cookie a client
 * replays. "Remember this device" must never skip a challenge in a school.
 */
export const TRUST_DEVICE_COOKIE_SUFFIX = 'trust_device'

/** Drop any cookie whose name is (or ends with) the trust-device cookie. */
export function stripTrustDeviceCookies(header: string | undefined): string {
  if (!header) return ''
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.slice(0, part.indexOf('=')).trim()
      return !name.endsWith(TRUST_DEVICE_COOKIE_SUFFIX)
    })
    .join('; ')
}

/** Remove the remember-this-device request flag from a JSON body. */
export function stripTrustDeviceFlag(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const { trustDevice: _trustDevice, ...rest } = body
  return rest
}

/**
 * Stamp the session that the provider ended up with. The write uses the
 * erp_auth connection: no other role may touch identity tables.
 */
export async function stampSessionMfaVerified(
  pool: Pool,
  token: string,
): Promise<void> {
  await pool.query(
    'UPDATE auth_session SET mfa_verified_at = now() WHERE token = $1',
    [token],
  )
}

/** Provider paths that replace or remove the second factor itself. */
export const MFA_ENROLMENT_PATHS: readonly string[] = [
  '/two-factor/enable',
  '/two-factor/disable',
]

/**
 * A new or removed authenticator makes every earlier proof meaningless: a
 * session stamped by the replaced device must answer the new one before it
 * enters privileged data again. The enrolling session is stamped afresh when
 * its first code is accepted.
 */
export async function clearUserMfaVerification(
  pool: Pool,
  userId: string,
): Promise<void> {
  await pool.query(
    'UPDATE auth_session SET mfa_verified_at = NULL WHERE user_id = $1',
    [userId],
  )
}

/**
 * Step-up attempt limits.
 *
 * Better Auth counts two-factor failures and locks the account only on the
 * sign-in path; when a session already exists (a step-up, or a stolen cookie
 * on a phone-OTP session) the plugin keeps no counter at all. This is ours: a
 * small number of failures per session, or per address when there is no
 * session yet, inside a rolling window.
 */
export const MFA_ATTEMPT_LIMIT = 5
export const MFA_ATTEMPT_WINDOW_SECONDS = 900

/**
 * A stable key for the caller. With a verified session the budget belongs to
 * the person, so many stolen cookies for one account share one counter and a
 * decoy cookie cannot open a fresh bucket. Without a session (a sign-in
 * challenge) it is per address; the provider's own account lockout covers the
 * rest. The address is hashed so no raw value is written to a table.
 */
export function mfaAttemptKey(
  userId: string | undefined,
  ip: string,
): string {
  if (userId) return `mfa-verify:user:${userId}`
  return `mfa-verify:ip:${createHash('sha256').update(ip).digest('hex')}`
}

/** Mark this session as signed in on a shared device. */
export async function markSharedDevice(
  pool: Pool,
  token: string,
): Promise<void> {
  await pool.query(
    'UPDATE auth_session SET shared_device = true WHERE token = $1',
    [token],
  )
}
