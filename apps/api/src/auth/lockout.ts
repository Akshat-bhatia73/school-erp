import { APIError } from 'better-auth/api'
import type { Pool } from 'pg'

/**
 * Durable per-identity lockout (finding F10).
 *
 * Ten failed password sign-ins lock the identity for fifteen minutes. The
 * counters live on `auth_user` rather than in memory so a restart or a second
 * instance cannot hand out a fresh allowance, and so an operator can see and
 * clear them. A locked or disabled identity is answered with the provider's
 * own invalid-credentials error, so a caller cannot tell a lock, a disabled
 * account and a wrong password apart.
 */

export const MAX_FAILED_SIGN_INS = 10
export const LOCKOUT_MINUTES = 15

/**
 * Copies of the provider's own error bodies (`BASE_ERROR_CODES` and
 * `PHONE_NUMBER_ERROR_CODES`, which Better Auth does not re-export). Throwing
 * these keeps a refusal byte for byte identical to a wrong password or a wrong
 * code.
 */
export function invalidCredentialsError(): APIError {
  return new APIError('UNAUTHORIZED', {
    message: 'Invalid email or password',
    code: 'INVALID_EMAIL_OR_PASSWORD',
  })
}

export function invalidOtpError(): APIError {
  return new APIError('BAD_REQUEST', {
    message: 'Invalid OTP',
    code: 'INVALID_OTP',
  })
}

interface IdentityRow {
  id: string
  disabled: boolean
  locked: boolean
}

async function findIdentity(
  authPool: Pool,
  column: 'email' | 'phone_number',
  value: string,
): Promise<IdentityRow | null> {
  const { rows } = await authPool.query<{
    id: string
    disabled: boolean
    locked: boolean
  }>(
    `SELECT id,
            disabled_at IS NOT NULL AS disabled,
            locked_until IS NOT NULL AND locked_until > now() AS locked
       FROM auth_user
      WHERE lower(${column}) = lower($1)
      LIMIT 1`,
    [value],
  )
  return rows[0] ?? null
}

/** True when this identity must be refused before the provider sees it. */
export async function identityIsBlocked(
  authPool: Pool,
  identifier: { email?: string | null; phone?: string | null },
): Promise<boolean> {
  const column = identifier.email ? 'email' : 'phone_number'
  const value = identifier.email ?? identifier.phone
  if (!value) return false
  const row = await findIdentity(authPool, column, value)
  return row !== null && (row.disabled || row.locked)
}

/**
 * One more failed attempt for this address. The lock is set in the same
 * statement once the counter reaches the limit, so two racing attempts cannot
 * both step past it without locking. A lock that has already run out is not a
 * lock any more: the first failure after it starts a fresh count, otherwise a
 * single mistake fifteen minutes later would lock the identity again forever.
 */
export async function recordFailedSignIn(
  authPool: Pool,
  email: string,
): Promise<void> {
  await authPool.query(
    `UPDATE auth_user
        SET failed_sign_ins = CASE
              WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
              ELSE failed_sign_ins + 1
            END,
            locked_until = CASE
              WHEN locked_until IS NOT NULL AND locked_until <= now() THEN NULL
              WHEN failed_sign_ins + 1 >= $2::int AND locked_until IS NULL
                -- A lock lasts a fixed fifteen minutes: further attempts
                -- while it holds must not slide its end away.
                THEN now() + make_interval(mins => $3::int)
              ELSE locked_until
            END
      WHERE lower(email) = lower($1)`,
    [email, MAX_FAILED_SIGN_INS, LOCKOUT_MINUTES],
  )
}

/** A successful sign-in clears the counter and any expired lock. */
export async function clearFailedSignIns(
  authPool: Pool,
  email: string,
): Promise<void> {
  await authPool.query(
    `UPDATE auth_user
        SET failed_sign_ins = 0,
            locked_until = NULL
      WHERE lower(email) = lower($1)
        AND (failed_sign_ins <> 0 OR locked_until IS NOT NULL)`,
    [email],
  )
}

/** True when an operator has disabled this identity. */
export async function userIsDisabled(
  authPool: Pool,
  userId: string,
): Promise<boolean> {
  const { rows } = await authPool.query<{ disabled: boolean }>(
    `SELECT disabled_at IS NOT NULL AS disabled FROM auth_user WHERE id = $1`,
    [userId],
  )
  return rows[0]?.disabled === true
}
