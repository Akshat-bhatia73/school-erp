import type { Pool } from 'pg'
import type { DeliveryMessage } from './types.ts'

/** Long enough to read and type a code, short enough that nothing lingers. */
const HOLD_SECONDS = 600
const MAX_MESSAGES = 50

export interface HeldSms {
  readonly to: string
  readonly purpose: DeliveryMessage['purpose']
  readonly secret: string
  readonly createdAt: string
}

/**
 * The stand-in for an SMS provider in a hosted test build. Every write also
 * sweeps what has expired, so the table never grows and no job is needed.
 */
export async function holdSms(
  pool: Pool,
  message: Pick<DeliveryMessage, 'to' | 'purpose' | 'secret'>,
): Promise<void> {
  await pool.query('DELETE FROM held_sms WHERE expires_at <= now()')
  await pool.query(
    `INSERT INTO held_sms (recipient, purpose, secret, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [message.to, message.purpose, message.secret, HOLD_SECONDS],
  )
}

export async function readHeldSms(pool: Pool): Promise<HeldSms[]> {
  const { rows } = await pool.query<{
    recipient: string
    purpose: DeliveryMessage['purpose']
    secret: string
    created_at: Date
  }>(
    `SELECT recipient, purpose, secret, created_at
       FROM held_sms
      WHERE expires_at > now()
      ORDER BY created_at DESC
      LIMIT $1`,
    [MAX_MESSAGES],
  )
  return rows.map((row) => ({
    to: row.recipient,
    purpose: row.purpose,
    secret: row.secret,
    createdAt: row.created_at.toISOString(),
  }))
}
