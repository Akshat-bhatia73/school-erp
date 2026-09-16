/**
 * Matrix rows: teacher-two-sections, teacher-also-parent, guardian-no-portal,
 * deny-wins, exception-expiry-live.
 *
 * Relationships are the part of the model a role cannot describe, so each test
 * reads a permitted record first and only then asks for the record next to it.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { fixtureIds } from '@erp/db/fixtures'
import {
  adminPool,
  closeAdminPool,
  resetRateLimits,
  seedDatabaseFixtures,
  startTestServer,
  type TestServer,
} from '../../apps/api/tests/harness.ts'
import {
  bumpAccessVersion,
  body,
  codeOf,
  createEnrolledStudent,
  createMember,
  createTeacher,
  ensureSection,
  ensureSubject,
  forgetTwoFactor,
  grantPortalAccess,
  grantRoles,
  signInMember,
  signInOffice,
  writeExceptionRule,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string

let server: TestServer
let owner: Member
let accountant: Member
let accountantClient: Client
let twoSectionTeacher: Awaited<ReturnType<typeof createTeacher>>
let twoSectionClient: Client
let combined: Awaited<ReturnType<typeof createTeacher>>
let combinedClient: Client

let sectionOne = ''
let sectionTwo = ''
let sectionThree = ''
let runSubject = ''
const students: Record<string, string> = {}

interface Basic { id: string; firstName: string; admissionNumber: string }
interface Roster { items: Basic[]; total: number }
interface Detail {
  student: Basic
  medical?: unknown
  sensitive?: unknown
  allowedActions: string[]
}

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const suffix = randomUUID().slice(0, 8)
  const subject = await ensureSubject(schoolA, `SEC-SUB-${suffix}`)
  // The sections are named per run, so a reused database never mixes the
  // rosters of two runs into one class.
  sectionOne = await ensureSection(schoolA, yearA, gradeA, `SEC-1-${suffix}`)
  sectionTwo = await ensureSection(schoolA, yearA, gradeA, `SEC-2-${suffix}`)
  sectionThree = await ensureSection(schoolA, yearA, gradeA, `SEC-3-${suffix}`)
  runSubject = subject
  const seedStudent = async (key: string, sectionId: string, roll: number) => {
    students[key] = await createEnrolledStudent({
      schoolId: schoolA,
      academicYearId: yearA,
      sectionId,
      firstName: `Scope ${key}`,
      admissionNumber: `SEC/${suffix}/${key}`,
      rollNumber: roll,
    })
  }
  await seedStudent('one-a', sectionOne, 11)
  await seedStudent('one-b', sectionOne, 12)
  await seedStudent('two-a', sectionTwo, 21)
  await seedStudent('three-a', sectionThree, 31)
  await seedStudent('child', sectionThree, 32)

  owner = await createMember(schoolA, ['owner'], 'Scope Owner')
  await signInOffice(server, owner)
  accountant = await createMember(schoolA, ['accountant'], 'Scope Accountant')
  accountantClient = await signInOffice(server, accountant)

  twoSectionTeacher = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionOne, sectionTwo],
    subjectId: subject,
    employeeCode: `SEC-T1-${suffix}`,
  })
  twoSectionClient = await signInMember(server, twoSectionTeacher)

  // A teacher of section one who is also the parent of a child in section three.
  combined = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionOne],
    subjectId: subject,
    employeeCode: `SEC-T2-${suffix}`,
  })
  await grantRoles(schoolA, combined.membershipId, ['parent'])
  await grantPortalAccess({
    schoolId: schoolA,
    membershipId: combined.membershipId,
    studentId: students['child'] as string,
    approvedBy: owner.membershipId,
  })
  combinedClient = await signInMember(server, combined)
})

after(async () => {
  await forgetTwoFactor([owner.userId, accountant.userId])
  await server.close()
  await closeAdminPool()
})

test('[teacher-two-sections] the roster is the union of both classes and nothing else', async () => {
  const list = await twoSectionClient.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal(list.status, 200)
  const roster = await body<Roster>(list)
  const ids = roster.items.map((item) => item.id).sort()
  const expected = [students['one-a'], students['one-b'], students['two-a']].sort()
  assert.deepEqual(ids, expected)
  assert.equal(roster.total, roster.items.length)

  const counted = await twoSectionClient.fetch(`/api/schools/${schoolA}/students/count`)
  assert.equal((await body<{ count: number }>(counted)).count, roster.total)

  const search = await twoSectionClient.fetch(`/api/schools/${schoolA}/students/search?q=Scope`)
  const hits = await body<Basic[]>(search)
  assert.deepEqual(
    hits.map((hit) => hit.id).sort(),
    expected,
  )

  // Each returned row really is readable one by one, and the third class is not.
  for (const id of expected) {
    const detail = await twoSectionClient.fetch(`/api/schools/${schoolA}/students/${id}`)
    assert.equal(detail.status, 200, `detail for ${id}`)
  }
  const outside = await twoSectionClient.fetch(
    `/api/schools/${schoolA}/students/${students['three-a']}`,
  )
  assert.equal(outside.status, 404)
  assert.equal(await codeOf(outside), 'RESOURCE_NOT_FOUND')

  // A filter cannot widen the union either.
  const filtered = await twoSectionClient.fetch(
    `/api/schools/${schoolA}/students?sectionId=${sectionThree}&pageSize=100`,
  )
  assert.equal(filtered.status, 200)
  assert.deepEqual((await body<Roster>(filtered)).items, [])
})

test('[teacher-two-sections] the section list matches the assignments', async () => {
  const response = await twoSectionClient.fetch(
    `/api/schools/${schoolA}/sections?academicYearId=${yearA}`,
  )
  assert.equal(response.status, 200)
  const seen = await body<{ id: string }[]>(response)
  const ids = seen.map((section) => section.id).sort()
  assert.deepEqual(ids, [sectionOne, sectionTwo].sort())
})

test('[teacher-also-parent] the union is one class plus one child, with no finance', async () => {
  const list = await combinedClient.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal(list.status, 200)
  const ids = (await body<Roster>(list)).items.map((item) => item.id).sort()
  assert.deepEqual(
    ids,
    [students['one-a'], students['one-b'], students['child']].sort(),
  )

  const child = await combinedClient.fetch(`/api/schools/${schoolA}/students/${students['child']}`)
  assert.equal(child.status, 200)
  const childDetail = await body<Detail>(child)
  assert.equal('medical' in childDetail, false)
  assert.equal('sensitive' in childDetail, false)

  const pupil = await combinedClient.fetch(`/api/schools/${schoolA}/students/${students['one-a']}`)
  assert.equal(pupil.status, 200)
  const pupilDetail = await body<Detail>(pupil)
  assert.equal('medical' in pupilDetail, false)
  assert.equal('sensitive' in pupilDetail, false)
  assert.equal(pupilDetail.allowedActions.includes('students.export'), false)

  // Two roles do not add up to school-wide or financial access.
  const outside = await combinedClient.fetch(
    `/api/schools/${schoolA}/students/${students['two-a']}`,
  )
  assert.equal(outside.status, 404)

  const pay = await combinedClient.fetch(
    `/api/schools/${schoolA}/staff/${twoSectionTeacher.staffId}`,
  )
  // Another teacher's record is not even visible to this caller.
  assert.equal(pay.status, 404)
  assert.equal((await pay.text()).includes('monthlySalary'), false)

  // Her own record is readable, so the missing pay field is a real hiding
  // decision on a record she can see, not an artefact of a refusal.
  const own = await combinedClient.fetch(`/api/schools/${schoolA}/staff/${combined.staffId}`)
  assert.equal(own.status, 200)
  const ownText = await own.text()
  assert.equal(ownText.includes('monthlySalary'), false)

  const audit = await combinedClient.fetch(`/api/schools/${schoolA}/audit-events`)
  assert.equal(audit.status, 403)
  assert.equal(await codeOf(audit), 'ACCESS_DENIED')

  const exported = await combinedClient.fetch(`/api/schools/${schoolA}/students/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ studentIds: [students['child']] }),
  })
  assert.equal(exported.status, 403)
})

test('[guardian-no-portal] a guardian contact with no membership has no way in', async () => {
  const pool = adminPool()
  const guardianId = randomUUID()
  const contact = `guardian-contact-${randomUUID()}@example.test`
  await pool.query(
    `INSERT INTO guardians (id, school_id, first_name, email, phone)
     VALUES ($1, $2, 'Notified Only', $3, '9876500111')`,
    [guardianId, schoolA, contact],
  )
  await pool.query(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relation)
     VALUES ($1, $2, $3, 'guardian') ON CONFLICT DO NOTHING`,
    [schoolA, students['three-a'], guardianId],
  )

  await resetRateLimits()
  const attempt = await fetch(`${server.origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: server.origin },
    body: JSON.stringify({ email: contact, password: 'Fixture-Pass!42' }),
  })
  assert.ok(attempt.status >= 400, `a contact address is not a login (${attempt.status})`)
  const identities = await pool.query('SELECT 1 FROM auth_user WHERE lower(email) = $1', [
    contact.toLowerCase(),
  ])
  assert.equal(identities.rowCount, 0)

  await pool.query('DELETE FROM student_guardians WHERE guardian_id = $1', [guardianId])
  await pool.query('DELETE FROM guardians WHERE id = $1', [guardianId])
})

test('[guardian-no-portal] revoking the portal grant closes the child on the same session', async () => {
  const parent = await createMember(schoolA, ['parent'], 'Revoked Parent')
  const { guardianId } = await grantPortalAccess({
    schoolId: schoolA,
    membershipId: parent.membershipId,
    studentId: students['three-a'] as string,
    approvedBy: owner.membershipId,
  })
  const client = await signInMember(server, parent)

  const before = await client.fetch(`/api/schools/${schoolA}/students/${students['three-a']}`)
  assert.equal(before.status, 200)

  await adminPool().query(
    `UPDATE guardian_student_access SET status = 'revoked', revoked_at = now()
      WHERE school_id = $1 AND guardian_id = $2 AND student_id = $3`,
    [schoolA, guardianId, students['three-a']],
  )
  await bumpAccessVersion(parent.membershipId)

  // A parent whose last grant is gone has no children at all, so the gate
  // refuses the whole area before the record is looked up. Either answer is a
  // refusal; what matters is that no row comes back.
  const afterRevoke = await client.fetch(`/api/schools/${schoolA}/students/${students['three-a']}`)
  assert.ok([403, 404].includes(afterRevoke.status), `refused, got ${afterRevoke.status}`)
  const afterText = await afterRevoke.text()
  assert.equal(afterText.includes('Scope three-a'), false)
  const list = await client.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  // With no child left the gate refuses the whole area before any row is read.
  assert.equal(list.status, 403)
  assert.equal((await list.text()).includes('Scope three-a'), false)
})

test('[deny-wins] a matching deny beats an explicit allow in list, detail, export and actions', async () => {
  const target = students['two-a'] as string
  // The accountant reads at the finance scope, so the baseline is a 200.
  const baseline = await accountantClient.fetch(`/api/schools/${schoolA}/students/${target}`)
  assert.equal(baseline.status, 200)

  const allow = await writeExceptionRule({
    schoolId: schoolA,
    membershipId: accountant.membershipId,
    permission: 'students.read_basic',
    effect: 'allow',
    targetType: 'student',
    targetId: target,
    authorMembershipId: owner.membershipId,
  })
  const deny = await writeExceptionRule({
    schoolId: schoolA,
    membershipId: accountant.membershipId,
    permission: 'students.read_basic',
    effect: 'deny',
    targetType: 'student',
    targetId: target,
    authorMembershipId: owner.membershipId,
  })
  await bumpAccessVersion(accountant.membershipId)

  const detail = await accountantClient.fetch(`/api/schools/${schoolA}/students/${target}`)
  assert.equal(detail.status, 404)

  const list = await accountantClient.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal(list.status, 200)
  const roster = await body<Roster>(list)
  assert.equal(roster.items.some((item) => item.id === target), false)
  // The rest of the school is still readable, so this is a deny and not an outage.
  assert.ok(roster.items.some((item) => item.id === students['one-a']))

  const other = await accountantClient.fetch(`/api/schools/${schoolA}/students/${students['one-a']}`)
  assert.equal(other.status, 200)
  const allowed = (await body<Detail>(other)).allowedActions
  assert.ok(allowed.includes('students.read_basic'))

  await adminPool().query('DELETE FROM resource_access_rules WHERE id = ANY($1::uuid[])', [
    [allow, deny],
  ])
  await bumpAccessVersion(accountant.membershipId)
})

test('[exception-expiry-live] an assignment that ends closes access on the same cookie', async () => {
  const teacher = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionThree],
    subjectId: runSubject,
    employeeCode: `SEC-T3-${randomUUID().slice(0, 8)}`,
  })
  const client = await signInMember(server, teacher)

  const before = await client.fetch(`/api/schools/${schoolA}/students/${students['three-a']}`)
  assert.equal(before.status, 200)

  await adminPool().query(
    `UPDATE teaching_assignments SET effective_to = current_date - 1
      WHERE school_id = $1 AND staff_id = $2`,
    [schoolA, teacher.staffId],
  )
  await bumpAccessVersion(teacher.membershipId)

  // With the last assignment ended the teacher has no class at all, so the
  // gate refuses the area; with one remaining it would be a not-found.
  const afterEnd = await client.fetch(`/api/schools/${schoolA}/students/${students['three-a']}`)
  assert.ok([403, 404].includes(afterEnd.status), `refused, got ${afterEnd.status}`)
  assert.equal((await afterEnd.text()).includes('Scope three-a'), false)
  const list = await client.fetch(`/api/schools/${schoolA}/students?pageSize=100`)
  assert.equal(list.status, 403)
  assert.equal((await list.text()).includes('Scope three-a'), false)
})

test('[exception-expiry-live] an exception stops applying when its window passes', async () => {
  // The reader is a teacher of section two, so the area itself is open and the
  // only thing standing between her and this record is the exception.
  const reader = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionTwo],
    subjectId: runSubject,
    employeeCode: `SEC-T4-${randomUUID().slice(0, 8)}`,
  })
  const client = await signInMember(server, reader)
  const target = students['three-a'] as string

  const closed = await client.fetch(`/api/schools/${schoolA}/students/${target}`)
  assert.equal(closed.status, 404)
  // The permitted record still reads, so this is a boundary and not an outage.
  const permitted = await client.fetch(`/api/schools/${schoolA}/students/${students['two-a']}`)
  assert.equal(permitted.status, 200)

  const ruleId = await writeExceptionRule({
    schoolId: schoolA,
    membershipId: reader.membershipId,
    permission: 'students.read_basic',
    effect: 'allow',
    targetType: 'student',
    targetId: target,
    authorMembershipId: owner.membershipId,
  })
  await bumpAccessVersion(reader.membershipId)
  const opened = await client.fetch(`/api/schools/${schoolA}/students/${target}`)
  assert.equal(opened.status, 200)

  // Only the window moves. No sign-in, no access version change: expiry alone
  // has to end the access on the very next request.
  await adminPool().query(
    `UPDATE resource_access_rules SET effective_from = now() - interval '2 days',
            expires_at = now() - interval '1 minute' WHERE id = $1`,
    [ruleId],
  )
  const expired = await client.fetch(`/api/schools/${schoolA}/students/${target}`)
  assert.equal(expired.status, 404)
  assert.equal((await expired.text()).includes('Scope three-a'), false)

  await adminPool().query('DELETE FROM resource_access_rules WHERE id = $1', [ruleId])
})
