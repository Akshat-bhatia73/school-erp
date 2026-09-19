import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  signInWithMfa,
  startTestServer,
  type TestServer,
} from './harness.ts'
import { setDenialBurstReporter, type DenialBurst } from '../src/observability.ts'

const PASSWORD = 'Fixture-Pass!42'
const OWNER_EMAIL = `read-audit-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `read-audit-parent-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const studentA = fixtureIds.studentA as string
const studentA2 = fixtureIds.studentA2 as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string

// The burst is counted over a membership's own denied rows, which are
// append-only, so the burst test uses a membership created for this run.
const burstUser = randomUUID()
const burstMembership = randomUUID()
const BURST_EMAIL = `read-audit-burst-${randomUUID()}@example.test`

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let parent: Client
let burstClient: Client

interface AuditRow {
  action: string
  result: string
  summary: string
  safe_changes: Record<string, unknown>
  target_id: string | null
}

// The trail is append-only by design, so each test reads only what it caused.
// The marker comes from the database, not from this process: comparing a local
// clock with `created_at` would let skew make a negative assertion pass for the
// wrong reason.
async function mark(): Promise<string> {
  const { rows } = await adminPool().query<{ at: string }>('SELECT now() AS at')
  return rows[0]?.at as string
}

async function rowsFor(since: string, targetId: string, action: string): Promise<AuditRow[]> {
  const found = await adminPool().query<AuditRow>(
    `SELECT action, result, summary, safe_changes, target_id FROM audit_events
      WHERE school_id = $1 AND target_id = $2 AND action = $3 AND created_at >= $4::timestamptz
      ORDER BY created_at`,
    [schoolA, targetId, action, since],
  )
  return found.rows
}

before(async () => {
  await seedDatabaseFixtures()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [parentUserId, PARENT_EMAIL])
  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'Burst Parent',$2)`,
    [burstUser, BURST_EMAIL],
  )
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status)
     VALUES ($1,$2,$3,'adult','active')`,
    [burstMembership, schoolA, burstUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'parent'`,
    [schoolA, burstMembership],
  )
  server = await startTestServer()
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  parent = await signInWithMfa(server, {
    userId: parentUserId,
    email: PARENT_EMAIL,
    password: PASSWORD,
  })
  burstClient = await signInWithMfa(server, {
    userId: burstUser,
    email: BURST_EMAIL,
    password: PASSWORD,
  })
})

after(async () => {
  const pool = adminPool()
  // The MFA enrolment this file made must not outlive it: another file signs
  // the same fixture identities in with a password alone.
  for (const userId of [ownerUserId, parentUserId]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  await server.close()
  await closeAdminPool()
})

test('opening a student record leaves one row naming the blocks read', async () => {
  const since = await mark()
  const detail = await owner.fetch(`/api/schools/${schoolA}/students/${studentA}`)
  assert.equal(detail.status, 200)
  const rows = await rowsFor(since, studentA, 'students.read_basic')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.result, 'allowed')
  assert.equal(rows[0]?.summary, 'Opened the student record.')
  assert.deepEqual(rows[0]?.safe_changes, {
    blocks: ['medical', 'guardianContacts'],
  })
})

test('a list leaves no read row', async () => {
  const since = await mark()
  const list = await owner.fetch(`/api/schools/${schoolA}/students`)
  assert.equal(list.status, 200)
  const all = await adminPool().query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND created_at >= $2::timestamptz`,
    [schoolA, since],
  )
  assert.equal(all.rows[0]?.count, '0')
})

test('a refused read is a denied row the owner can see', async () => {
  const since = await mark()
  // A parent holds no staff permission anywhere, so the gate refuses.
  const refused = await parent.fetch(`/api/schools/${schoolA}/staff`)
  assert.equal(refused.status, 403)

  // A refusal on one record names the record, so the child's own history shows
  // the attempt. A parent may not read an APAAR id, not even her own child's.
  const refusedChild = await parent.fetch(`/api/schools/${schoolA}/students/${studentA2}/apaar`)
  assert.equal(refusedChild.status, 403)

  const denied = await adminPool().query<AuditRow>(
    `SELECT action, result, summary, safe_changes, target_id FROM audit_events
      WHERE school_id = $1 AND result = 'denied' AND created_at >= $2::timestamptz
      ORDER BY created_at`,
    [schoolA, since],
  )
  assert.equal(denied.rowCount, 2)
  assert.equal(denied.rows[0]?.action, 'staff.read_directory')
  // A list route names no record, so the row carries no target.
  assert.equal(denied.rows[0]?.target_id, null)
  assert.equal(
    denied.rows[0]?.summary,
    'Refused: staff.read_directory on /api/schools/:schoolId/staff.',
  )
  assert.deepEqual(denied.rows[0]?.safe_changes, {
    method: 'GET',
    route: '/api/schools/:schoolId/staff',
  })
  assert.equal(denied.rows[1]?.action, 'students.read_sensitive')
  assert.equal(denied.rows[1]?.target_id, studentA2)

  const page = await owner.fetch(`/api/schools/${schoolA}/audit-events`)
  assert.equal(page.status, 200)
  const body = (await page.json()) as { items: { outcome: string; action: string }[] }
  assert.equal(
    body.items.some((item) => item.outcome === 'denied' && item.action === 'staff.read_directory'),
    true,
  )
})

test('twenty-five refusals in ten minutes raise exactly one burst', async () => {
  const bursts: DenialBurst[] = []
  const previous = setDenialBurstReporter((burst) => bursts.push(burst))
  try {
    // Past the threshold on purpose: the report fires on the crossing, so the
    // refusals after the twentieth must add nothing.
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const refused = await burstClient.fetch(`/api/schools/${schoolA}/staff`)
      assert.equal(refused.status, 403)
    }
  } finally {
    setDenialBurstReporter(previous)
  }
  assert.equal(bursts.length, 1)
  assert.equal(bursts[0]?.membershipId, burstMembership)
  assert.equal(bursts[0]?.schoolId, schoolA)
  assert.equal(bursts[0]?.count, 20)
})

test('the APAAR reveal leaves exactly one row', async () => {
  await adminPool().query(
    `UPDATE students SET apaar_ciphertext = NULL, apaar_last4 = NULL WHERE id = $1`,
    [studentA2],
  )
  const set = await owner.fetch(`/api/schools/${schoolA}/students/${studentA2}/sensitive`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedVersion: await versionOf(studentA2), apaarId: '123456789012' }),
  })
  assert.equal(set.status, 200)

  const since = await mark()
  const revealed = await owner.fetch(`/api/schools/${schoolA}/students/${studentA2}/apaar`)
  assert.equal(revealed.status, 200)
  const rows = await rowsFor(since, studentA2, 'students.read_sensitive')
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.summary, 'Revealed the full APAAR id.')
})

async function versionOf(studentId: string): Promise<number> {
  const found = await adminPool().query<{ version: number }>(
    'SELECT version FROM students WHERE id = $1',
    [studentId],
  )
  return Number(found.rows[0]?.version)
}
