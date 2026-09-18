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
const OWNER_EMAIL = `consents-owner-${randomUUID()}@example.test`
const PARENT_EMAIL = `consents-parent-${randomUUID()}@example.test`
const TEACHER_EMAIL = `consents-teacher-${randomUUID()}@example.test`

const schoolA = fixtureIds.schoolA as string
const studentA = fixtureIds.studentA as string
const studentA2 = fixtureIds.studentA2 as string
const guardianA = fixtureIds.guardianA as string
const guardianA2 = fixtureIds.guardianA2 as string
const ownerUserId = fixtureIds.ownerAUser as string
const parentUserId = fixtureIds.parentA2User as string

// Rows this file owns.
const teacherUser = '10000000-0000-4000-8000-0000000009c1'
const teacherMembership = '10000000-0000-4000-8000-0000000009c2'

let server: TestServer
type Client = Awaited<ReturnType<typeof signInWithMfa>>
let owner: Client
let parent: Client
let teacher: Client

interface ConsentItem {
  id: string
  guardianId: string
  guardianDisplayName: string
  purpose: string
  status: string
  method: string
  recordedBy: string
}
interface ConsentListBody {
  items: ConsentItem[]
  allowedActions: string[]
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

async function codeOf(response: Response): Promise<string> {
  return (await body<{ error: { code: string } }>(response)).error.code
}

function post(client: Client, studentId: string, payload: unknown): Promise<Response> {
  return client.fetch(`/api/schools/${schoolA}/students/${studentId}/consents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function countConsents(studentId: string): Promise<number> {
  return adminPool()
    .query<{ count: string }>('SELECT count(*)::text AS count FROM guardian_consents WHERE student_id = $1', [studentId])
    .then((result) => Number(result.rows[0]?.count ?? '0'))
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const pool = adminPool()
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [ownerUserId, OWNER_EMAIL])
  await pool.query('UPDATE auth_user SET email = $2 WHERE id = $1', [parentUserId, PARENT_EMAIL])
  // A teacher of this school holds neither consent permission.
  await pool.query(
    `INSERT INTO auth_user(id,name,email) VALUES ($1,'Consent Teacher',$2)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email`,
    [teacherUser, TEACHER_EMAIL],
  )
  await pool.query(
    `INSERT INTO school_memberships(id,school_id,user_id,kind,status) VALUES ($1,$2,$3,'adult','active')
     ON CONFLICT (school_id,user_id) DO NOTHING`,
    [teacherMembership, schoolA, teacherUser],
  )
  await pool.query(
    `INSERT INTO membership_roles(school_id,membership_id,role_id)
     SELECT $1,$2,id FROM roles WHERE school_id = $1 AND key = 'teacher' ON CONFLICT DO NOTHING`,
    [schoolA, teacherMembership],
  )
  await setFixturePassword(server, parentUserId, PASSWORD)
  await setFixturePassword(server, teacherUser, PASSWORD)
  owner = await signInWithMfa(server, { userId: ownerUserId, email: OWNER_EMAIL, password: PASSWORD })
  // students.manage_consents is privileged at every scope, so even a parent
  // recording for her own child must have passed two-step verification.
  parent = await signInWithMfa(server, { userId: parentUserId, email: PARENT_EMAIL, password: PASSWORD })
  teacher = await signInWithPassword(server, TEACHER_EMAIL, PASSWORD)
})

after(async () => {
  const pool = adminPool()
  for (const userId of [ownerUserId, parentUserId]) {
    await pool.query('DELETE FROM auth_two_factor WHERE user_id = $1', [userId])
    await pool.query('UPDATE auth_user SET two_factor_enabled = false WHERE id = $1', [userId])
  }
  await server.close()
  await closeAdminPool()
})

test('the office records a consent for a linked guardian', async () => {
  const response = await post(owner, studentA, {
    guardianId: guardianA,
    purpose: 'photographs',
    status: 'given',
    method: 'signed_form',
    evidenceReference: 'Form 12/2026',
  })
  assert.equal(response.status, 200)
  const list = await body<ConsentListBody>(response)
  const row = list.items.find((item) => item.purpose === 'photographs' && item.guardianId === guardianA)
  assert.ok(row)
  assert.equal(row.status, 'given')
  assert.equal(row.method, 'signed_form')
  assert.equal(row.recordedBy, 'office')
  assert.ok(row.guardianDisplayName.length > 0)

  const read = await owner.fetch(`/api/schools/${schoolA}/students/${studentA}/consents`)
  assert.equal(read.status, 200)
  assert.equal((await body<ConsentListBody>(read)).items.some((item) => item.id === row.id), true)
})

test('a guardian who is not linked to this student is a bad request and writes nothing', async () => {
  const before = await countConsents(studentA)
  const response = await post(owner, studentA, {
    // Guardian A2 is linked to student A2 only in this fixture school.
    guardianId: randomUUID(),
    purpose: 'communication',
    status: 'given',
    method: 'in_person',
  })
  assert.equal(response.status, 400)
  assert.equal(await codeOf(response), 'INVALID_REQUEST')
  assert.equal(await countConsents(studentA), before)
})

test('a parent records and withdraws for her own child through the portal', async () => {
  const given = await post(parent, studentA2, {
    guardianId: guardianA2,
    purpose: 'health_information',
    status: 'given',
    // What the parent sends is ignored: a portal answer is a portal answer.
    method: 'in_person',
  })
  assert.equal(given.status, 200)
  const first = (await body<ConsentListBody>(given)).items.find(
    (item) => item.purpose === 'health_information',
  )
  assert.ok(first)
  assert.equal(first.status, 'given')
  assert.equal(first.method, 'portal')
  assert.equal(first.recordedBy, 'guardian')

  const withdrawn = await post(parent, studentA2, {
    guardianId: guardianA2,
    purpose: 'health_information',
    status: 'withdrawn',
    method: 'in_person',
  })
  assert.equal(withdrawn.status, 200)
  const current = (await body<ConsentListBody>(withdrawn)).items.filter(
    (item) => item.purpose === 'health_information' && item.guardianId === guardianA2,
  )
  // Only the newest row per guardian and purpose is returned.
  assert.equal(current.length, 1)
  assert.equal(current[0]?.status, 'withdrawn')

  // The office sees what the parent recorded.
  const office = await owner.fetch(`/api/schools/${schoolA}/students/${studentA2}/consents`)
  assert.equal(office.status, 200)
  assert.equal(
    (await body<ConsentListBody>(office)).items.some(
      (item) => item.purpose === 'health_information' && item.recordedBy === 'guardian',
    ),
    true,
  )
})

test('a parent is refused for another family\'s child', async () => {
  const read = await parent.fetch(`/api/schools/${schoolA}/students/${studentA}/consents`)
  assert.equal(read.status, 404)
  assert.equal(await codeOf(read), 'RESOURCE_NOT_FOUND')

  const before = await countConsents(studentA)
  const write = await post(parent, studentA, {
    guardianId: guardianA2,
    purpose: 'photographs',
    status: 'given',
    method: 'portal',
  })
  assert.equal(write.status, 404)
  assert.equal(await codeOf(write), 'RESOURCE_NOT_FOUND')
  assert.equal(await countConsents(studentA), before)
})

test('a teacher may not read the consent list', async () => {
  const read = await teacher.fetch(`/api/schools/${schoolA}/students/${studentA}/consents`)
  assert.equal(read.status >= 400, true)
  assert.equal(await codeOf(read), 'ACCESS_DENIED')
})
