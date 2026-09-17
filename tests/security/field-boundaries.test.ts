/**
 * Matrix rows: hidden-field-query, audit-leak, per-action-separation.
 *
 * A field the caller may not read must not come back through a sort, a filter,
 * a free-text search, a count, an audit row or an export. Each test writes the
 * hidden value itself, with a string nothing else in the database contains, and
 * then hunts for that string through every channel the caller can reach.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before } from 'node:test'
import { isFinanceAuditAction } from '@erp/contracts'
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
  createEnrolledStudent,
  createMember,
  createTeacher,
  ensureSection,
  ensureSubject,
  forgetTwoFactor,
  postBody,
  putBody,
  signInMember,
  signInOffice,
  type Client,
  type Member,
} from './support.ts'

const schoolA = fixtureIds.schoolA as string
const yearA = fixtureIds.yearA as string
const gradeA = fixtureIds.gradeA as string

const suffix = randomUUID().slice(0, 8)
/** Strings nothing else can contain, so finding one anywhere is a leak. */
const SECRET = {
  medical: `medsecret${suffix}`,
  salary: 41337 + Math.floor(Math.random() * 500),
  guardianPhone: `98${Math.floor(10000000 + Math.random() * 89999999)}`,
}

let server: TestServer
let owner: Member
let ownerClient: Client
let accountant: Member
let accountantClient: Client
let teacherMember: Awaited<ReturnType<typeof createTeacher>>
let teacher: Client
let sectionId = ''
let pupilId = ''
let colleagueStaffId = ''

interface Page<T> { items: T[]; total: number }

/** A window inside the export limit, ending a minute from now. */
function auditWindow(): { from: string; to: string } {
  const to = new Date(Date.now() + 60_000)
  const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}
interface AuditRow { id: string; action: string; summary: string }

before(async () => {
  await seedDatabaseFixtures()
  server = await startTestServer()
  const subjectId = await ensureSubject(schoolA, `FLD-SUB-${suffix}`)
  sectionId = await ensureSection(schoolA, yearA, gradeA, `FLD-${suffix}`)
  pupilId = await createEnrolledStudent({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionId,
    firstName: 'Field Pupil',
    admissionNumber: `FLD/${suffix}/1`,
    rollNumber: 7,
  })
  owner = await createMember(schoolA, ['owner'], 'Field Owner')
  ownerClient = await signInOffice(server, owner)
  accountant = await createMember(schoolA, ['accountant'], 'Field Accountant')
  accountantClient = await signInOffice(server, accountant)
  teacherMember = await createTeacher({
    schoolId: schoolA,
    academicYearId: yearA,
    sectionIds: [sectionId],
    subjectId,
    employeeCode: `FLD-T-${suffix}`,
  })
  teacher = await signInMember(server, teacherMember)

  // A colleague whose pay only the office may see.
  colleagueStaffId = randomUUID()
  await adminPool().query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Field Colleague', 'teaching', 'Teacher', 'active')`,
    [colleagueStaffId, schoolA, `FLD-C-${suffix}`],
  )
})

after(async () => {
  await forgetTwoFactor([owner.userId, accountant.userId])
  await server.close()
  await closeAdminPool()
})

test('[hidden-field-query] the office writes the hidden values that the rest of the suite hunts for', async () => {
  const detail = await ownerClient.fetch(`/api/schools/${schoolA}/students/${pupilId}`)
  assert.equal(detail.status, 200)
  const version = (await body<{ student: { version: number } }>(detail)).student.version
  const sensitive = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${pupilId}/sensitive`,
    putBody({ expectedVersion: version, medicalNotes: SECRET.medical, bloodGroup: 'O+' }),
  )
  assert.equal(sensitive.status, 200)

  const staff = await ownerClient.fetch(`/api/schools/${schoolA}/staff/${colleagueStaffId}`)
  assert.equal(staff.status, 200)
  const staffVersion = (await body<{ staff: { version: number } }>(staff)).staff.version
  const pay = await ownerClient.fetch(
    `/api/schools/${schoolA}/staff/${colleagueStaffId}/pay`,
    putBody({
      expectedVersion: staffVersion,
      monthlySalary: SECRET.salary,
      reason: 'Annual revision',
    }),
  )
  assert.equal(pay.status, 200)

  const guardian = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/${pupilId}/guardians`,
    postBody({
      guardian: { firstName: 'Field', lastName: 'Parent', phone: `+91${SECRET.guardianPhone}` },
      relation: 'father',
      isPrimary: true,
    }),
  )
  assert.ok([200, 201].includes(guardian.status), `guardian added, got ${guardian.status}`)
})

test('[hidden-field-query] a sort or filter cannot name a field the caller may not read', async () => {
  const honest = await teacher.fetch(`/api/schools/${schoolA}/students?sort=name`)
  assert.equal(honest.status, 200)

  for (const query of ['sort=salary', 'sort=bank_account', 'sort=medicalNotes', 'medicalNotes=O%2B']) {
    const response = await teacher.fetch(`/api/schools/${schoolA}/students?${query}`)
    assert.equal(response.status, 400, query)
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }
  for (const query of ['sort=salary', 'sort=monthly_salary', 'monthlySalary=1']) {
    const response = await ownerClient.fetch(`/api/schools/${schoolA}/staff?${query}`)
    assert.equal(response.status, 400, query)
    assert.equal(await codeOf(response), 'INVALID_REQUEST')
  }
})

test('[hidden-field-query] free text never matches on a hidden value, and the count agrees', async () => {
  // The teacher may read this pupil, so a search for the name finds it.
  const named = await teacher.fetch(`/api/schools/${schoolA}/students?search=Field%20Pupil`)
  assert.equal(named.status, 200)
  assert.equal((await body<Page<{ id: string }>>(named)).items.some((i) => i.id === pupilId), true)

  const baseline = await teacher.fetch(`/api/schools/${schoolA}/students/count`)
  const baseCount = (await body<{ count: number }>(baseline)).count

  for (const term of [SECRET.medical, SECRET.guardianPhone, String(SECRET.salary)]) {
    const search = await teacher.fetch(`/api/schools/${schoolA}/students?search=${term}`)
    assert.equal(search.status, 200, term)
    assert.deepEqual((await body<Page<{ id: string }>>(search)).items, [], term)

    const counted = await teacher.fetch(`/api/schools/${schoolA}/students/count?search=${term}`)
    assert.equal(counted.status, 200, term)
    assert.equal((await body<{ count: number }>(counted)).count, 0, term)

    const global = await teacher.fetch(`/api/schools/${schoolA}/search?q=${term}`)
    assert.equal(global.status, 200, term)
    assert.equal((await global.text()).includes('Field Pupil'), false, term)

    const staffSearch = await accountantClient.fetch(
      `/api/schools/${schoolA}/staff?search=${term}`,
    )
    assert.equal(staffSearch.status, 200, term)
    assert.deepEqual((await body<Page<{ id: string }>>(staffSearch)).items, [], term)
  }

  // A hidden value cannot move the count either.
  const again = await teacher.fetch(`/api/schools/${schoolA}/students/count`)
  assert.equal((await body<{ count: number }>(again)).count, baseCount)
})

test('[audit-leak] no audit row carries a hidden value, for any reader', async () => {
  for (const [label, client] of [
    ['owner', ownerClient],
    ['accountant', accountantClient],
  ] as const) {
    const response = await client.fetch(`/api/schools/${schoolA}/audit-events?pageSize=100`)
    assert.equal(response.status, 200, label)
    const page = await body<Page<AuditRow>>(response)
    // The writes above really are audited, so this is not an empty log.
    assert.ok(page.items.some((row) => row.action.startsWith('staff.update_pay')), label)
    const text = JSON.stringify(page)
    for (const secret of [SECRET.medical, SECRET.guardianPhone, String(SECRET.salary)]) {
      assert.equal(text.includes(secret), false, `${label} audit leaked ${secret}`)
    }
  }

  // The finance scope is narrow: an accountant reads the money actions and
  // nothing else, while the owner reads the same log in full.
  const asAccountant = await accountantClient.fetch(
    `/api/schools/${schoolA}/audit-events?pageSize=100`,
  )
  assert.equal(asAccountant.status, 200)
  const financePage = await body<Page<AuditRow>>(asAccountant)
  assert.ok(financePage.total > 0, 'the accountant still reads its own audience')
  for (const row of financePage.items) {
    assert.ok(
      isFinanceAuditAction(row.action),
      `the finance reader must not see ${row.action}`,
    )
  }
  const asOwner = await body<Page<AuditRow>>(
    await ownerClient.fetch(`/api/schools/${schoolA}/audit-events?pageSize=100`),
  )
  assert.ok(
    asOwner.items.some((row) => !isFinanceAuditAction(row.action)),
    'the owner reads actions outside the finance audience',
  )
  assert.ok(asOwner.total > financePage.total)

  const exported = await ownerClient.fetch(
    `/api/schools/${schoolA}/audit-events/export`,
    postBody(auditWindow()),
  )
  assert.equal(exported.status, 202)
  const exportText = await exported.text()
  for (const secret of [SECRET.medical, SECRET.guardianPhone, String(SECRET.salary)]) {
    assert.equal(exportText.includes(secret), false)
  }
  // The stored job names a window and a permission, never the rows.
  const stored = await adminPool().query<{ criteria: unknown }>(
    `SELECT criteria FROM export_jobs WHERE school_id = $1 AND kind = 'audit'
      ORDER BY created_at DESC LIMIT 1`,
    [schoolA],
  )
  assert.equal(JSON.stringify(stored.rows[0]?.criteria).includes(SECRET.medical), false)
})

test('[audit-leak] the audit reader never sees the pay amount it changed', async () => {
  const rows = await adminPool().query<{ summary: string; safe_changes: unknown }>(
    `SELECT summary, safe_changes FROM audit_events
      WHERE school_id = $1 AND action = 'staff.update_pay' ORDER BY created_at DESC LIMIT 1`,
    [schoolA],
  )
  const row = rows.rows[0]
  assert.ok(row, 'the pay change was audited')
  assert.equal(JSON.stringify(row).includes(String(SECRET.salary)), false)
})

test('[per-action-separation] reading students never implies exporting them', async () => {
  // The teacher reads her class, so read really is granted.
  const read = await teacher.fetch(`/api/schools/${schoolA}/students/${pupilId}`)
  assert.equal(read.status, 200)
  const allowed = (await body<{ allowedActions: string[] }>(read)).allowedActions
  assert.ok(allowed.includes('students.read_basic'))
  assert.equal(allowed.includes('students.export'), false)

  const before = await adminPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM export_jobs WHERE school_id = $1 AND kind = 'students'`,
    [schoolA],
  )
  const exported = await teacher.fetch(
    `/api/schools/${schoolA}/students/export`,
    postBody({ studentIds: [pupilId] }),
  )
  assert.equal(exported.status, 403)
  assert.equal(await codeOf(exported), 'ACCESS_DENIED')
  const after = await adminPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM export_jobs WHERE school_id = $1 AND kind = 'students'`,
    [schoolA],
  )
  assert.equal(after.rows[0]?.n, before.rows[0]?.n)

  // The owner, who holds the export key, is allowed: the refusal is about the
  // key and not about the route being broken.
  const office = await ownerClient.fetch(
    `/api/schools/${schoolA}/students/export`,
    postBody({ studentIds: [pupilId] }),
  )
  assert.equal(office.status, 202)
})

test('[per-action-separation] reading the staff directory never implies export or pay', async () => {
  const directory = await teacher.fetch(`/api/schools/${schoolA}/staff`)
  assert.equal(directory.status, 200)

  const mine = await teacher.fetch(`/api/schools/${schoolA}/staff/${teacherMember.staffId}`)
  assert.equal(mine.status, 200)
  const text = await mine.text()
  assert.equal(text.includes('monthlySalary'), false)
  assert.equal(text.includes(String(SECRET.salary)), false)

  const before = await adminPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM export_jobs WHERE school_id = $1 AND kind = 'staff'`,
    [schoolA],
  )
  const exported = await teacher.fetch(
    `/api/schools/${schoolA}/staff/export`,
    postBody({ staffIds: [teacherMember.staffId] }),
  )
  assert.equal(exported.status, 403)
  const after = await adminPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM export_jobs WHERE school_id = $1 AND kind = 'staff'`,
    [schoolA],
  )
  assert.equal(after.rows[0]?.n, before.rows[0]?.n)

  const pay = await teacher.fetch(
    `/api/schools/${schoolA}/staff/${colleagueStaffId}/pay`,
    putBody({ expectedVersion: 1, monthlySalary: 1, reason: 'Trying it on' }),
  )
  assert.ok([403, 404].includes(pay.status), `refused, got ${pay.status}`)
  const stored = await adminPool().query<{ monthly_salary: string }>(
    'SELECT monthly_salary FROM staff WHERE id = $1',
    [colleagueStaffId],
  )
  assert.equal(Number(stored.rows[0]?.monthly_salary), SECRET.salary)
})

test('[per-action-separation] an audit reader is not an audit exporter', async () => {
  // A principal holds audit.read and not audit.export; the accountant holds
  // both, so the reader has to be the principal for this to mean anything.
  const principal = await createMember(schoolA, ['principal'], 'Field Principal')
  const principalClient = await signInOffice(server, principal)
  const read = await principalClient.fetch(`/api/schools/${schoolA}/audit-events`)
  assert.equal(read.status, 200)

  const exported = await principalClient.fetch(
    `/api/schools/${schoolA}/audit-events/export`,
    postBody(auditWindow()),
  )
  assert.equal(exported.status, 403)
  assert.equal(await codeOf(exported), 'ACCESS_DENIED')
  await forgetTwoFactor([principal.userId])
})
