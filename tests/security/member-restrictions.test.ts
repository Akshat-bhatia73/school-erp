/**
 * Matrix rows: member restrictions.
 *
 * A restriction takes one kind of student information away from one member
 * of staff. This file asks the adversarial questions: an id from the school
 * next door reads exactly like an id that was never real, a member without
 * access.manage is refused on every route, a restricted admin's export
 * carries no full guardian record because the producer re-reads under their
 * own plan while the guardian contact card stays, and a restricted accountant
 * still does the fee work their role gives.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import { withTenantTransaction } from '@erp/db'
import type { RoleKey } from '@erp/contracts'
import { createRequestContext } from '../../apps/api/src/auth/request-context.ts'
import { buildStudentProfileModel } from '../../apps/api/src/exports/producers/student-profile.ts'
import {
  adminPool,
  closeAdminPool,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createMember,
  forgetTwoFactor,
  postBody,
  putBody,
  signInMember,
  signInOffice,
  writeExceptionRule,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const ownerB = fixtureIds.ownerB as string
const parentB = fixtureIds.parentB as string
const yearA = fixtureIds.yearA as string
const sectionA = fixtureIds.sectionA as string

let server: TestServer
let owner: Member
let ownerClient: Client
let office: Member
let officeClient: Client
let accountant: Member
let accountantClient: Client
let teacher: Member
let teacherClient: Client
let pupil = ''
let guardian = ''

const GUARDIAN_PAN = 'ABCPE4821K'
const GUARDIAN_AADHAAR = '200000007919'
const OFFICE_ADDRESS = 'Tower Nine, Cyber Park, Gurugram'

interface RestrictionBody {
  id: string
  version: number
}

function membersPath(membershipId: string, school = schoolA): string {
  return `/api/schools/${school}/members/${membershipId}/restrictions`
}

async function accessVersionOf(membershipId: string): Promise<number> {
  const result = await adminPool().query<{ access_version: number }>(
    'SELECT access_version FROM school_memberships WHERE id = $1',
    [membershipId],
  )
  return Number(result.rows[0]?.access_version ?? 1)
}

async function restrict(
  client: Client,
  membershipId: string,
  permission: string,
  school = schoolA,
): Promise<Response> {
  return client.fetch(
    membersPath(membershipId, school),
    postBody({
      permission,
      reason: 'Security acceptance suite',
      expectedAccessVersion: await accessVersionOf(membershipId),
    }),
  )
}

async function contextFor(member: Member) {
  const found = await adminPool().query<{ id: string; access_version: number; keys: string[] }>(
    `SELECT m.id, m.access_version,
            coalesce(array_agg(r.key) FILTER (WHERE r.key IS NOT NULL), '{}') AS keys
       FROM school_memberships m
       LEFT JOIN membership_roles mr ON mr.membership_id = m.id
       LEFT JOIN roles r ON r.id = mr.role_id
      WHERE m.id = $1
      GROUP BY m.id`,
    [member.membershipId],
  )
  const row = found.rows[0]
  assert.ok(row)
  return createRequestContext({
    requestId: randomUUID(),
    userId: member.userId,
    sessionId: randomUUID(),
    schoolId: schoolA,
    membershipId: row.id,
    membershipKind: 'adult',
    accessVersion: Number(row.access_version),
    roleKeys: row.keys as RoleKey[],
    assurance: 'mfa',
    mfaVerifiedAt: new Date().toISOString(),
  })
}

async function profileModelFor(member: Member) {
  const context = await contextFor(member)
  return withTenantTransaction(server.pools.runtime, context, async (conn) =>
    buildStudentProfileModel(conn, context, pupil),
  )
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  owner = await createMember(schoolA, ['owner'], 'Restriction Owner')
  ownerClient = await signInOffice(server, owner)
  office = await createMember(schoolA, ['admin'], 'Restriction Admin')
  officeClient = await signInOffice(server, office)
  accountant = await createMember(schoolA, ['accountant'], 'Restriction Accountant')
  accountantClient = await signInOffice(server, accountant)
  teacher = await createMember(schoolA, ['teacher'], 'Restriction Teacher')
  teacherClient = await signInMember(server, teacher)

  const pool = adminPool()
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO students
       (school_id, admission_number, first_name, last_name, status, date_of_birth, gender, admission_date)
     VALUES ($1, $2, 'Guarded', 'Contact', 'active', '2014-06-01', 'male', '2020-04-01')
     RETURNING id`,
    [schoolA, `RSEC-${randomUUID().slice(0, 8)}`],
  )
  pupil = inserted.rows[0]?.id as string
  await pool.query(
    `INSERT INTO enrollments (school_id, student_id, academic_year_id, section_id, joined_on)
     VALUES ($1, $2, $3, $4, current_date)`,
    [schoolA, pupil, yearA, sectionA],
  )
  guardian = randomUUID()
  await pool.query(
    `INSERT INTO guardians (id, school_id, first_name, last_name, phone)
     VALUES ($1, $2, 'Lata', 'Contact', '+919812300099')`,
    [guardian, schoolA],
  )
  await pool.query(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relation, is_primary)
     VALUES ($1, $2, $3, 'mother', true)`,
    [schoolA, pupil, guardian],
  )
  // The full guardian record: sealed PAN and Aadhaar and an office address,
  // written through the route the office uses.
  const guardianVersion = await pool.query<{ version: number }>(
    'SELECT version FROM guardians WHERE id = $1',
    [guardian],
  )
  const updated = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${pupil}/guardians/${guardian}`,
    putBody({
      expectedVersion: Number(guardianVersion.rows[0]?.version),
      pan: GUARDIAN_PAN,
      aadhaar: GUARDIAN_AADHAAR,
      officeAddress: OFFICE_ADDRESS,
    }),
  )
  assert.equal(updated.status, 200)
})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM enrollments WHERE school_id = $1 AND student_id = $2', [schoolA, pupil])
  await forgetTwoFactor([owner.userId, office.userId, accountant.userId])
  await server.close()
  await closeAdminPool()
})

test('[member-restrictions] an id from another school answers exactly like one that was never real', async () => {
  const neverReal = randomUUID()
  // A member of school B, asked about through school A.
  for (const target of [ownerB, parentB, neverReal]) {
    const listed = await ownerClient.fetch(membersPath(target))
    assert.equal(listed.status, 404)
    assert.equal(await codeOf(listed), 'RESOURCE_NOT_FOUND')
    const added = await ownerClient.fetch(
      membersPath(target),
      postBody({ permission: 'students.read_medical', reason: 'Crossing schools', expectedAccessVersion: 1 }),
    )
    assert.equal(added.status, 404)
    assert.equal(await codeOf(added), 'RESOURCE_NOT_FOUND')
    const lifted = await ownerClient.fetch(
      `${membersPath(target)}/${randomUUID()}/lift`,
      postBody({ expectedVersion: 1, reason: 'Crossing schools' }),
    )
    assert.equal(lifted.status, 404)
    assert.equal(await codeOf(lifted), 'RESOURCE_NOT_FOUND')
  }

  // A real rule of school B, lifted through a real member of school A.
  const ruleB = await writeExceptionRule({
    schoolId: schoolB,
    membershipId: parentB,
    permission: 'students.read_medical',
    effect: 'deny',
    targetType: 'school',
    authorMembershipId: ownerB,
  })
  const crossLift = await ownerClient.fetch(
    `${membersPath(teacher.membershipId)}/${ruleB}/lift`,
    postBody({ expectedVersion: 1, reason: 'Crossing schools' }),
  )
  assert.equal(crossLift.status, 404)
  assert.equal(await codeOf(crossLift), 'RESOURCE_NOT_FOUND')

  // And school B's own path is not open to a member of school A at all.
  const otherPath = await ownerClient.fetch(membersPath(parentB, schoolB))
  assert.ok(otherPath.status === 403 || otherPath.status === 404, `status ${otherPath.status}`)

  const untouched = await adminPool().query<{ revoked_at: Date | null; version: number }>(
    'SELECT revoked_at, version FROM resource_access_rules WHERE id = $1',
    [ruleB],
  )
  assert.equal(untouched.rows[0]?.revoked_at, null)
  assert.equal(Number(untouched.rows[0]?.version), 1)
  const written = await adminPool().query(
    `SELECT 1 FROM resource_access_rules WHERE membership_id = ANY($1::uuid[])`,
    [[ownerB, neverReal]],
  )
  assert.equal(written.rowCount, 0)
})

test('[member-restrictions] a rule of another member of the same school is not found', async () => {
  const colleague = await createMember(schoolA, ['teacher'], 'Other Teacher')
  const response = await restrict(ownerClient, colleague.membershipId, 'students.read_guardians')
  assert.equal(response.status, 201)
  const rule = await body<RestrictionBody>(response)
  const wrongMember = await ownerClient.fetch(
    `${membersPath(teacher.membershipId)}/${rule.id}/lift`,
    postBody({ expectedVersion: rule.version, reason: 'Wrong member' }),
  )
  assert.equal(wrongMember.status, 404)
  assert.equal(await codeOf(wrongMember), 'RESOURCE_NOT_FOUND')
})

test('[member-restrictions] a member without access.manage is refused on every route', async () => {
  const target = await createMember(schoolA, ['teacher'], 'Target Teacher')
  const created = await body<RestrictionBody>(
    await restrict(ownerClient, target.membershipId, 'students.read_guardians'),
  )
  const before = await accessVersionOf(target.membershipId)

  for (const client of [teacherClient, accountantClient, officeClient]) {
    const listed = await client.fetch(membersPath(target.membershipId))
    assert.equal(listed.status, 403)
    assert.equal(await codeOf(listed), 'ACCESS_DENIED')
    const added = await restrict(client, target.membershipId, 'students.read_medical')
    assert.equal(added.status, 403)
    assert.equal(await codeOf(added), 'ACCESS_DENIED')
    const lifted = await client.fetch(
      `${membersPath(target.membershipId)}/${created.id}/lift`,
      postBody({ expectedVersion: created.version, reason: 'Not mine to lift' }),
    )
    assert.equal(lifted.status, 403)
    assert.equal(await codeOf(lifted), 'ACCESS_DENIED')
  }
  assert.equal(await accessVersionOf(target.membershipId), before)
  const rule = await adminPool().query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM resource_access_rules WHERE id = $1',
    [created.id],
  )
  assert.equal(rule.rows[0]?.revoked_at, null)
})

test('[member-restrictions] a restricted admin gets no full guardian record on any route or in the exported profile, but keeps the contact card', async () => {
  const detailPath = `/api/schools/${schoolA}/students/${pupil}`
  const identityPath = `${detailPath}/guardians/${guardian}/identity`
  const beforeGuardians = await officeClient.fetch(`${detailPath}/guardians`)
  assert.equal(beforeGuardians.status, 200)
  assert.equal((await beforeGuardians.text()).includes(OFFICE_ADDRESS), true)
  const beforeReveal = await officeClient.fetch(identityPath)
  assert.equal(beforeReveal.status, 200)
  assert.equal((await body<{ pan?: string }>(beforeReveal)).pan, GUARDIAN_PAN)
  const beforeModel = await profileModelFor(office)
  assert.equal(beforeModel.guardians.length, 1)
  assert.equal(beforeModel.guardianPrivate.length, 1)
  assert.equal(beforeModel.guardianPrivate[0]?.officeAddress, OFFICE_ADDRESS)
  assert.equal(beforeModel.guardianPrivate[0]?.panLast4, GUARDIAN_PAN.slice(-4))

  const response = await restrict(ownerClient, office.membershipId, 'students.read_guardians')
  assert.equal(response.status, 201)

  // The full guardian records and the identity reveal are refused outright.
  const guardians = await officeClient.fetch(`${detailPath}/guardians`)
  assert.equal(guardians.status, 403)
  assert.equal(await codeOf(guardians), 'ACCESS_DENIED')
  const reveal = await officeClient.fetch(identityPath)
  assert.equal(reveal.status, 403)
  assert.equal(await codeOf(reveal), 'ACCESS_DENIED')

  // The contact card is a different key and still works.
  const afterDetail = await officeClient.fetch(detailPath)
  assert.equal(afterDetail.status, 200)
  const afterText = await afterDetail.text()
  assert.equal((JSON.parse(afterText) as { guardianContacts?: unknown[] }).guardianContacts?.length, 1)
  assert.equal(afterText.includes('9812300099'), true)
  assert.equal(afterText.includes(OFFICE_ADDRESS), false)
  assert.equal(afterText.includes(GUARDIAN_PAN), false)

  // The export still runs, and the producer re-reads the record under the
  // requester's own plan, so the printed record has the contact card and no
  // PAN, Aadhaar or office address.
  const exported = await officeClient.fetch(`${detailPath}/export-profile`, postBody({}))
  assert.equal(exported.status, 202)
  assert.equal((await body<{ status: string }>(exported)).status, 'ready')
  const afterModel = await profileModelFor(office)
  assert.equal(afterModel.guardianPrivate.length, 0)
  assert.equal(afterModel.guardians.length, 1)
  const printed = JSON.stringify(afterModel)
  assert.equal(printed.includes(OFFICE_ADDRESS), false)
  assert.equal(printed.includes('panLast4'), false)
  assert.equal(printed.includes(GUARDIAN_AADHAAR.slice(-4)), false)
  // Everything else about the record is still there.
  assert.equal(afterModel.student.id, pupil)
  assert.notEqual(afterModel.sensitive, undefined)
})

test('[member-restrictions] a restricted accountant keeps doing the fee work', async () => {
  // The accountant holds none of the restrictable keys; the restriction is
  // still accepted, so it is in place should their role ever widen.
  const response = await restrict(ownerClient, accountant.membershipId, 'students.read_guardians')
  assert.equal(response.status, 201)

  const context = await accountantClient.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(context.status, 200)
  const capabilities = (await body<{ capabilities: string[] }>(context)).capabilities
  assert.equal(capabilities.includes('students.read_guardians'), false)
  // Guardian phone numbers for fee follow-up are not restrictable and stay.
  assert.equal(capabilities.includes('students.read_guardian_contact'), true)
  assert.equal(capabilities.includes('fees.read'), true)
  assert.equal(capabilities.includes('fees.collect'), true)

  const heads = await accountantClient.fetch(`/api/schools/${schoolA}/fees/heads`)
  assert.equal(heads.status, 200)
  const dues = await accountantClient.fetch(
    `/api/schools/${schoolA}/fees/dues?academicYearId=${yearA}&pageSize=100`,
  )
  assert.equal(dues.status, 200)
  const receipts = await accountantClient.fetch(`/api/schools/${schoolA}/fees/receipts`)
  assert.equal(receipts.status, 200)
})
