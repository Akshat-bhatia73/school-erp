import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { FINANCE_AUDIT_ACTIONS, isFinanceAuditAction } from '@erp/contracts'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  setFixturePassword,
  signInWithMfa,
  signInWithPassword,
  startTestServer,
  type TestServer,
} from './harness.ts'

const PASSWORD = 'Fixture-Pass!42'
// Unique per run: other test files rewrite the same fixture identities.
const OWNER_EMAIL = `audit-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `audit-parent-${randomUUID()}@example.test`
// A principal holds audit.read and not audit.export, which is the only way to
// show that the two gates are decided separately.
const PRINCIPAL_EMAIL = `audit-principal-${randomUUID()}@example.test`
const PRINCIPAL_NAME = 'Audit Principal'
// An accountant reads the audit trail at the finance scope, which selects only
// the finance actions.
const ACCOUNTANT_EMAIL = `audit-accountant-${randomUUID()}@example.test`
const ACCOUNTANT_NAME = 'Audit Accountant'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string
const ownerMembership = fixtureIds.ownerA as string
const ownerBMembership = fixtureIds.ownerB as string

// Marks written by this run only, so assertions never count fixture history.
const MARK = randomUUID().slice(0, 8)
const summaryA = (n: number) => `Audit test row ${MARK} number ${n}`
const summaryB = `Audit test row ${MARK} in the other school`

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let parent: Client
let principal: Client
let principalUserId = ''
let principalMembershipId = ''
let accountant: Client
let accountantUserId = ''
let accountantMembershipId = ''

interface ErrorBody {
  error: { code: string; requestId: string }
}
interface EventItem {
  id: string
  at: string
  actorDisplayName: string
  action: string
  summary: string
  outcome: string
  note?: string
}
interface EventPage {
  items: EventItem[]
  total: number
  page: number
  pageSize: number
}

let schoolBEventId = ''

async function insertEvent(
  schoolId: string,
  actorMembershipId: string | null,
  action: string,
  summary: string,
  result: 'allowed' | 'denied',
  actorUserId: string | null = null,
): Promise<string> {
  const inserted = await adminPool().query<{ id: string }>(
    `INSERT INTO audit_events
       (school_id, actor_user_id, actor_membership_id, action, target_type, target_id,
        result, summary, safe_changes, request_id)
     VALUES ($1, $6, $2, $3, 'membership', NULL, $4, $5, '{"secret":"must not be sent"}'::jsonb, 'test')
     RETURNING id`,
    [schoolId, actorMembershipId, action, result, summary, actorUserId],
  )
  return inserted.rows[0]?.id ?? ''
}

async function roleIdFor(schoolId: string, key: string): Promise<string> {
  const result = await adminPool().query<{ id: string }>(
    'SELECT id FROM roles WHERE school_id = $1 AND key = $2',
    [schoolId, key],
  )
  const id = result.rows[0]?.id
  assert.ok(id, `role ${key} is missing`)
  return id
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [parentUserId, PARENT_EMAIL])
  await setFixturePassword(server, parentUserId, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)

  principalUserId = randomUUID()
  await pool.query(`INSERT INTO auth_user (id, name, email) VALUES ($1, $2, $3)`, [
    principalUserId,
    PRINCIPAL_NAME,
    PRINCIPAL_EMAIL,
  ])
  principalMembershipId = randomUUID()
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [principalMembershipId, schoolA, principalUserId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [schoolA, principalMembershipId, await roleIdFor(schoolA, 'principal')],
  )
  principal = await signInWithMfa(server, {
    userId: principalUserId,
    email: PRINCIPAL_EMAIL,
    password: PASSWORD,
  })

  accountantUserId = randomUUID()
  await pool.query(`INSERT INTO auth_user (id, name, email) VALUES ($1, $2, $3)`, [
    accountantUserId,
    ACCOUNTANT_NAME,
    ACCOUNTANT_EMAIL,
  ])
  accountantMembershipId = randomUUID()
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [accountantMembershipId, schoolA, accountantUserId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [schoolA, accountantMembershipId, await roleIdFor(schoolA, 'accountant')],
  )
  accountant = await signInWithMfa(server, {
    userId: accountantUserId,
    email: ACCOUNTANT_EMAIL,
    password: PASSWORD,
  })

  // Two finance rows, one of them by the accountant itself, so the actor
  // filter has something to narrow on top of the finance predicate.
  await insertEvent(schoolA, ownerMembership, 'staff.update_pay', summaryA(5), 'allowed')
  await insertEvent(schoolA, accountantMembershipId, 'staff.export', summaryA(6), 'allowed')

  // Rows written one by one so the newest-first order is unambiguous. They are
  // written after the finance rows above, so the newest four are these.
  await insertEvent(schoolA, ownerMembership, 'members.roles.change', summaryA(1), 'allowed')
  await insertEvent(schoolA, null, 'members.invite.accept', summaryA(2), 'denied')
  await insertEvent(schoolA, fixtureIds.adult as string, 'members.recovery', summaryA(3), 'allowed')
  // Task 4 writes this one with a user but no membership: a real person, not
  // the system.
  await insertEvent(schoolA, null, 'members.invite.accept', summaryA(4), 'allowed', principalUserId)
  schoolBEventId = await insertEvent(schoolB, ownerBMembership, 'members.suspend', summaryB, 'allowed')
})

after(async () => {
  // Audit history is append-only by trigger, so the rows this run wrote stay
  // in its own private database. Every assertion keys off MARK for that reason.
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    [ownerUserId, principalUserId, accountantUserId],
  ])
  await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])', [
    [ownerUserId, principalUserId, accountantUserId],
  ])
  await server.close()
  await closeAdminPool()
})

async function listMarked(client: Client, extra = ''): Promise<EventPage> {
  const response = await client.fetch(
    `/api/schools/${schoolA}/audit-events?action=members.roles.change${extra}`,
  )
  assert.equal(response.status, 200)
  return (await response.json()) as EventPage
}

test('the audit log needs a session', async () => {
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/audit-events`)
  assert.equal(anonymous.status, 401)
  assert.equal(((await anonymous.json()) as ErrorBody).error.code, 'AUTHENTICATION_REQUIRED')

  const anonymousExport = await fetch(`${server.origin}/api/schools/${schoolA}/audit-events/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }),
  })
  assert.equal(anonymousExport.status, 401)
})

test('a member of one school cannot use another school in the path', async () => {
  const response = await owner.fetch(`/api/schools/${schoolB}/audit-events`)
  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
})

test('a parent holds no audit permission anywhere in the school', async () => {
  const list = await parent.fetch(`/api/schools/${schoolA}/audit-events`)
  assert.equal(list.status, 403)
  assert.equal(((await list.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  const exported = await parent.fetch(`/api/schools/${schoolA}/audit-events/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }),
  })
  assert.equal(exported.status, 403)
})

test('rows and actors from another school are never reachable through this path', async () => {
  const byOtherActor = await owner.fetch(
    `/api/schools/${schoolA}/audit-events?actorMembershipId=${ownerBMembership}&pageSize=100`,
  )
  assert.equal(byOtherActor.status, 200)
  const filtered = (await byOtherActor.json()) as EventPage
  assert.equal(filtered.total, 0)
  assert.deepEqual(filtered.items, [])

  const everything = await owner.fetch(`/api/schools/${schoolA}/audit-events?pageSize=100`)
  const page = (await everything.json()) as EventPage
  assert.equal(page.items.some((item) => item.id === schoolBEventId), false)
  assert.equal(JSON.stringify(page).includes(summaryB), false)
})

test('a permitted read returns exactly the contract fields, newest first', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/audit-events?pageSize=4`)
  assert.equal(response.status, 200)
  const page = (await response.json()) as EventPage
  assert.equal(page.page, 1)
  assert.equal(page.pageSize, 4)
  assert.equal(page.items.length, 4)
  assert.ok(page.total >= 4)

  // The page of four also holds rows the read trail and other tests left in
  // this school, so the ordering and the fields of this file's own four rows
  // are read from a page wide enough to hold all of them.
  const wide = await owner.fetch(`/api/schools/${schoolA}/audit-events?pageSize=100`)
  assert.equal(wide.status, 200)
  const wanted = new Set([summaryA(1), summaryA(2), summaryA(3), summaryA(4)])
  const mine = ((await wide.json()) as EventPage).items.filter((item) =>
    wanted.has(item.summary),
  )
  assert.deepEqual(
    mine.map((item) => item.summary),
    [summaryA(4), summaryA(3), summaryA(2), summaryA(1)],
  )
  for (const item of mine) {
    assert.deepEqual(Object.keys(item).sort(), [
      'action',
      'actorDisplayName',
      'at',
      'id',
      'outcome',
      'summary',
    ])
    assert.ok(Date.parse(item.at) > 0)
  }
  // The redaction is the point: nothing about changes, targets or requests.
  assert.equal(JSON.stringify(page).includes('must not be sent'), false)
  assert.equal(JSON.stringify(page).includes('safeChanges'), false)

  assert.equal(mine[3]?.action, 'members.roles.change')
  assert.equal(mine[3]?.outcome, 'allowed')
  // A row with neither actor belongs to the system, not to an unnamed person.
  assert.equal(mine[2]?.action, 'members.invite.accept')
  assert.equal(mine[2]?.outcome, 'denied')
  assert.equal(mine[2]?.actorDisplayName, 'System')
  // Task 4 writes actions that are not permission keys; the list carries them
  // through unchanged rather than refusing to render its own history.
  assert.equal(mine[1]?.action, 'members.recovery')
  // The teacher-parent fixture is linked to a staff record, so the school's
  // own staff name wins over whatever the login profile says.
  assert.equal(mine[1]?.actorDisplayName, 'Fixture')
  // A row written by a person who had no membership yet is still that person.
  assert.equal(mine[0]?.action, 'members.invite.accept')
  assert.equal(mine[0]?.actorDisplayName, PRINCIPAL_NAME)
  assert.notEqual(mine[0]?.actorDisplayName, 'System')
})

test('page and pageSize are honoured', async () => {
  const first = await listMarked(owner, '&pageSize=1&page=1')
  assert.equal(first.pageSize, 1)
  assert.equal(first.items.length, 1)
  const second = await listMarked(owner, '&pageSize=1&page=2')
  assert.equal(second.page, 2)
  assert.notEqual(second.items[0]?.id, first.items[0]?.id)
  assert.equal(second.total, first.total)

  const bad = await owner.fetch(`/api/schools/${schoolA}/audit-events?pageSize=nine`)
  assert.equal(bad.status, 400)
  assert.equal(((await bad.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
})

test('the from and to window filters the rows', async () => {
  const future = await owner.fetch(
    `/api/schools/${schoolA}/audit-events?from=2099-01-01T00:00:00Z&pageSize=100`,
  )
  const page = (await future.json()) as EventPage
  assert.equal(page.total, 0)
})

test('an export body may only name a window, and writes a job plus an audit row', async () => {
  const before = await adminPool().query<{ total: string }>(
    `SELECT count(*)::text AS total FROM export_jobs WHERE school_id = $1`,
    [schoolA],
  )

  const forbidden = await owner.fetch(`/api/schools/${schoolA}/audit-events/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      from: '2026-01-01T00:00:00Z',
      to: '2026-02-01T00:00:00Z',
      schoolId: schoolB,
      permission: 'audit.read',
    }),
  })
  assert.equal(forbidden.status, 400)
  assert.equal(((await forbidden.json()) as ErrorBody).error.code, 'INVALID_REQUEST')

  const tooWide = await owner.fetch(`/api/schools/${schoolA}/audit-events/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
  })
  assert.equal(tooWide.status, 400)

  const unchanged = await adminPool().query<{ total: string }>(
    `SELECT count(*)::text AS total FROM export_jobs WHERE school_id = $1`,
    [schoolA],
  )
  assert.equal(unchanged.rows[0]?.total, before.rows[0]?.total)

  const response = await owner.fetch(`/api/schools/${schoolA}/audit-events/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '2020-01-01T00:00:00Z', to: '2020-06-01T00:00:00Z' }),
  })
  assert.equal(response.status, 202)
  const job = (await response.json()) as { id: string; status: string }
  assert.deepEqual(Object.keys(job).sort(), ['id', 'status'])
  // No file exists yet, so the job must not claim to be downloadable.
  assert.equal(job.status, 'queued')

  const stored = await adminPool().query<{
    kind: string
    permission: string
    row_count: number
    criteria: { from: string; to: string }
    requested_by_membership_id: string
  }>(`SELECT kind, permission, row_count, criteria, requested_by_membership_id FROM export_jobs WHERE id = $1`, [
    job.id,
  ])
  const row = stored.rows[0]
  assert.equal(row?.kind, 'audit')
  assert.equal(row?.permission, 'audit.export')
  assert.equal(row?.requested_by_membership_id, ownerMembership)
  assert.equal(row?.criteria.from, '2020-01-01T00:00:00Z')
  // The window predates every fixture row, so the count is exact.
  assert.equal(row?.row_count, 0)

  const audited = await owner.fetch(
    `/api/schools/${schoolA}/audit-events?action=audit.export&pageSize=5`,
  )
  const page = (await audited.json()) as EventPage
  assert.ok(page.total >= 1)
  assert.equal(page.items[0]?.action, 'audit.export')
  assert.equal(page.items[0]?.outcome, 'allowed')

  await adminPool().query(`DELETE FROM export_jobs WHERE id = $1`, [job.id])
})

test('a reader who holds audit.read but not audit.export is refused the export', async () => {
  const list = await principal.fetch(`/api/schools/${schoolA}/audit-events?pageSize=5`)
  assert.equal(list.status, 200)
  const page = (await list.json()) as EventPage
  assert.ok(page.total >= 1)

  const exported = await principal.fetch(`/api/schools/${schoolA}/audit-events/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: '2020-01-01T00:00:00Z', to: '2020-06-01T00:00:00Z' }),
  })
  assert.equal(exported.status, 403)
  assert.equal(((await exported.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  // Other suites leave jobs of their own behind, so count only this reader's.
  const jobs = await adminPool().query<{ total: string }>(
    `SELECT count(*)::text AS total FROM export_jobs
      WHERE school_id = $1 AND requested_by_membership_id = $2`,
    [schoolA, principalMembershipId],
  )
  assert.equal(jobs.rows[0]?.total, '0')
})

test('a malformed actor id is bad input, not a server failure', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/audit-events?actorMembershipId=abc`)
  assert.equal(response.status, 400)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
})

/** How many audit rows of this school carry a finance action right now. */
async function financeRowCount(): Promise<number> {
  const result = await adminPool().query<{ total: string }>(
    `SELECT count(*)::text AS total FROM audit_events WHERE school_id = $1 AND action = ANY($2::text[])`,
    [schoolA, [...FINANCE_AUDIT_ACTIONS]],
  )
  return Number(result.rows[0]?.total ?? '0')
}

test('a finance reader lists only the finance actions while the owner reads the whole log', async () => {
  const response = await accountant.fetch(`/api/schools/${schoolA}/audit-events?pageSize=100`)
  assert.equal(response.status, 200)
  const page = (await response.json()) as EventPage
  assert.ok(page.items.length > 0, 'the accountant reads the finance rows')
  for (const item of page.items) {
    assert.ok(
      isFinanceAuditAction(item.action),
      `${item.action} is not a finance action`,
    )
  }
  assert.ok(page.items.some((item) => item.summary === summaryA(5)))
  assert.ok(page.items.some((item) => item.summary === summaryA(6)))
  // The count is the same narrowed set, so a total can never exceed the rows
  // the reader may page over.
  assert.equal(page.total, await financeRowCount())
  // The trail is append-only and this database is reused, so the page holds
  // the whole narrowed set only while that set fits one page.
  assert.equal(page.items.length, Math.min(page.total, 100))

  const ownerPage = (await (
    await owner.fetch(`/api/schools/${schoolA}/audit-events?pageSize=100`)
  ).json()) as EventPage
  assert.ok(
    ownerPage.items.some((item) => !isFinanceAuditAction(item.action)),
    'the owner still reads non finance actions',
  )
  assert.ok(ownerPage.total > page.total)
  assert.equal(JSON.stringify(page).includes(summaryA(1)), false)
})

test('the finance reader keeps its filters on top of the narrowed rows', async () => {
  const byAction = (await (
    await accountant.fetch(`/api/schools/${schoolA}/audit-events?action=staff.update_pay&pageSize=100`)
  ).json()) as EventPage
  assert.ok(byAction.total >= 1)
  for (const item of byAction.items) assert.equal(item.action, 'staff.update_pay')

  // A non finance action is not readable even when it is asked for by name.
  const hidden = (await (
    await accountant.fetch(`/api/schools/${schoolA}/audit-events?action=members.roles.change&pageSize=100`)
  ).json()) as EventPage
  assert.equal(hidden.total, 0)
  assert.deepEqual(hidden.items, [])

  const byActor = (await (
    await accountant.fetch(
      `/api/schools/${schoolA}/audit-events?actorMembershipId=${accountantMembershipId}&pageSize=100`,
    )
  ).json()) as EventPage
  assert.ok(byActor.items.some((item) => item.summary === summaryA(6)))
  for (const item of byActor.items) {
    assert.ok(isFinanceAuditAction(item.action))
  }
  assert.equal(byActor.items.some((item) => item.summary === summaryA(5)), false)
})

test('a finance export counts only the finance rows and the owner export counts more', async () => {
  const window = {
    from: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  }
  const expected = await financeRowCount()
  const financeJob = await accountant.fetch(`/api/schools/${schoolA}/audit-events/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(window),
  })
  assert.equal(financeJob.status, 202)
  const financeId = ((await financeJob.json()) as { id: string }).id
  const financeRow = await adminPool().query<{ row_count: number }>(
    `SELECT row_count FROM export_jobs WHERE id = $1`,
    [financeId],
  )
  assert.equal(financeRow.rows[0]?.row_count, expected)

  const ownerJob = await owner.fetch(`/api/schools/${schoolA}/audit-events/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(window),
  })
  assert.equal(ownerJob.status, 202)
  const ownerId = ((await ownerJob.json()) as { id: string }).id
  const ownerRow = await adminPool().query<{ row_count: number }>(
    `SELECT row_count FROM export_jobs WHERE id = $1`,
    [ownerId],
  )
  assert.ok(
    (ownerRow.rows[0]?.row_count ?? 0) > (financeRow.rows[0]?.row_count ?? 0),
    'the owner export covers the whole log',
  )

  await adminPool().query(`DELETE FROM export_jobs WHERE id = ANY($1::uuid[])`, [[financeId, ownerId]])
})

test('a reason is stored as a redactable note and never in safe_changes', async () => {
  const pool = adminPool()
  // A membership of its own, so changing its roles disturbs no other test.
  const targetUserId = randomUUID()
  await pool.query(`INSERT INTO auth_user (id, name, email) VALUES ($1, $2, $3)`, [
    targetUserId,
    'Audit Note Target',
    `audit-note-${randomUUID()}@example.test`,
  ])
  const targetMembershipId = randomUUID()
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [targetMembershipId, schoolA, targetUserId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)`,
    [schoolA, targetMembershipId, await roleIdFor(schoolA, 'teacher')],
  )

  const reason = `Moved to the office desk ${MARK}`
  const changed = await owner.fetch(`/api/schools/${schoolA}/members/${targetMembershipId}/roles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ roleKeys: ['accountant'], expectedVersion: 1, reason }),
  })
  assert.equal(changed.status, 200)

  // The permanent row carries the structure of the change and nothing a person
  // typed; the note lives in the table that can be redacted.
  const stored = await pool.query<{ id: string; safe_changes: Record<string, unknown> }>(
    `SELECT id, safe_changes FROM audit_events
      WHERE school_id = $1 AND action = 'roles.assign' AND target_id = $2::uuid`,
    [schoolA, targetMembershipId],
  )
  assert.equal(stored.rows.length, 1)
  const eventId = stored.rows[0]?.id ?? ''
  assert.equal(JSON.stringify(stored.rows[0]?.safe_changes).includes(reason), false)
  assert.equal('reason' in (stored.rows[0]?.safe_changes ?? {}), false)

  const withNote = await owner.fetch(`/api/schools/${schoolA}/audit-events?action=roles.assign`)
  assert.equal(withNote.status, 200)
  const page = (await withNote.json()) as EventPage
  const row = page.items.find((item) => item.id === eventId)
  assert.equal(row?.note, reason)

  // A principal holds audit.read but not audit.redact_notes.
  const refused = await principal.fetch(
    `/api/schools/${schoolA}/audit-events/${eventId}/note/redact`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'The parent asked for the text to be removed' }),
    },
  )
  assert.equal(refused.status, 403)
  assert.equal(((await refused.json()) as ErrorBody).error.code, 'ACCESS_DENIED')

  const redacted = await owner.fetch(
    `/api/schools/${schoolA}/audit-events/${eventId}/note/redact`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'The parent asked for the text to be removed' }),
    },
  )
  assert.equal(redacted.status, 200)
  assert.deepEqual(await redacted.json(), { status: 'redacted' })

  const after = await owner.fetch(`/api/schools/${schoolA}/audit-events?action=roles.assign`)
  const afterPage = (await after.json()) as EventPage
  assert.equal(afterPage.items.find((item) => item.id === eventId)?.note, undefined)
  // The event itself is untouched.
  assert.ok(afterPage.items.some((item) => item.id === eventId))

  const redactionRow = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events
      WHERE school_id = $1 AND action = 'audit.redact_notes' AND target_id = $2::uuid`,
    [schoolA, eventId],
  )
  assert.equal(redactionRow.rows[0]?.count, '1')
})
