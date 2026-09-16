/**
 * Matrix rows: client-identity-tampering, student-policy-fixtures.
 *
 * Identity is decided by the server from the session cookie. These tests send
 * the values a tampered client would send — a membership id, a user id, role
 * keys, another school id — and check that the decided identity, the granted
 * permissions and the stored rows are all exactly what they were.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import { PERMISSION_CATALOGUE, ROLE_TEMPLATES } from '@erp/contracts'
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
  createEnrolledStudent,
  createMember,
  createTeacher,
  ensureSection,
  ensureSubject,
  forgetTwoFactor,
  grantRoles,
  postBody,
  putBody,
  signInMember,
  signInOffice,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const schoolB = fixtureIds.schoolB as string
const studentA = fixtureIds.studentA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string

let server: TestServer
let owner: Member
let ownerClient: Client
let teacherMember: Member
let teacher: Client

interface Context {
  school: { id: string }
  membershipId: string
  roleKeys: string[]
  capabilities: unknown
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  owner = await createMember(schoolA, ['owner'], 'Tamper Owner')
  ownerClient = await signInOffice(server, owner)
  const suffix = Math.random().toString(36).slice(2, 10)
  const subjectId = await ensureSubject(schoolA, `TAM-SUB-${suffix}`)
  const sectionId = await ensureSection(schoolA, yearA, gradeA, `TAM-${suffix}`)
  await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId,
    firstName: 'Tamper Pupil',
    admissionNumber: `TAM/${suffix}/1`,
    rollNumber: 5,
  })
  const created = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionId],
    subjectId,
    employeeCode: `TAM-T-${suffix}`,
  })
  await grantRoles(schoolA, created.membershipId, ['parent'])
  teacherMember = created
  teacher = await signInMember(server, created)
})

after(async () => {
  await forgetTwoFactor([owner.userId])
  await server.close()
  await closeAdminPool()
})

test('[client-identity-tampering] a query cannot name another membership or another role', async () => {
  // The honest request first, so a server that refused everything would fail.
  const honest = await teacher.fetch(`/api/schools/${schoolA}/students?pageSize=10`)
  assert.equal(honest.status, 200)

  for (const query of [
    `membershipId=${owner.membershipId}`,
    'roleKeys=owner',
    `userId=${owner.userId}`,
    `schoolId=${schoolB}`,
  ]) {
    const response = await teacher.fetch(`/api/schools/${schoolA}/students?${query}&pageSize=10`)
    assert.equal(response.status, 400, query)
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }
})

test('[client-identity-tampering] the context route reports the session identity, not the query', async () => {
  const plain = await teacher.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(plain.status, 200)
  const decided = await body<Context>(plain)
  assert.equal(decided.membershipId, teacherMember.membershipId)
  assert.deepEqual([...decided.roleKeys].sort(), ['parent', 'teacher'])
  assert.equal(decided.school.id, schoolA)

  const tampered = await teacher.fetch(
    `/api/schools/${schoolA}/context?membershipId=${owner.membershipId}&roleKeys=owner&userId=${owner.userId}`,
  )
  assert.equal(tampered.status, 200)
  const again = await body<Context>(tampered)
  assert.equal(again.membershipId, decided.membershipId)
  assert.deepEqual(again.roleKeys, decided.roleKeys)
  assert.deepEqual(again.capabilities, decided.capabilities)
  assert.equal(again.school.id, schoolA)

  // A cookie for school A never becomes a session for school B.
  const other = await teacher.fetch(`/api/schools/${schoolB}/context`)
  assert.ok([403, 404].includes(other.status), `refused, got ${other.status}`)
})

test('[client-identity-tampering] an identity carried in a write body changes nothing', async () => {
  const pool = adminPool()
  const rolesBefore = await pool.query<{ role_id: string }>(
    'SELECT role_id FROM membership_roles WHERE membership_id = $1 ORDER BY role_id',
    [teacherMember.membershipId],
  )
  const detail = await ownerClient.fetch(`/api/schools/${schoolA}/students/${studentA}`)
  assert.equal(detail.status, 200)
  const version = (await body<{ student: { version: number } }>(detail)).student.version

  for (const forbidden of [
    { membershipId: owner.membershipId },
    { userId: owner.userId },
    { roleKeys: ['owner'] },
    { schoolId: schoolB },
  ]) {
    const response = await ownerClient.fetch(
      `/api/schools/${schoolA}/students/${studentA}`,
      putBody({ expectedVersion: version, firstName: 'Student A', ...forbidden }),
    )
    assert.equal(response.status, 400, JSON.stringify(forbidden))
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }

  const rolesAfter = await pool.query<{ role_id: string }>(
    'SELECT role_id FROM membership_roles WHERE membership_id = $1 ORDER BY role_id',
    [teacherMember.membershipId],
  )
  assert.deepEqual(rolesAfter.rows, rolesBefore.rows)
  const stored = await pool.query<{ school_id: string; version: number }>(
    'SELECT school_id, version FROM students WHERE id = $1',
    [studentA],
  )
  assert.equal(stored.rows[0]?.school_id, schoolA)
  assert.equal(Number(stored.rows[0]?.version), version)

  // The same write without the forbidden fields succeeds, so the refusals
  // above are about the fields and not about the caller.
  const ok = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${studentA}`,
    putBody({ expectedVersion: version, firstName: 'Student A' }),
  )
  assert.equal(ok.status, 200)
})

test('[student-policy-fixtures] the student template carries no finance or administrative key', async () => {
  // The student template is empty in this build, so the type of its grants
  // is `never`; the shape is restated here so the assertions still compile if
  // a grant is ever added.
  const grants = ROLE_TEMPLATES.student.grants as readonly {
    permission: string
    scope: string
  }[]
  const privileged = [
    'staff.read_pay',
    'staff.update_pay',
    'students.export',
    'students.import',
    'students.promote',
    'members.manage',
    'roles.assign',
    'audit.read',
    'audit.export',
  ]
  for (const grant of grants) {
    assert.equal(
      privileged.includes(grant.permission),
      false,
      `the student template must not grant ${grant.permission}`,
    )
    assert.ok(
      ['self', 'own_record', 'own_children'].includes(grant.scope),
      `the student template grants ${grant.permission} at ${grant.scope}`,
    )
    const metadata = PERMISSION_CATALOGUE[grant.permission as keyof typeof PERMISSION_CATALOGUE]
    assert.ok(metadata, `${grant.permission} is not in the catalogue`)
  }
})

test('[student-policy-fixtures] a student membership cannot even be created', async () => {
  // The fixture student membership exists from before the feature was closed;
  // a new one is refused by the database itself, so there is no HTTP path to
  // test. The fixture student's sign-in is covered by
  // apps/api/tests/session.test.ts 'a student identity can neither sign in nor
  // carry a session'.
  const pool = adminPool()
  const userId = randomUUID()
  const email = `security-student-${randomUUID()}@example.test`
  await pool.query('INSERT INTO auth_user (id, name, email) VALUES ($1, $2, $3)', [
    userId,
    'Policy Student',
    email,
  ])
  await assert.rejects(
    pool.query(
      `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
       VALUES ($1, $2, $3, 'student', 'active')`,
      [randomUUID(), schoolA, userId],
    ),
    /student memberships remain disabled/,
  )
  await pool.query('DELETE FROM auth_user WHERE id = $1', [userId])

  // The fixture student membership, which predates the block, still cannot
  // reach a school route with a forged cookie.
  const anonymous = await fetch(`${server.origin}/api/schools/${schoolA}/students`, {
    headers: { origin: server.origin, cookie: `student=${fixtureIds.studentMember}` },
  })
  assert.equal(anonymous.status, 401)
})

test('[client-identity-tampering] a forged cookie value is not a session', async () => {
  const forged = await fetch(`${server.origin}/api/schools/${schoolA}/students`, {
    headers: {
      origin: server.origin,
      cookie: `better-auth.session_token=${owner.membershipId}.${owner.userId}`,
    },
  })
  assert.equal(forged.status, 401)
  assert.equal(await codeOf(forged), 'AUTHENTICATION_REQUIRED')

  const noBody = await fetch(`${server.origin}/api/me`, {
    headers: { origin: server.origin, 'x-membership-id': owner.membershipId },
  })
  assert.equal(noBody.status, 401)
})

test('[client-identity-tampering] a header cannot promote a signed-in caller', async () => {
  const response = await teacher.fetch(`/api/schools/${schoolA}/context`, {
    headers: {
      'x-role-keys': 'owner',
      'x-membership-id': owner.membershipId,
      'x-school-id': schoolB,
    },
  })
  assert.equal(response.status, 200)
  const decided = await body<Context>(response)
  assert.equal(decided.membershipId, teacherMember.membershipId)
  assert.equal(decided.school.id, schoolA)
  assert.equal(decided.roleKeys.includes('owner'), false)

  // And the promotion did not happen behind the scenes either.
  const denied = await teacher.fetch(
    `/api/schools/${schoolA}/members`,
    postBody({ roleKeys: ['owner'] }),
  )
  assert.ok(denied.status >= 400)
})
