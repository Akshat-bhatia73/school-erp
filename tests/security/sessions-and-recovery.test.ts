/**
 * Matrix rows: recovery-revokes-sessions, session-switch-in-flight,
 * private-doc-after-revocation, delivery-failure.
 *
 * Everything here is about a session or a link outliving the access behind it:
 * a second browser that was signed in before a reset, a download URL copied
 * before a grant was removed, a request in flight while the person signs out.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  clientFor,
  closeAdminPool,
  closeRateLimitPool,
  resetRateLimits,
  seedDatabaseFixtures,
  setFixturePassword,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  PASSWORD,
  body,
  codeOf,
  createEnrolledStudent,
  createMember,
  createScriptedDelivery,
  ensureSection,
  forgetTwoFactor,
  grantPortalAccess,
  postBody,
  signInMember,
  signInOffice,
  startServerWith,
  type Client,
  type CustomServer,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string
const suffix = randomUUID().slice(0, 8)

let server: TestServer
let owner: Member
let ownerClient: Client
let childId = ''
let documentId = ''
let parent: Member

const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31])

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  owner = await createMember(schoolA, ['owner'], 'Session Owner')
  ownerClient = await signInOffice(server, owner)

  const sectionId = await ensureSection(schoolA, yearA, gradeA, `SES-${suffix}`)
  childId = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId,
    firstName: 'Session Child',
    admissionNumber: `SES/${suffix}/1`,
    rollNumber: 3,
  })
  parent = await createMember(schoolA, ['parent'], 'Session Parent')
  await grantPortalAccess({
    schoolId: schoolA,
    membershipId: parent.membershipId,
    studentId: childId,
    approvedBy: owner.membershipId,
    areas: ['basic', 'documents'],
  })

  documentId = randomUUID()
  const storageKey = `security/${suffix}.pdf`
  await adminPool().query(
    `INSERT INTO student_documents
       (id, school_id, student_id, document_type, file_name, storage_key, size_bytes)
     VALUES ($1, $2, $3, 'birth_certificate', 'session.pdf', $4, $5)`,
    [documentId, schoolA, childId, storageKey, BYTES.byteLength],
  )
  server.documents.put(storageKey, BYTES, 'application/pdf')

})

after(async () => {
  const pool = adminPool()
  await pool.query('DELETE FROM student_documents WHERE id = $1', [documentId])
  await forgetTwoFactor([owner.userId])
  await server.close()
  await closeAdminPool()
  // The rate limit pool is reopened by the sign-ins above, so close it last or
  // the test process never exits.
  await closeRateLimitPool()
})

const contentPath = (student: string, document: string) =>
  `/api/schools/${schoolA}/students/${student}/documents/${document}/content`

test('[private-doc-after-revocation] a copied download URL dies with the permission', async () => {
  // No role template grants a parent students.download_documents, so the
  // caller here is an administrator who holds it and then loses it.
  const reader = await createMember(schoolA, ['admin'], 'Document Reader')
  const client = await signInOffice(server, reader)

  const permitted = await client.fetch(contentPath(childId, documentId))
  assert.equal(permitted.status, 200)
  assert.deepEqual([...new Uint8Array(await permitted.arrayBuffer())], [...BYTES])

  const version = await adminPool().query<{ version: number }>(
    'SELECT version FROM school_memberships WHERE id = $1',
    [reader.membershipId],
  )
  const revoked = await ownerClient.fetch(
    `/api/schools/${schoolA}/members/${reader.membershipId}/roles`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roleKeys: ['teacher'],
        expectedVersion: Number(version.rows[0]?.version),
        reason: 'No longer in the office',
      }),
    },
  )
  assert.equal(revoked.status, 200)

  // The identical URL on the identical cookie.
  const replayed = await client.fetch(contentPath(childId, documentId))
  assert.ok([403, 404].includes(replayed.status), `refused, got ${replayed.status}`)
  assert.equal(replayed.headers.get('location'), null)
  const text = await replayed.text()
  assert.equal(text.includes('session.pdf'), false)
  assert.equal(text.includes(`security/${suffix}`), false)

  // The successful download was audited; the refusal wrote no bytes.
  const audits = await adminPool().query<{ result: string }>(
    `SELECT result FROM audit_events WHERE school_id = $1 AND target_id = $2
      ORDER BY created_at`,
    [schoolA, documentId],
  )
  assert.ok(audits.rows.some((row) => row.result === 'allowed'))
  await forgetTwoFactor([reader.userId])
})

test('[private-doc-after-revocation] a parent without the download key never gets the bytes', async () => {
  const client = await signInMember(server, parent)
  // The portal link is real: the child reads.
  assert.equal((await client.fetch(`/api/schools/${schoolA}/students/${childId}`)).status, 200)
  const denied = await client.fetch(contentPath(childId, documentId))
  assert.ok([403, 404].includes(denied.status), `refused, got ${denied.status}`)
  assert.equal((await denied.text()).includes(`security/${suffix}`), false)
})

test('[recovery-revokes-sessions] a reset ends every other session and the old password', async () => {
  const member = await createMember(schoolA, ['teacher'], 'Reset Teacher')
  await setFixturePassword(server, member.userId, PASSWORD)
  const first = await signInMember(server, member)
  const second = clientFor(server)
  assert.equal((await second.signIn(member.email, PASSWORD)).status, 200)
  assert.equal((await first.fetch('/api/me')).status, 200)
  assert.equal((await second.fetch('/api/me')).status, 200)

  const before = server.delivery.outbox.length
  await resetRateLimits()
  const asked = await fetch(`${server.origin}/api/auth/request-password-reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ email: member.email }),
  })
  assert.equal(asked.status, 200)
  const message = server.delivery.outbox
    .slice(before)
    .find((entry) => entry.purpose === 'password_reset' && entry.to === member.email)
  assert.ok(message, 'a reset was delivered to the member')

  await resetRateLimits()
  const NEXT = 'Fixture-Pass!44'
  const reset = await fetch(`${server.origin}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ token: message.secret, newPassword: NEXT }),
  })
  assert.equal(reset.status, 200)

  // Both sessions held before the reset are dead.
  assert.equal((await first.fetch('/api/me')).status, 401)
  assert.equal((await second.fetch('/api/me')).status, 401)

  // The old password no longer signs in; the new one does.
  await resetRateLimits()
  const old = clientFor(server)
  assert.ok((await old.signIn(member.email, PASSWORD)).status >= 400)
  await resetRateLimits()
  const fresh = clientFor(server)
  assert.equal((await fresh.signIn(member.email, NEXT)).status, 200)

  // The token is single use.
  await resetRateLimits()
  const replay = await fetch(`${server.origin}/api/auth/reset-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ token: message.secret, newPassword: 'Fixture-Pass!45' }),
  })
  assert.ok(replay.status >= 400)
})

test('[recovery-revokes-sessions] re-enrolling the second factor invalidates the earlier enrolment', async () => {
  const office = await createMember(schoolA, ['principal'], 'Reenrol Principal')
  const firstEnrolment = await signInOffice(server, office)
  assert.equal((await firstEnrolment.fetch(`/api/schools/${schoolA}/context`)).status, 200)
  const oldSecrets = await adminPool().query<{ secret: string }>(
    'SELECT secret FROM auth_two_factor WHERE user_id = $1',
    [office.userId],
  )
  assert.equal(oldSecrets.rowCount, 1)

  // A second enrolment replaces the first.
  const secondEnrolment = await signInOffice(server, office)
  const newSecrets = await adminPool().query<{ secret: string }>(
    'SELECT secret FROM auth_two_factor WHERE user_id = $1',
    [office.userId],
  )
  assert.equal(newSecrets.rowCount, 1)
  assert.notEqual(newSecrets.rows[0]?.secret, oldSecrets.rows[0]?.secret)
  assert.equal((await secondEnrolment.fetch(`/api/schools/${schoolA}/context`)).status, 200)

  // The session that completed the old factor no longer carries the school.
  const stale = await firstEnrolment.fetch(`/api/schools/${schoolA}/context`)
  assert.ok(stale.status >= 400, `the old session is refused, got ${stale.status}`)
  await forgetTwoFactor([office.userId])
})

test('[session-switch-in-flight] a read racing a sign-out never answers after it', async () => {
  const member = await createMember(schoolA, ['teacher'], 'Signing Out Teacher')
  const client = await signInMember(server, member)
  assert.equal((await client.fetch('/api/me')).status, 200)

  const [read, signOut] = await Promise.all([
    client.fetch(`/api/schools/${schoolA}/context`),
    client.fetch('/api/auth/sign-out', postBody({})),
  ])
  assert.equal(signOut.status, 200)
  // The read either finished under the session it started with or was refused.
  assert.ok([200, 401, 403].includes(read.status), `got ${read.status}`)

  // After the sign-out commits, nothing on that cookie works.
  assert.equal((await client.fetch('/api/me')).status, 401)
  const after = await client.fetch(`/api/schools/${schoolA}/context`)
  assert.equal(after.status, 401)
  assert.equal(await codeOf(after), 'AUTHENTICATION_REQUIRED')
})

test('[session-switch-in-flight] a suspension mid-session closes the school on the next request', async () => {
  const member = await createMember(schoolA, ['teacher'], 'Suspended Mid Session')
  const client = await signInMember(server, member)
  assert.equal((await client.fetch(`/api/schools/${schoolA}/context`)).status, 200)

  const version = await adminPool().query<{ version: number }>(
    'SELECT version FROM school_memberships WHERE id = $1',
    [member.membershipId],
  )
  const [suspend, inFlight] = await Promise.all([
    ownerClient.fetch(
      `/api/schools/${schoolA}/members/${member.membershipId}/suspend`,
      postBody({
        expectedVersion: Number(version.rows[0]?.version),
        reason: 'Suspended while the browser was busy',
      }),
    ),
    client.fetch(`/api/schools/${schoolA}/students?pageSize=100`),
  ])
  assert.equal(suspend.status, 200)
  assert.ok([200, 403].includes(inFlight.status), `got ${inFlight.status}`)

  const next = await client.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal(next.status, 403)
  const nextText = await next.text()
  assert.equal(JSON.parse(nextText).error.code, 'SCHOOL_ACCESS_UNAVAILABLE')
  assert.equal(nextText.includes('Session Child'), false)
})

test('[delivery-failure] a failed delivery is not a silent success, and the retry does not duplicate', async () => {
  const delivery = createScriptedDelivery()
  const failing: CustomServer = await startServerWith({ delivery })
  try {
    const inviter = await createMember(schoolA, ['owner'], 'Delivery Owner')
    const inviterClient = await signInOffice(failing, inviter)
    const staffId = randomUUID()
    await adminPool().query(
      `INSERT INTO staff (id, school_id, employee_code, first_name, staff_type, designation, status)
       VALUES ($1, $2, $3, 'Delivery', 'teaching', 'Teacher', 'active')`,
      [staffId, schoolA, `SES-D-${suffix}`],
    )
    const email = `invitee-${randomUUID()}@example.test`

    delivery.failing = true
    const attempt = await inviterClient.fetch(
      `/api/schools/${schoolA}/invitations`,
      postBody({
        displayName: 'Delivery Teacher',
        identifier: { kind: 'email', value: email },
        roleKeys: ['teacher'],
        staffId,
      }),
    )
    // The invitation is created, but the answer names the failure rather than
    // claiming a delivery that never happened, and carries no raw token.
    assert.equal(attempt.status, 201)
    const created = await body<{ id: string; deliveryStatus: string }>(attempt)
    assert.equal(created.deliveryStatus, 'failed')

    const pool = adminPool()
    const rows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM school_invitations WHERE school_id = $1 AND staff_id = $2`,
      [schoolA, staffId],
    )
    assert.equal(rows.rowCount, 1)
    const retryTarget = rows.rows[0]?.id as string
    assert.equal(retryTarget, created.id)

    // Nothing that was stored may claim it was delivered.
    const queued = await pool.query<{ status: string }>(
      `SELECT status FROM delivery_outbox
        WHERE school_id = $1 AND payload->>'invitationId' = $2`,
      [schoolA, retryTarget],
    )
    assert.equal(queued.rows[0]?.status, 'failed')

    // No membership was created for the invitee either.
    const members = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM school_memberships m
         JOIN membership_staff_links l ON l.membership_id = m.id
        WHERE l.staff_id = $1`,
      [staffId],
    )
    assert.equal(members.rows[0]?.n, 0)

    // The provider recovers; the retry sends exactly one message, reports the
    // send as the positive control, and leaves exactly one invitation.
    delivery.failing = false
    const stored = await pool.query<{ version: number }>(
      'SELECT version FROM school_invitations WHERE id = $1',
      [retryTarget],
    )
    const resend = await inviterClient.fetch(
      `/api/schools/${schoolA}/invitations/${retryTarget}/resend`,
      // The resend contract takes the version alone.
      postBody({ expectedVersion: Number(stored.rows[0]?.version) }),
    )
    assert.ok([200, 201].includes(resend.status), `resend, got ${resend.status}`)
    const resendText = await resend.text()
    const resent = JSON.parse(resendText) as { deliveryStatus: string }
    assert.equal(resent.deliveryStatus, 'sent')
    const sent = delivery.outbox.filter((message) => message.to === email)
    assert.equal(sent.length, 1)
    assert.equal(resendText.includes(sent[0]?.secret ?? 'no-secret'), false)
    const after = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM school_invitations WHERE school_id = $1 AND staff_id = $2',
      [schoolA, staffId],
    )
    assert.equal(after.rows[0]?.n, 1)

    await forgetTwoFactor([inviter.userId])
  } finally {
    await failing.close()
  }
})

test('[delivery-failure] a failed reset delivery still answers generically and leaks no token', async () => {
  const delivery = createScriptedDelivery()
  const failing: CustomServer = await startServerWith({ delivery })
  try {
    const member = await createMember(schoolA, ['teacher'], 'Delivery Teacher')
    await setFixturePassword(failing, member.userId, PASSWORD)
    delivery.failing = true
    await resetRateLimits()
    const asked = await fetch(`${failing.origin}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: failing.origin },
      body: JSON.stringify({ email: member.email }),
    })
    const text = await asked.text()
    assert.equal(text.toLowerCase().includes('token'), false)
    assert.equal(delivery.outbox.length, 0)
    assert.ok(delivery.attempts.some((attempt) => attempt.to === member.email))

    // The old password still works: a failed delivery never changes anything.
    await resetRateLimits()
    const client = clientFor(failing)
    assert.equal((await client.signIn(member.email, PASSWORD)).status, 200)

    // Once the provider recovers the same request succeeds and delivers once.
    delivery.failing = false
    await resetRateLimits()
    const retry = await fetch(`${failing.origin}/api/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: failing.origin },
      body: JSON.stringify({ email: member.email }),
    })
    assert.equal(retry.status, 200)
    assert.equal(
      delivery.outbox.filter((message) => message.to === member.email).length,
      1,
    )
  } finally {
    await failing.close()
  }
})
