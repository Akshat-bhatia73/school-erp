import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from './harness.ts'

// The fixture ids come from a JavaScript module, so widen them once here.
const SCHOOL_A = String(fixtureIds.schoolA)
const SCHOOL_B = String(fixtureIds.schoolB)
const OWNER_A = String(fixtureIds.ownerA)
const OWNER_B = String(fixtureIds.ownerB)
const YEAR_A = String(fixtureIds.yearA)

const CRON_SECRET = 'cron-secret-for-tests-0123456789abcdefghij'

interface SweepBody {
  swept: Record<string, number>
}

let server: TestServer

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer({ CRON_SECRET })
})
after(async () => {
  await server.close()
  await closeAdminPool()
})

/** A preview row in one school, expired or not, inserted past the tenant policy. */
async function insertPreview(
  schoolId: string,
  membershipId: string,
  yearId: string,
  expired: boolean,
): Promise<string> {
  const id = randomUUID()
  await adminPool().query(
    `INSERT INTO student_import_previews
       (id, school_id, created_by_membership_id, academic_year_id, status,
        total_rows, valid_rows, rows, expires_at)
     VALUES ($1, $2, $3, $4, 'pending', 0, 0, '[]'::jsonb,
       now() + ($5::text)::interval)`,
    [
      id,
      schoolId,
      membershipId,
      yearId,
      expired ? '-1 hour' : '1 hour',
    ],
  )
  return id
}

async function previewExists(id: string): Promise<boolean> {
  const { rowCount } = await adminPool().query(
    'SELECT 1 FROM student_import_previews WHERE id = $1',
    [id],
  )
  return (rowCount ?? 0) > 0
}

test('the sweep route is absent when no cron secret is configured', async () => {
  const plain = await startTestServer()
  try {
    const response = await plain.fetch('/api/maintenance/sweep')
    assert.equal(response.status, 404)
  } finally {
    await plain.close()
  }
})

test('the sweep refuses a missing or wrong bearer token', async () => {
  const missing = await server.fetch('/api/maintenance/sweep')
  assert.equal(missing.status, 401)
  const wrong = await server.fetch('/api/maintenance/sweep', {
    headers: { authorization: 'Bearer not-the-secret-value-0123456789abcd' },
  })
  assert.equal(wrong.status, 401)
})

test('one sweep clears expired rows in both schools and keeps live ones', async () => {
  // School B has no fixture academic year, and a preview needs one.
  const yearB = randomUUID()
  await adminPool().query(
    `INSERT INTO academic_years (id, school_id, name, start_date, end_date, status)
     VALUES ($1, $2, $3, '2026-04-01', '2027-03-31', 'current')`,
    [yearB, SCHOOL_B, `Sweep ${yearB.slice(0, 8)}`],
  )
  const expiredA = await insertPreview(
    SCHOOL_A,
    OWNER_A,
    YEAR_A,
    true,
  )
  const expiredB = await insertPreview(
    SCHOOL_B,
    OWNER_B,
    yearB,
    true,
  )
  const liveA = await insertPreview(
    SCHOOL_A,
    OWNER_A,
    YEAR_A,
    false,
  )
  const verificationId = randomUUID()
  await adminPool().query(
    `INSERT INTO auth_verification (id, identifier, value, expires_at)
     VALUES ($1, $2, 'used', now() - interval '1 hour')`,
    [verificationId, `sweep-test-${verificationId}`],
  )

  const response = await server.fetch('/api/maintenance/sweep', {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  const body = JSON.parse(text) as SweepBody
  assert.ok(body.swept['tenant.import_previews']! >= 2, JSON.stringify(body))
  assert.ok(body.swept['auth.verifications']! >= 1, JSON.stringify(body))
  // The access log sweep reports its own count even when nothing is old enough.
  assert.equal(typeof body.swept['access_log'], 'number', JSON.stringify(body))

  assert.equal(await previewExists(expiredA), false)
  assert.equal(await previewExists(expiredB), false)
  assert.equal(await previewExists(liveA), true)
  const { rowCount } = await adminPool().query(
    'SELECT 1 FROM auth_verification WHERE id = $1',
    [verificationId],
  )
  assert.equal(rowCount, 0)
})

/** The access version the owner's membership carries right now. */
async function ownerAccessVersion(): Promise<number> {
  const found = await adminPool().query<{ access_version: number }>(
    'SELECT access_version FROM school_memberships WHERE id = $1',
    [OWNER_A],
  )
  return found.rows[0]?.access_version ?? 1
}

async function insertJob(opts: {
  status: string
  accessVersion: number
  expiresAt: string
  storageKey?: string
  /** The assurance the request that asked for the file had reached. */
  assurance?: 'single_factor' | 'mfa'
}): Promise<string> {
  const id = randomUUID()
  const assurance = opts.assurance ?? 'mfa'
  await adminPool().query(
    `INSERT INTO export_jobs
       (id, school_id, requested_by_membership_id, kind, status, access_version, permission,
        criteria, storage_key, file_name, content_type, requested_assurance,
        requested_mfa_verified_at, expires_at)
     VALUES ($1, $2, $3, 'students', $4, $5, 'students.export', $6::jsonb, $7, $8, $9, $11,
             CASE WHEN $11 = 'mfa' THEN now() ELSE NULL END,
             now() + ($10::text)::interval)`,
    [
      id,
      SCHOOL_A,
      OWNER_A,
      opts.status,
      opts.accessVersion,
      JSON.stringify({ studentIds: [String(fixtureIds.studentA)] }),
      opts.storageKey ?? null,
      opts.storageKey ? 'Students.xlsx' : null,
      opts.storageKey
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : null,
      opts.expiresAt,
      assurance,
    ],
  )
  return id
}

async function jobStatus(id: string): Promise<string | undefined> {
  const found = await adminPool().query<{ status: string }>(
    'SELECT status FROM export_jobs WHERE id = $1',
    [id],
  )
  return found.rows[0]?.status
}

async function runSweep(): Promise<SweepBody> {
  const response = await server.fetch('/api/maintenance/sweep', {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return JSON.parse(text) as SweepBody
}

test('an expired export loses its file first and then its row', async () => {
  const storageKey = `exports/${SCHOOL_A}/${randomUUID()}.xlsx`
  server.documents.put(storageKey, new TextEncoder().encode('old bytes'))
  // Past the sweep's own threshold, which is a day beyond the expiry.
  const jobId = await insertJob({
    status: 'ready',
    accessVersion: await ownerAccessVersion(),
    expiresAt: '-3 days',
    storageKey,
  })

  const body = await runSweep()
  assert.ok(body.swept['exports.files_removed']! >= 1, JSON.stringify(body))
  assert.equal(await server.documents.read(storageKey), null)
  assert.equal(await jobStatus(jobId), undefined)
})

test('every expired export loses its file, not just the first page of them', async () => {
  const keys: string[] = []
  const jobs: string[] = []
  for (let index = 0; index < 3; index += 1) {
    const key = `exports/${SCHOOL_A}/${randomUUID()}.xlsx`
    server.documents.put(key, new TextEncoder().encode('old bytes'))
    keys.push(key)
    jobs.push(
      await insertJob({
        status: 'ready',
        accessVersion: await ownerAccessVersion(),
        expiresAt: '-3 days',
        storageKey: key,
      }),
    )
  }

  const body = await runSweep()
  assert.ok(body.swept['exports.files_removed']! >= 3, JSON.stringify(body))
  // Nothing was left behind when the run ended.
  assert.equal(body.swept['exports.files_left'], 0, JSON.stringify(body))
  for (const key of keys) assert.equal(await server.documents.read(key), null)
  for (const jobId of jobs) assert.equal(await jobStatus(jobId), undefined)
})

test('the sweep builds a queued export and hands it a file', async () => {
  const jobId = await insertJob({
    status: 'queued',
    accessVersion: await ownerAccessVersion(),
    expiresAt: '1 hour',
  })

  const body = await runSweep()
  assert.ok(body.swept['exports.produced']! >= 1, JSON.stringify(body))
  assert.equal(await jobStatus(jobId), 'ready')

  const stored = await adminPool().query<{ storage_key: string; row_count: number }>(
    'SELECT storage_key, row_count FROM export_jobs WHERE id = $1',
    [jobId],
  )
  const key = stored.rows[0]?.storage_key as string
  assert.ok(key.endsWith('.xlsx'))
  assert.equal(stored.rows[0]?.row_count, 1)
  const file = await server.documents.read(key)
  assert.ok(file)

  await adminPool().query('DELETE FROM export_jobs WHERE id = $1', [jobId])
  await server.documents.remove(key)
})

test('a queued export asked for on a single-factor session is built on one too', async () => {
  // The sweep replays the assurance the row stored rather than inventing a
  // second factor. The owner's roles require one, so a job asked for on a
  // single-factor session reads no privileged row and produces no file at all,
  // where the same job stored as 'mfa' is built.
  const jobId = await insertJob({
    status: 'queued',
    accessVersion: await ownerAccessVersion(),
    expiresAt: '1 hour',
    assurance: 'single_factor',
  })

  await runSweep()

  const stored = await adminPool().query<{ status: string; storage_key: string | null }>(
    'SELECT status, storage_key FROM export_jobs WHERE id = $1',
    [jobId],
  )
  assert.equal(stored.rows[0]?.status, 'failed')
  assert.equal(stored.rows[0]?.storage_key, null, 'no bytes were left behind')

  await adminPool().query('DELETE FROM export_jobs WHERE id = $1', [jobId])
})

test('a queued export whose requester lost access is expired, not built', async () => {
  // The job remembers an access version the membership no longer carries,
  // which is exactly what a role change leaves behind.
  const jobId = await insertJob({
    status: 'queued',
    accessVersion: (await ownerAccessVersion()) + 1,
    expiresAt: '1 hour',
  })

  const body = await runSweep()
  assert.ok(body.swept['exports.expired']! >= 1, JSON.stringify(body))
  assert.equal(await jobStatus(jobId), 'expired')
  const stored = await adminPool().query<{ storage_key: string | null }>(
    'SELECT storage_key FROM export_jobs WHERE id = $1',
    [jobId],
  )
  assert.equal(stored.rows[0]?.storage_key, null)

  await adminPool().query('DELETE FROM export_jobs WHERE id = $1', [jobId])
})

test('a member removed longer ago than the grace period loses sessions and email', async () => {
  const userId = randomUUID()
  const membershipId = randomUUID()
  const sessionId = randomUUID()
  await adminPool().query(
    `INSERT INTO auth_user (id, name, email) VALUES ($1, 'Gone Person', $2)`,
    [userId, `sweep-gone-${userId}@example.test`],
  )
  await adminPool().query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status, updated_at)
     VALUES ($1, $2, $3, 'adult', 'removed', now() - interval '40 days')`,
    [membershipId, SCHOOL_A, userId],
  )
  await adminPool().query(
    `INSERT INTO auth_session (id, user_id, token, expires_at)
     VALUES ($1, $2, $3, now() + interval '1 day')`,
    [sessionId, userId, `sweep-token-${sessionId}`],
  )

  const response = await server.fetch('/api/maintenance/sweep', {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
  assert.equal(response.status, 200, await response.text())

  const sessions = await adminPool().query(
    'SELECT 1 FROM auth_session WHERE user_id = $1',
    [userId],
  )
  assert.equal(sessions.rowCount, 0)
  const user = await adminPool().query<{ email: string; name: string }>(
    'SELECT email, name FROM auth_user WHERE id = $1',
    [userId],
  )
  assert.equal(user.rows[0]?.email, `removed+${userId}@invalid.local`)
  // Attribution on old audit rows survives.
  assert.equal(user.rows[0]?.name, 'Gone Person')
})
