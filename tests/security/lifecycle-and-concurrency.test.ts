/**
 * Matrix rows: clerk-delegation-limits, missing-teacher-role-setup,
 * concurrent-last-owner, role-revoked-during-write.
 *
 * Two requests really are sent at once here (Promise.all), because the thing
 * under test is the lock and version protocol, not a code path.
 *
 * There is no `clerk` role key in this build. The office audience is owner,
 * principal and admin, so the clerk row is written against `admin`, the
 * least-authority role that can manage anyone.
 */
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
} from '../../apps/api/tests/harness.ts'
import {
  body,
  codeOf,
  createMember,
  ensureSection,
  ensureSubject,
  createTeacher,
  forgetTwoFactor,
  postBody,
  putBody,
  signInOffice,
  versionOf,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const suffix = randomUUID().slice(0, 8)

let server: TestServer
let owner: Member
let ownerClient: Client
let admin: Member
let adminClient: Client
let accountant: Member
let payStaffId = ''

async function activeOwnerCount(): Promise<number> {
  const result = await adminPool().query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM school_memberships m
       JOIN membership_roles mr ON mr.membership_id = m.id
       JOIN roles r ON r.id = mr.role_id
      WHERE m.school_id = $1 AND m.status = 'active' AND r.key = 'owner'`,
    [schoolA],
  )
  return result.rows[0]?.n ?? 0
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  owner = await createMember(schoolA, ['owner'], 'Lifecycle Owner')
  ownerClient = await signInOffice(server, owner)
  admin = await createMember(schoolA, ['admin'], 'Lifecycle Admin')
  adminClient = await signInOffice(server, admin)
  accountant = await createMember(schoolA, ['accountant'], 'Lifecycle Accountant')

  payStaffId = randomUUID()
  await adminPool().query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Lifecycle Staff', 'teaching', 'Teacher', 'active')`,
    [payStaffId, schoolA, `LFC-S-${suffix}`],
  )
})

after(async () => {
  await forgetTwoFactor([owner.userId, admin.userId, accountant.userId])
  await server.close()
  await closeAdminPool()
})

test('[clerk-delegation-limits] an administrator may manage a teacher but not a privileged member', async () => {
  const teacher = await createMember(schoolA, ['teacher'], 'Lifecycle Teacher')
  // The permitted case first: an administrator may suspend and restore a
  // teacher, the only role it manages.
  const suspended = await adminClient.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/suspend`,
    postBody({
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'Under review after a complaint',
    }),
  )
  assert.equal(suspended.status, 200)
  const restored = await adminClient.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/restore`,
    postBody({
      // Restore also states the reviewed role set.
      roleKeys: ['teacher'],
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'The review is closed',
    }),
  )
  assert.equal(restored.status, 200)

  for (const target of [owner.membershipId, accountant.membershipId]) {
    for (const path of ['roles', 'suspend'] as const) {
      const denied =
        path === 'roles'
          ? await adminClient.fetch(
              `/api/schools/${schoolA}/members/${target}/roles`,
              putBody({
                roleKeys: ['teacher'],
                expectedVersion: await versionOf(target),
                reason: 'Reaching above its own authority',
              }),
            )
          : await adminClient.fetch(
              `/api/schools/${schoolA}/members/${target}/suspend`,
              postBody({
                expectedVersion: await versionOf(target),
                reason: 'Reaching above its own authority',
              }),
            )
      assert.equal(denied.status, 403, `${path} ${target}`)
      assert.equal(await codeOf(denied), 'ACCESS_DENIED')
    }
  }

  // Assigning a role it may not delegate is refused even on a manageable target.
  const notDelegable = await adminClient.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/roles`,
    putBody({
      roleKeys: ['accountant'],
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'Wants to hand over the books',
    }),
  )
  assert.ok([400, 403].includes(notDelegable.status), `refused, got ${notDelegable.status}`)
  const stored = await adminPool().query<{ key: string }>(
    `SELECT r.key FROM membership_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.membership_id = $1 ORDER BY r.key`,
    [teacher.membershipId],
  )
  assert.deepEqual(stored.rows.map((row) => row.key), ['teacher'])

  // Nor can ownership be granted through this route by anyone at all.
  const ownership = await ownerClient.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/roles`,
    putBody({
      roleKeys: ['owner'],
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'Trying to shortcut the transfer workflow',
    }),
  )
  assert.equal(ownership.status, 400)
})

test('[clerk-delegation-limits] an administrator cannot start recovery for a privileged member', async () => {
  const pool = adminPool()
  const before = server.delivery.outbox.length
  const auditBefore = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE school_id = $1 AND action = 'members.recover_credentials'`,
    [schoolA],
  )

  for (const target of [owner.membershipId, accountant.membershipId]) {
    const denied = await adminClient.fetch(
      `/api/schools/${schoolA}/members/${target}/recovery`,
      postBody({
        expectedVersion: await versionOf(target),
        reason: 'Trying to reset a privileged identity',
      }),
    )
    assert.equal(denied.status, 403, target)
    assert.equal(await codeOf(denied), 'ACCESS_DENIED')
  }

  assert.equal(server.delivery.outbox.length, before)
  const auditAfter = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events WHERE school_id = $1 AND action = 'members.recover_credentials'`,
    [schoolA],
  )
  assert.equal(auditAfter.rows[0]?.n, auditBefore.rows[0]?.n)

  // Credential recovery belongs to the owner alone in this build, so the
  // administrator is refused even on a teacher; the owner is the permitted
  // case that proves the route works.
  const teacher = await createMember(schoolA, ['teacher'], 'Recoverable Teacher')
  const adminOnTeacher = await adminClient.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/recovery`,
    postBody({
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'An administrator has no credential authority',
    }),
  )
  assert.equal(adminOnTeacher.status, 403)

  const allowed = await ownerClient.fetch(
    `/api/schools/${schoolA}/members/${teacher.membershipId}/recovery`,
    postBody({
      expectedVersion: await versionOf(teacher.membershipId),
      reason: 'Locked out and asked at the front desk',
    }),
  )
  assert.equal(allowed.status, 202)
})

test('[missing-teacher-role-setup] an invitation never falls back to another role', async () => {
  const pool = adminPool()
  const countInvites = async () => {
    const result = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM school_invitations WHERE school_id = $1',
      [schoolA],
    )
    return result.rows[0]?.n ?? 0
  }
  const staffId = randomUUID()
  await pool.query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Invitee', 'teaching', 'Teacher', 'active')`,
    [staffId, schoolA, `LFC-I-${suffix}`],
  )

  const before = await countInvites()
  for (const roleKeys of [['class_teacher'], [], ['owner'], ['teacher', 'nonsense']]) {
    const response = await ownerClient.fetch(
      `/api/schools/${schoolA}/invitations`,
      postBody({
        displayName: 'New Teacher',
        identifier: { kind: 'email', value: `invitee-${randomUUID()}@example.test` },
        roleKeys,
        staffId,
      }),
    )
    assert.ok([400, 403].includes(response.status), `${JSON.stringify(roleKeys)} → ${response.status}`)
    const text = await response.text()
    // The answer never names a role the server substituted.
    assert.equal(text.includes('"roleKeys":["teacher"]'), false)
    assert.equal(text.includes('"roleKeys":["admin"]'), false)
  }
  assert.equal(await countInvites(), before)

  // A correctly named role still works, so the refusals are about the role key.
  const ok = await ownerClient.fetch(
    `/api/schools/${schoolA}/invitations`,
    postBody({
      displayName: 'New Teacher',
      identifier: { kind: 'email', value: `invitee-${randomUUID()}@example.test` },
      roleKeys: ['teacher'],
      staffId,
    }),
  )
  assert.equal(ok.status, 201)
  assert.deepEqual((await body<{ roleKeys: string[] }>(ok)).roleKeys, ['teacher'])
})

test('[concurrent-last-owner] two concurrent attempts on a second owner change nothing', async () => {
  // A second owner, inserted directly: owner is not a delegable role.
  const secondOwner = await createMember(schoolA, ['owner'], 'Second Owner')
  const startedWith = await activeOwnerCount()
  assert.ok(startedWith >= 2)

  const version = await versionOf(secondOwner.membershipId)
  const [first, second] = await Promise.all([
    ownerClient.fetch(
      `/api/schools/${schoolA}/members/${secondOwner.membershipId}/suspend`,
      postBody({ expectedVersion: version, reason: 'Concurrent lifecycle change one' }),
    ),
    ownerClient.fetch(
      `/api/schools/${schoolA}/members/${secondOwner.membershipId}/remove`,
      postBody({ expectedVersion: version, reason: 'Concurrent lifecycle change two' }),
    ),
  ])
  // An owner membership is only ever changed by the ownership transfer
  // workflow, so both attempts are refused and the count cannot move.
  assert.deepEqual([first.status, second.status], [403, 403])
  assert.equal(await codeOf(first), 'ACCESS_DENIED')
  assert.equal(await activeOwnerCount(), startedWith)
})

test('[concurrent-last-owner] two lifecycle writes from one version serialise', async () => {
  // The same protocol, on a target the owner may actually manage: exactly one
  // of two writes made from the same version commits.
  const teacher = await createMember(schoolA, ['teacher'], 'Serialised Teacher')
  const version = await versionOf(teacher.membershipId)
  const [first, second] = await Promise.all([
    ownerClient.fetch(
      `/api/schools/${schoolA}/members/${teacher.membershipId}/suspend`,
      postBody({ expectedVersion: version, reason: 'Concurrent suspend' }),
    ),
    ownerClient.fetch(
      `/api/schools/${schoolA}/members/${teacher.membershipId}/roles`,
      putBody({
        roleKeys: ['parent'],
        expectedVersion: version,
        reason: 'Concurrent role change',
      }),
    ),
  ])
  const statuses = [first.status, second.status]
  assert.equal(statuses.filter((status) => status === 200).length, 1, JSON.stringify(statuses))
  assert.ok(
    statuses.some((status) => [400, 409].includes(status)),
    `the loser is a refusal, got ${JSON.stringify(statuses)}`,
  )
})

test('[concurrent-last-owner] the school keeps an owner when the last one is attacked twice', async () => {
  const before = await activeOwnerCount()
  const last = owner.membershipId
  const version = await versionOf(last)
  const [first, second] = await Promise.all([
    ownerClient.fetch(
      `/api/schools/${schoolA}/members/${last}/suspend`,
      postBody({ expectedVersion: version, reason: 'Removing the last owner, once' }),
    ),
    ownerClient.fetch(
      `/api/schools/${schoolA}/members/${last}/remove`,
      postBody({ expectedVersion: version, reason: 'Removing the last owner, twice' }),
    ),
  ])
  // Nobody may end their own membership, so both are refused here; whatever the
  // codes, the invariant is the one that matters.
  assert.ok(first.status >= 400 && second.status >= 400, `${first.status}/${second.status}`)
  assert.equal(await activeOwnerCount(), before)
})

test('[role-revoked-during-write] a pay write racing its own revocation never half-commits', async () => {
  const payer = await createMember(schoolA, ['accountant'], 'Racing Payer')
  const payerClient = await signInOffice(server, payer)

  const detail = await payerClient.fetch(`/api/schools/${schoolA}/staff/${payStaffId}`)
  assert.equal(detail.status, 200)
  const version = (await body<{ staff: { version: number } }>(detail)).staff.version
  const salaryBefore = await adminPool().query<{ monthly_salary: string | null }>(
    'SELECT monthly_salary FROM staff WHERE id = $1',
    [payStaffId],
  )

  const [write, revoke] = await Promise.all([
    payerClient.fetch(
      `/api/schools/${schoolA}/staff/${payStaffId}/pay`,
      putBody({ expectedVersion: version, monthlySalary: 55555, reason: 'Racing the revoke' }),
    ),
    ownerClient.fetch(
      `/api/schools/${schoolA}/members/${payer.membershipId}/roles`,
      putBody({
        roleKeys: ['teacher'],
        expectedVersion: await versionOf(payer.membershipId),
        reason: 'Moved off the fee desk',
      }),
    ),
  ])
  assert.equal(revoke.status, 200)

  const stored = await adminPool().query<{ monthly_salary: string | null }>(
    'SELECT monthly_salary FROM staff WHERE id = $1',
    [payStaffId],
  )
  if (write.status === 200) {
    // It committed before the revoke: the amount must be the new one.
    assert.equal(Number(stored.rows[0]?.monthly_salary), 55555)
  } else {
    assert.ok([403, 409].includes(write.status), `refused, got ${write.status}`)
    assert.equal(stored.rows[0]?.monthly_salary ?? null, salaryBefore.rows[0]?.monthly_salary ?? null)
  }

  // Either way the revoked member cannot write pay on the next request.
  const after = await payerClient.fetch(
    `/api/schools/${schoolA}/staff/${payStaffId}/pay`,
    putBody({ expectedVersion: version + 2, monthlySalary: 1, reason: 'After the revoke' }),
  )
  assert.ok(after.status >= 400, `refused, got ${after.status}`)
})

test('[role-revoked-during-write] an export made under an access version that then changes is not served', async () => {
  const exporter = await createMember(schoolA, ['admin'], 'Racing Exporter')
  const exporterClient = await signInOffice(server, exporter)
  const subjectId = await ensureSubject(schoolA, `LFC-SUB-${suffix}`)
  const sectionId = await ensureSection(schoolA, yearA, gradeA, `LFC-${suffix}`)
  const teacher = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionId],
    subjectId,
    employeeCode: `LFC-T-${suffix}`,
  })

  const queued = await exporterClient.fetch(
    `/api/schools/${schoolA}/staff/export`,
    postBody({ staffIds: [teacher.staffId] }),
  )
  assert.equal(queued.status, 202)
  const job = await body<{ id: string; status: string }>(queued)

  // The job is fetchable while the access behind it still stands.
  const fresh = await exporterClient.fetch(`/api/schools/${schoolA}/exports/${job.id}`)
  assert.equal(fresh.status, 200)

  const revoked = await ownerClient.fetch(
    `/api/schools/${schoolA}/members/${exporter.membershipId}/roles`,
    putBody({
      roleKeys: ['teacher'],
      expectedVersion: await versionOf(exporter.membershipId),
      reason: 'No longer in the office',
    }),
  )
  assert.equal(revoked.status, 200)

  const stale = await exporterClient.fetch(`/api/schools/${schoolA}/exports/${job.id}`)
  if (stale.status === 200) {
    assert.equal((await body<{ status: string }>(stale)).status, 'expired')
  } else {
    assert.ok([403, 404].includes(stale.status), `refused, got ${stale.status}`)
  }
  await forgetTwoFactor([exporter.userId])
})
