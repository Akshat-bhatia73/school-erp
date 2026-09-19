import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { bumpBucket, lockBucket, type ThrottleBucket } from './throttle.ts'

/**
 * Phone OTP policy for teachers and parents.
 *
 * The provider plugin has no resend cooldown and no daily cap, so both live
 * here and are stored in `auth_throttle`, our own table. They deliberately do
 * not use `auth_rate_limit`: Better Auth prunes that table on its longest
 * configured window (a minute), which would wipe a daily budget. Nothing is
 * kept in process memory: a restart or a second instance must not hand out a
 * fresh allowance.
 */

export const OTP_LENGTH = 6
export const OTP_EXPIRY_SECONDS = 300
export const OTP_ALLOWED_ATTEMPTS = 3
export const OTP_RESEND_COOLDOWN_SECONDS = 60
export const OTP_DAILY_SENDS_PER_NUMBER = 5
export const OTP_DAILY_SENDS_PER_IP = 20

/** The one body a caller ever sees from the send endpoint. */
export const GENERIC_SEND_RESPONSE = { status: 'sent' } as const

/**
 * Accept a 10 digit Indian mobile number or the same number already in E.164.
 * Anything else is not a number we can send to.
 */
export function normalizeIndianPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const compact = raw.replace(/[\s()-]/g, '')
  if (/^[6-9]\d{9}$/.test(compact)) return `+91${compact}`
  if (/^\+91[6-9]\d{9}$/.test(compact)) return compact
  return null
}

/** SHA-256 hex of a number, so no throttle key stores a phone number. */
export function hashPhone(phone: string): string {
  return createHash('sha256').update(phone).digest('hex')
}

export type SendAllowance =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number }

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  )
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

export async function consumeSendAllowance(
  pool: Pool,
  input: { phone: string; ip: string; now?: Date },
): Promise<SendAllowance> {
  const now = input.now ?? new Date()
  const nowMs = now.getTime()
  const day = dayKey(now)
  // A throttle row outlives the request, so it carries a digest of the number
  // rather than the number itself.
  const phoneKey = hashPhone(input.phone)
  const keys = [
    `otp-send:cooldown:${phoneKey}`,
    `otp-send:day:${day}:${phoneKey}`,
    `otp-send:day:${day}:ip:${input.ip}`,
  ]
  const endOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  )
  const expiries = [
    new Date(nowMs + OTP_RESEND_COOLDOWN_SECONDS * 1000),
    endOfDay,
    endOfDay,
  ]
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const buckets: ThrottleBucket[] = []
    for (const [index, key] of keys.entries())
      buckets.push(
        await lockBucket(client, key, now, expiries[index] as Date),
      )
    const [cooldown, perNumber, perIp] = buckets as [
      ThrottleBucket,
      ThrottleBucket,
      ThrottleBucket,
    ]

    const waited = Math.floor((nowMs - cooldown.lastRequest) / 1000)
    if (cooldown.lastRequest > 0 && waited < OTP_RESEND_COOLDOWN_SECONDS) {
      await client.query('ROLLBACK')
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, OTP_RESEND_COOLDOWN_SECONDS - waited),
      }
    }
    if (
      perNumber.count >= OTP_DAILY_SENDS_PER_NUMBER ||
      perIp.count >= OTP_DAILY_SENDS_PER_IP
    ) {
      await client.query('ROLLBACK')
      return { allowed: false, retryAfterSeconds: secondsUntilNextUtcDay(now) }
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
