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

  assert.equal(await previewExists(expiredA), false)
  assert.equal(await previewExists(expiredB), false)
  assert.equal(await previewExists(liveA), true)
  const { rowCount } = await adminPool().query(
    'SELECT 1 FROM auth_verification WHERE id = $1',
    [verificationId],
  )
  assert.equal(rowCount, 0)
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
