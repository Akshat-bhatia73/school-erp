import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
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
const OWNER_EMAIL = `members-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `members-parent-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithPassword>>
let owner: Client
let parent: Client

interface ErrorBody {
  error: { code: string; requestId: string }
}
interface MemberItem {
  id: string
  displayName: string
  status: string
  roleKeys: string[]
  accessVersion: number
  staffId?: string
}
interface MemberPage {
  items: MemberItem[]
  total: number
  page: number
  pageSize: number
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    ownerUserId,
    OWNER_EMAIL,
  ])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [
    parentUserId,
    PARENT_EMAIL,
  ])
  await setFixturePassword(server, parentUserId, PASSWORD)
  owner = await signInWithMfa(server, {
    userId: ownerUserId,
    email: OWNER_EMAIL,
    password: PASSWORD,
  })
  parent = await signInWithPassword(server, PARENT_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [
    ownerUserId,
  ])
  await pool.query(
    'UPDATE auth_user SET two_factor_enabled = false WHERE id = $1',
    [ownerUserId],
  )
  await server.close()
  await closeAdminPool()
})

test('an owner reads the school membership directory', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/members`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as MemberPage
  assert.ok(body.items.length > 0)
  assert.ok(body.total >= body.items.length)
  assert.equal(body.page, 1)
  assert.equal(body.pageSize, 25)

  const ownerRow = body.items.find((item) => item.id === fixtureIds.ownerA)
  assert.ok(ownerRow, 'the owner appears in its own school directory')
  assert.deepEqual(ownerRow.roleKeys, ['owner'])
  assert.equal(ownerRow.status, 'active')
  assert.ok(ownerRow.displayName.length > 0)

  // Suspended people stay visible, so their access can be reviewed.
  const suspended = body.items.find((item) => item.id === fixtureIds.suspended)
  assert.ok(suspended)
  assert.equal(suspended.status, 'suspended')

  // The staff linked membership shows the school's own staff name.
  const staffMember = body.items.find((item) => item.id === fixtureIds.adult)
  assert.ok(staffMember)
  assert.equal(staffMember.staffId, fixtureIds.staffA)
  assert.equal(staffMember.displayName, 'Fixture')
})

test('the page size is honoured and an invalid one is refused', async () => {
  const first = await owner.fetch(`/api/schools/${schoolA}/members?page=1&pageSize=1`)
  assert.equal(first.status, 200)
  const body = (await first.json()) as MemberPage
  assert.equal(body.items.length, 1)
  assert.equal(body.pageSize, 1)
  assert.ok(body.total >= 2)

  const second = await owner.fetch(`/api/schools/${schoolA}/members?page=2&pageSize=1`)
  const secondBody = (await second.json()) as MemberPage
  assert.notEqual(secondBody.items[0]?.id, body.items[0]?.id)

  const bad = await owner.fetch(`/api/schools/${schoolA}/members?pageSize=abc`)
  assert.equal(bad.status, 400)
  assert.equal(((await bad.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
})

test('a member of one school cannot read another school directory', async () => {
  const response = await owner.fetch(`/api/schools/${schoolB}/members`)
  assert.equal(response.status, 403)
  assert.equal(
    ((await response.json()) as ErrorBody).error.code,
    'SCHOOL_ACCESS_UNAVAILABLE',
  )
})

test('a parent has no permission to read the directory', async () => {
  const response = await parent.fetch(`/api/schools/${schoolA}/members`)
  assert.equal(response.status, 403)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
})

test('an anonymous caller is not told anything', async () => {
  const response = await fetch(
    `${server.origin}/api/schools/${schoolA}/members`,
    { headers: { origin: server.origin } },
  )
  assert.equal(response.status, 401)
  assert.equal(
    ((await response.json()) as ErrorBody).error.code,
    'AUTHENTICATION_REQUIRED',
  )
})

test('an owner can explain another membership access decision', async () => {
  const query =
    `?permission=students.read_basic&resourceType=student&resourceId=${fixtureIds.studentA}`
  const path = `/api/schools/${schoolA}/members/${fixtureIds.adult}/access-explanation`
  const response = await owner.fetch(`${path}${query}`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    allowed: boolean
    sources: { kind: string; description: string }[]
  }
  assert.equal(typeof body.allowed, 'boolean')
  assert.ok(Array.isArray(body.sources))
  assert.ok(body.sources.length > 0)

  // The resource type has to match the permission being explained.
  const mismatched = await owner.fetch(
    `${path}?permission=students.read_basic&resourceType=staff&resourceId=${fixtureIds.staffA}`,
  )
  assert.equal(mismatched.status, 400)
  assert.equal(
    ((await mismatched.json()) as ErrorBody).error.code,
    'INVALID_REQUEST',
  )

  const denied = await parent.fetch(`${path}${query}`)
  assert.equal(denied.status, 403)
  assert.equal(((await denied.json()) as ErrorBody).error.code, 'ACCESS_DENIED')
})

/** A membership of school A with a name of this run's choosing. */
async function createNamedMember(name: string): Promise<string> {
  const pool = adminPool()
  const userId = randomUUID()
  const membershipId = randomUUID()
  await pool.query(
    `INSERT INTO auth_user (id, name, email) VALUES ($1, $2, $3)`,
    [userId, name, `members-${userId}@example.test`],
  )
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [membershipId, schoolA, userId],
  )
  await pool.query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = 'teacher'`,
    [schoolA, membershipId],
  )
  return membershipId
}

async function listMembers(query: string): Promise<MemberPage> {
  const response = await owner.fetch(`/api/schools/${schoolA}/members${query}`)
  assert.equal(response.status, 200)
  return (await response.json()) as MemberPage
}

test('each directory filter narrows both the page and its total', async () => {
  const all = await listMembers('?pageSize=100')

  // Status: suspended people stay in the directory, and asking for them only
  // answers with them.
  const suspended = await listMembers('?pageSize=100&status=suspended')
  assert.ok(suspended.items.length > 0)
  assert.equal(suspended.total, suspended.items.length)
  assert.ok(suspended.total < all.total)
  assert.equal(suspended.items.every((item) => item.status === 'suspended'), true)
  assert.ok(suspended.items.some((item) => item.id === fixtureIds.suspended))

  // Role: the key asked for is one of the keys every answering row reports.
  const owners = await listMembers('?pageSize=100&role=owner')
  assert.ok(owners.total < all.total)
  assert.equal(owners.items.every((item) => item.roleKeys.includes('owner')), true)
  assert.ok(owners.items.some((item) => item.id === fixtureIds.ownerA))

  // Staff id: the one membership that staff profile belongs to.
  const linked = await listMembers(`?pageSize=100&staffId=${fixtureIds.staffA}`)
  assert.equal(linked.total, 1)
  assert.equal(linked.items[0]?.id, fixtureIds.adult)

  // Search finds a person named only by their login, with no staff or
  // guardian record behind them.
  const byLogin = await listMembers('?pageSize=100&search=Owner A')
  assert.ok(byLogin.total < all.total)
  assert.equal(byLogin.total, byLogin.items.length)
  assert.ok(byLogin.items.some((item) => item.id === fixtureIds.ownerA))

  // And a person named by the school's own staff record.
  const byStaffName = await listMembers('?pageSize=100&search=Fixtur')
  assert.ok(byStaffName.items.some((item) => item.id === fixtureIds.adult))
})

test('a wildcard character in the search is looked for literally', async () => {
  const suffix = randomUUID().slice(0, 8)
  const percent = await createNamedMember(`Per%cent ${suffix}`)
  const underscore = await createNamedMember(`Under_score ${suffix}`)

  const literal = await listMembers(`?pageSize=100&search=Per%25cent ${suffix}`)
  assert.equal(literal.total, 1)
  assert.equal(literal.items[0]?.id, percent)

  // If the underscore were a wildcard this would match "Per%cent".
  const wildcard = await listMembers(`?pageSize=100&search=Per_cent ${suffix}`)
  assert.equal(wildcard.total, 0)
  assert.deepEqual(wildcard.items, [])

  const kept = await listMembers(`?pageSize=100&search=Under_score ${suffix}`)
  assert.equal(kept.total, 1)
  assert.equal(kept.items[0]?.id, underscore)

  // A bare percent sign finds only the names that really contain one.
  const signs = await listMembers('?pageSize=100&search=%25')
  assert.equal(signs.items.every((item) => item.displayName.includes('%')), true)
})

test('an unknown query key is refused', async () => {
  const response = await owner.fetch(`/api/schools/${schoolA}/members?department=maths`)
  assert.equal(response.status, 400)
  assert.equal(((await response.json()) as ErrorBody).error.code, 'INVALID_REQUEST')

  const badStatus = await owner.fetch(`/api/schools/${schoolA}/members?status=asleep`)
  assert.equal(badStatus.status, 400)
  assert.equal(((await badStatus.json()) as ErrorBody).error.code, 'INVALID_REQUEST')
})

test('a staff id of another school finds nobody through this school path', async () => {
  const staffB = randomUUID()
  await adminPool().query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Neighbour', 'teaching', 'Teacher', 'active')`,
    [staffB, schoolB, `B-E-${staffB.slice(0, 6)}`],
  )
  const page = await listMembers(`?pageSize=100&staffId=${staffB}`)
  assert.equal(page.total, 0)
  assert.deepEqual(page.items, [])
})
