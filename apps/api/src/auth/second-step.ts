import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import type { SecondStepMethod } from '@erp/contracts'
import { bumpBucket, lockBucket, type ThrottleBucket } from './throttle.ts'

/**
 * The second step a person chose: an authenticator app, or a six digit code
 * sent by text message or by email. See migration 0027.
 *
 * `method` is the step the person has proven and uses now; a sign-in
 * challenge accepts that one and a backup code, nothing else. `pending` is a
 * step they asked to switch to on their own session. It becomes the method
 * only when a code from it is accepted on a session (never on a sign-in
 * challenge), so an abandoned switch leaves the old step working.
 */
export interface SecondStepState {
  userId: string
  twoFactorEnabled: boolean
  method: SecondStepMethod | null
  pending: SecondStepMethod | null
  email: string
  phoneNumber: string | null
  phoneNumberVerified: boolean
}

/** A code sent by text message or email: five minutes, three tries. */
export const SECOND_STEP_CODE_MINUTES = 5
export const SECOND_STEP_CODE_ATTEMPTS = 3
/** One send a minute, ten a day per person, thirty a day per address. */
export const SECOND_STEP_RESEND_SECONDS = 60
export const SECOND_STEP_DAILY_SENDS_PER_PERSON = 10
export const SECOND_STEP_DAILY_SENDS_PER_IP = 30

const PLACEHOLDER_EMAIL_SUFFIX = '.invalid'

export function isSecondStepMethod(value: unknown): value is SecondStepMethod {
  return value === 'totp' || value === 'sms' || value === 'email'
}

export async function readSecondStep(
  pool: Pool,
  userId: string,
): Promise<SecondStepState | null> {
  const { rows } = await pool.query<{
    two_factor_enabled: boolean
    two_factor_method: string | null
    two_factor_pending_method: string | null
    email: string
    phone_number: string | null
    phone_number_verified: boolean
  }>(
    `SELECT two_factor_enabled, two_factor_method, two_factor_pending_method,
            email, phone_number, phone_number_verified
       FROM auth_user
      WHERE id = $1`,
    [userId],
  )
  const row = rows[0]
  if (!row) return null
  // Before migration 0027 the authenticator was the only second step.
  const method = isSecondStepMethod(row.two_factor_method)
    ? row.two_factor_method
    : row.two_factor_enabled
      ? 'totp'
      : null
  return {
    userId,
    twoFactorEnabled: row.two_factor_enabled,
    method,
    pending: isSecondStepMethod(row.two_factor_pending_method)
      ? row.two_factor_pending_method
      : null,
    email: row.email,
    phoneNumber: row.phone_number,
    phoneNumberVerified: row.phone_number_verified,
  }
}

/** Only a real mailbox can receive a code; generated addresses cannot. */
export function realEmail(state: Pick<SecondStepState, 'email'>): string | null {
  return state.email.endsWith(PLACEHOLDER_EMAIL_SUFFIX) ? null : state.email
}

/** Only a number the school recorded and verified can receive a code. */
export function verifiedPhone(
  state: Pick<SecondStepState, 'phoneNumber' | 'phoneNumberVerified'>,
): string | null {
  return state.phoneNumber && state.phoneNumberVerified ? state.phoneNumber : null
}

/**
 * The step a code route may serve. On a sign-in challenge only the method in
 * use counts; on the person's own session a pending switch counts too, so the
 * new step can be proven before it replaces the old one.
 */
export function stepsAccepted(
  state: SecondStepState,
  hasSession: boolean,
): SecondStepMethod[] {
  const steps: SecondStepMethod[] = []
  if (state.twoFactorEnabled && state.method) steps.push(state.method)
  if (hasSession && state.pending && !steps.includes(state.pending))
    steps.push(state.pending)
  return steps
}

/**
 * Where a text or email code goes. A pending switch wins on a session, since
 * that is the step being proven; otherwise the step in use.
 */
export function codeChannel(
  state: SecondStepState,
  hasSession: boolean,
): 'sms' | 'email' | null {
  const pending = hasSession ? state.pending : null
  if (pending === 'sms' || pending === 'email') return pending
  if (!state.twoFactorEnabled) return null
  return state.method === 'sms' || state.method === 'email' ? state.method : null
}

/** "••••••3210": enough for a person to recognise their own number. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  return `••••••${digits.slice(-4)}`
}

/** "p•••@school.in": the first letter and the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '•••'
  return `${email.slice(0, 1)}•••${email.slice(at)}`
}

/** The mostly hidden place a code for this step goes, if it is sent. */
export function destinationFor(
  state: SecondStepState,
  method: SecondStepMethod,
): string | undefined {
  if (method === 'sms') {
    const phone = verifiedPhone(state)
    return phone ? maskPhone(phone) : undefined
  }
  if (method === 'email') {
    const email = realEmail(state)
    return email ? maskEmail(email) : undefined
  }
  return undefined
}

/**
 * The switch is proven: the pending step becomes the step in use. Leaving the
 * authenticator switches its secret off (the backup codes stay, they are the
 * way back in); a later switch back to it makes a new secret. Every earlier
 * proof belonged to the old step, so every session loses its stamp and the
 * session that just proved the new step is stamped afresh by the caller.
 */
export async function commitPendingStep(
  pool: Pool,
  userId: string,
  proven: SecondStepMethod,
): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const updated = await client.query(
      `UPDATE auth_user
          SET two_factor_method = two_factor_pending_method,
              two_factor_pending_method = NULL,
              two_factor_enabled = true
        WHERE id = $1 AND two_factor_pending_method = $2`,
      [userId, proven],
    )
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK')
      return false
    }
    if (proven !== 'totp')
      await client.query(
        'UPDATE auth_two_factor SET verified = false WHERE user_id = $1',
        [userId],
      )
    await client.query(
      'UPDATE auth_session SET mfa_verified_at = NULL WHERE user_id = $1',
      [userId],
    )
    await client.query('COMMIT')
    return true
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Turning the second step off forgets which one it was, and any switch. */
export async function forgetSecondStep(pool: Pool, userId: string): Promise<void> {
  await pool.query(
    `UPDATE auth_user
        SET two_factor_method = NULL, two_factor_pending_method = NULL
      WHERE id = $1`,
    [userId],
  )
}

export async function setPendingStep(
  pool: Pool,
  userId: string,
  method: SecondStepMethod,
): Promise<void> {
  await pool.query(
    'UPDATE auth_user SET two_factor_pending_method = $2 WHERE id = $1',
    [userId, method],
  )
}

/** A session opened with a phone code. See migration 0027. */
export async function markPhoneCodeSignIn(pool: Pool, token: string): Promise<void> {
  await pool.query(
    'UPDATE auth_session SET phone_code_sign_in = true WHERE token = $1',
    [token],
  )
}

export async function sessionUsedPhoneCode(
  pool: Pool,
  sessionId: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ phone_code_sign_in: boolean }>(
    'SELECT phone_code_sign_in FROM auth_session WHERE id = $1',
    [sessionId],
  )
  return rows[0]?.phone_code_sign_in === true
}

export type SecondStepSendAllowance =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }

/**
 * Sending a code costs something and reaches a real person, so it is budgeted
 * per person (or per sign-in challenge before there is a session) and per
 * address, in `auth_throttle` like the phone sign-in code.
 */
export async function consumeSecondStepSend(
  pool: Pool,
  input: { subject: string; ip: string; now?: Date },
): Promise<SecondStepSendAllowance> {
  const now = input.now ?? new Date()
  const nowMs = now.getTime()
  const day = now.toISOString().slice(0, 10)
  const digest = (value: string) =>
    createHash('sha256').update(value).digest('hex')
  const subject = digest(input.subject)
  const keys = [
    `second-step-send:cooldown:${subject}`,
    `second-step-send:day:${day}:${subject}`,
    `second-step-send:day:${day}:ip:${digest(input.ip)}`,
  ]
  const endOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  )
  const expiries = [
    new Date(nowMs + SECOND_STEP_RESEND_SECONDS * 1000),
    endOfDay,
    endOfDay,
  ]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const buckets: ThrottleBucket[] = []
    for (const [index, key] of keys.entries())
      buckets.push(await lockBucket(client, key, now, expiries[index] as Date))
    const [cooldown, perSubject, perIp] = buckets as [
      ThrottleBucket,
      ThrottleBucket,
      ThrottleBucket,
    ]
    const waited = Math.floor((nowMs - cooldown.lastRequest) / 1000)
    if (cooldown.lastRequest > 0 && waited < SECOND_STEP_RESEND_SECONDS) {
      await client.query('ROLLBACK')
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, SECOND_STEP_RESEND_SECONDS - waited),
      }
    }
    if (
      perSubject.count >= SECOND_STEP_DAILY_SENDS_PER_PERSON ||
      perIp.count >= SECOND_STEP_DAILY_SENDS_PER_IP
    ) {
      await client.query('ROLLBACK')
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((endOfDay.getTime() - nowMs) / 1000),
        ),
      }
    }
    for (const [index, bucket] of buckets.entries())
      await bumpBucket(client, bucket.key, nowMs, expiries[index] as Date)
    await client.query('COMMIT')
    return { allowed: true }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
