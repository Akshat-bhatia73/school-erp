import type { Pool, PoolClient } from 'pg'

/**
 * Durable counters that belong to this API, not to the provider.
 *
 * Better Auth's own rate-limit table is pruned on its longest configured
 * window (a minute here), so anything that must last longer than that — a
 * daily send budget, a step-up attempt counter — is kept in `auth_throttle`,
 * where every row carries its own expiry and only this module deletes rows.
 */

export interface ThrottleBucket {
  key: string
  count: number
  lastRequest: number
}

/** Read and lock one bucket, treating an expired row as empty. */
export async function lockBucket(
  client: PoolClient,
  key: string,
  now: Date,
  expiresAt: Date,
): Promise<ThrottleBucket> {
  await client.query(
    `INSERT INTO auth_throttle (key, count, last_request, expires_at)
     VALUES ($1, 0, 0, $2)
     ON CONFLICT (key) DO NOTHING`,
    [key, expiresAt],
  )
  const row = await client.query<{
    count: number
    last_request: string
    expires_at: Date
  }>(
    'SELECT count, last_request, expires_at FROM auth_throttle WHERE key = $1 FOR UPDATE',
    [key],
  )
  const found = row.rows[0]
  if (!found || found.expires_at.getTime() <= now.getTime()) {
    await client.query(
      'UPDATE auth_throttle SET count = 0, last_request = 0, expires_at = $2 WHERE key = $1',
      [key, expiresAt],
    )
    return { key, count: 0, lastRequest: 0 }
  }
  return {
    key,
    count: found.count,
    lastRequest: Number(found.last_request),
  }
}

export async function bumpBucket(
  client: PoolClient,
  key: string,
  nowMs: number,
  expiresAt: Date,
): Promise<void> {
  await client.query(
    'UPDATE auth_throttle SET count = count + 1, last_request = $2, expires_at = $3 WHERE key = $1',
    [key, nowMs, expiresAt],
  )
}

/** Count one failure in a rolling window and report the running total. */
export async function recordFailure(
  pool: Pool,
  key: string,
  windowSeconds: number,
  now: Date = new Date(),
): Promise<number> {
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const bucket = await lockBucket(client, key, now, expiresAt)
    await bumpBucket(client, key, now.getTime(), expiresAt)
    await client.query('COMMIT')
    return bucket.count + 1
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Failures recorded inside the window, ignoring an expired row. */
export async function failureCount(
  pool: Pool,
  key: string,
  now: Date = new Date(),
): Promise<number> {
  const row = await pool.query<{ count: number }>(
    'SELECT count FROM auth_throttle WHERE key = $1 AND expires_at > $2',
    [key, now],
  )
  return row.rows[0]?.count ?? 0
}

export async function clearBucket(pool: Pool, key: string): Promise<void> {
  await pool.query('DELETE FROM auth_throttle WHERE key = $1', [key])
}
