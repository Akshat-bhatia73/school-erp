/**
 * Shared scaffolding for the adversarial acceptance suite.
 *
 * Everything here is a thin wrapper over the API's own test harness
 * (apps/api/tests/harness.ts). The suite never re-implements an access
 * decision, a fixture or a sign-in: it only drives the running server.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { loadConfig } from '../../apps/api/src/config.ts'
import { createPools } from '../../apps/api/src/db.ts'
import { createAuth } from '../../apps/api/src/auth/better-auth.ts'
import { createMemoryDocumentStorage } from '../../apps/api/src/files/storage.ts'
import { buildApp } from '../../apps/api/src/app.ts'
import type { DeliveryAdapter, DeliveryMessage } from '../../apps/api/src/delivery/index.ts'
import {
  CookieJar,
  adminPool,
  freePort,
  signInWithMfa,
  signInWithPassword,
  testEnv,
  type TestServer,
} from '../../apps/api/tests/harness.ts'

export const PASSWORD = 'Fixture-Pass!42'

export type Client = Awaited<ReturnType<typeof signInWithPassword>>

export interface ErrorBody {
  error: { code: string; requestId: string }
}

export async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

export async function codeOf(response: Response): Promise<string> {
  return (await body<ErrorBody>(response)).error.code
}

export function postBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  }
}

export function putBody(value: unknown): RequestInit {
  return { ...postBody(value), method: 'PUT' }
}

/** A brand new identity and membership, so a run never disturbs the fixtures. */
export interface Member {
  membershipId: string
  userId: string
  email: string
}

export async function createMember(
  schoolId: string,
  roleKeys: readonly string[],
  label = 'Security Member',
): Promise<Member> {
  const pool = adminPool()
  const userId = randomUUID()
  const email = `security-${randomUUID()}@example.test`
  await pool.query(
    `INSERT INTO auth_user (id, name, email) VALUES ($1, $2, $3)`,
    [userId, label, email],
  )
  const membershipId = randomUUID()
  await pool.query(
    `INSERT INTO school_memberships (id, school_id, user_id, kind, status)
     VALUES ($1, $2, $3, 'adult', 'active')`,
    [membershipId, schoolId, userId],
  )
  await grantRoles(schoolId, membershipId, roleKeys)
  return { membershipId, userId, email }
}

export async function grantRoles(
  schoolId: string,
  membershipId: string,
  roleKeys: readonly string[],
): Promise<void> {
  await adminPool().query(
    `INSERT INTO membership_roles (school_id, membership_id, role_id)
     SELECT $1, $2, id FROM roles WHERE school_id = $1 AND key = ANY($3::text[])
     ON CONFLICT DO NOTHING`,
    [schoolId, membershipId, [...roleKeys]],
  )
}

/** Sign a freshly created member in without a second factor. */
export async function signInMember(
  server: TestServer,
  member: Member,
): Promise<Client> {
  const { setFixturePassword } = await import('../../apps/api/tests/harness.ts')
  await setFixturePassword(server, member.userId, PASSWORD)
  return signInWithPassword(server, member.email, PASSWORD)
}

/** Sign an office member in with the second factor its roles require. */
export async function signInOffice(
  server: TestServer,
  member: Member,
): Promise<Client> {
  return signInWithMfa(server, {
    userId: member.userId,
    email: member.email,
    password: PASSWORD,
  })
}

export async function forgetTwoFactor(userIds: readonly string[]): Promise<void> {
  const pool = adminPool()
  await pool.query('DELETE FROM auth_two_factor WHERE user_id = ANY($1::uuid[])', [
    [...userIds],
  ])
  await pool.query(
    'UPDATE auth_user SET two_factor_enabled = false WHERE id = ANY($1::uuid[])',
    [[...userIds]],
  )
}

export async function versionOf(membershipId: string): Promise<number> {
  const result = await adminPool().query<{ version: number }>(
    `SELECT version FROM school_memberships WHERE id = $1`,
    [membershipId],
  )
  return Number(result.rows[0]?.version)
}

/**
 * Move a membership's access version the way a committed access change does.
 * Used where the test changes a relationship row directly, which is the only
 * way to end a teaching assignment or a portal grant in this build.
 */
export async function bumpAccessVersion(membershipId: string): Promise<void> {
  await adminPool().query(
    `UPDATE school_memberships
        SET access_version = access_version + 1, version = version + 1
      WHERE id = $1`,
    [membershipId],
  )
}

export async function roleIdFor(schoolId: string, key: string): Promise<string> {
  const result = await adminPool().query<{ id: string }>(
    'SELECT id FROM roles WHERE school_id = $1 AND key = $2',
    [schoolId, key],
  )
  const id = result.rows[0]?.id
  assert.ok(id, `role ${key} is missing from school ${schoolId}`)
  return id
}

/** A delivery adapter a test controls: it can fail, hang, then recover. */
export interface ScriptedDelivery extends DeliveryAdapter {
  mode: 'sandbox'
  /** When true, every send rejects. */
  failing: boolean
  readonly attempts: { to: string; purpose: string }[]
}

export function createScriptedDelivery(): ScriptedDelivery {
  const outbox: DeliveryMessage[] = []
  const attempts: { to: string; purpose: string }[] = []
  return {
    mode: 'sandbox',
    failing: false,
    outbox,
    attempts,
    async send(message) {
      attempts.push({ to: message.to, purpose: message.purpose })
      if (this.failing) throw new Error('delivery provider unavailable')
      outbox.push({ ...message, sentAt: new Date().toISOString() })
    },
    async sendMessage(message) {
      attempts.push({ to: message.to, purpose: 'message' })
      if (this.failing) throw new Error('delivery provider unavailable')
      outbox.push({
        channel: 'email',
        to: message.to,
        purpose: 'message',
        secret: '',
        subject: message.subject,
        sentAt: new Date().toISOString(),
      })
    },
  }
}

/**
 * The harness's TestServer plus the route table. `fastify` is not a dependency
 * of this package, so the app instance stays inside startServerWith and only
 * the printed routes are exposed.
 */
export interface CustomServer extends TestServer {
  printRoutes(): string
}

/**
 * The harness's server with one dependency replaced. The harness cannot inject
 * a delivery adapter, and the delivery-failure and degraded-service rows both
 * need one, so the same wiring is repeated here rather than edited there.
 */
export async function startServerWith(options: {
  delivery?: DeliveryAdapter
  env?: Record<string, string>
  /** Tests only: the assistant's scripted model (and, if given, its tools). */
  assistant?: Parameters<typeof buildApp>[0]['assistant']
}): Promise<CustomServer> {
  const port = await freePort()
  const config = loadConfig(testEnv(port, options.env ?? {}))
  const pools = await createPools(config)
  const delivery = options.delivery ?? createScriptedDelivery()
  const auth = createAuth(config, pools.auth, delivery, pools.identity)
  const documents = createMemoryDocumentStorage()
  const app = buildApp({ config, auth, delivery, pools, documents, assistant: options.assistant })
  await app.listen({ port: config.PORT, host: '127.0.0.1' })
  const origin = `http://127.0.0.1:${config.PORT}`
  const jar = new CookieJar()
  return {
    printRoutes: () => app.printRoutes({ commonPrefix: false }),
    config,
    auth,
    delivery,
    pools,
    documents,
    origin,
    jar,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers)
      const cookie = jar.header()
      if (cookie && !headers.has('cookie')) headers.set('cookie', cookie)
      if (!headers.has('origin')) headers.set('origin', origin)
      const response = await fetch(`${origin}${path}`, { ...init, headers })
      jar.capture(response)
      return response
    },
    async close() {
      await app.close()
      await pools.close().catch(() => undefined)
    },
  }
}

/** A subject of this school, created once and reused by id. */
export async function ensureSubject(schoolId: string, code: string): Promise<string> {
  const pool = adminPool()
  await pool.query(
    `INSERT INTO subjects (id, school_id, name, code, type)
     VALUES (gen_random_uuid(), $1, $2, $3, 'scholastic')
     ON CONFLICT (school_id, code) DO NOTHING`,
    [schoolId, `Subject ${code}`, code],
  )
  const found = await pool.query<{ id: string }>(
    'SELECT id FROM subjects WHERE school_id = $1 AND code = $2',
    [schoolId, code],
  )
  const id = found.rows[0]?.id
  assert.ok(id, 'the subject was not created')
  return id
}

/** A section of this school's fixture year and grade, created once by name. */
export async function ensureSection(
  schoolId: string,
  academicYearId: string,
  gradeId: string,
  name: string,
): Promise<string> {
  const pool = adminPool()
  await pool.query(
    `INSERT INTO sections (id, school_id, academic_year_id, grade_id, name)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (school_id, academic_year_id, grade_id, name) DO NOTHING`,
    [schoolId, academicYearId, gradeId, name],
  )
  const found = await pool.query<{ id: string }>(
    `SELECT id FROM sections
      WHERE school_id = $1 AND academic_year_id = $2 AND grade_id = $3 AND name = $4`,
    [schoolId, academicYearId, gradeId, name],
  )
  const id = found.rows[0]?.id
  assert.ok(id, 'the section was not created')
  return id
}

/** A student of this school, enrolled in one section of one year. */
export async function createEnrolledStudent(input: {
  schoolId: string
  academicYearId: string
  sectionId: string
  firstName: string
  admissionNumber: string
  rollNumber: number
}): Promise<string> {
  const pool = adminPool()
  const studentId = randomUUID()
  await pool.query(
    `INSERT INTO students (id, school_id, admission_number, first_name, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [studentId, input.schoolId, input.admissionNumber, input.firstName],
  )
  await pool.query(
    `INSERT INTO enrollments
       (id, school_id, student_id, academic_year_id, section_id, roll_number, joined_on)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '2026-04-01')`,
    [input.schoolId, studentId, input.academicYearId, input.sectionId, input.rollNumber],
  )
  return studentId
}

/** A teaching member with a staff profile and the given section assignments. */
export async function createTeacher(input: {
  schoolId: string
  academicYearId: string
  sectionIds: readonly string[]
  subjectId: string
  employeeCode: string
}): Promise<Member & { staffId: string }> {
  const pool = adminPool()
  const member = await createMember(input.schoolId, ['teacher'], 'Security Teacher')
  const staffId = randomUUID()
  await pool.query(
    `INSERT INTO staff (id, school_id, employee_code, first_name, staff_type, designation, status)
     VALUES ($1, $2, $3, 'Security', 'teaching', 'Teacher', 'active')`,
    [staffId, input.schoolId, input.employeeCode],
  )
  await pool.query(
    `INSERT INTO membership_staff_links (school_id, membership_id, staff_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [input.schoolId, member.membershipId, staffId],
  )
  for (const sectionId of input.sectionIds) {
    await pool.query(
      `INSERT INTO teaching_assignments
         (school_id, staff_id, academic_year_id, section_id, subject_id, effective_from)
       VALUES ($1, $2, $3, $4, $5, '2026-04-01') ON CONFLICT DO NOTHING`,
      [input.schoolId, staffId, input.academicYearId, sectionId, input.subjectId],
    )
  }
  return { ...member, staffId }
}

/**
 * Give a membership an approved portal link to one student: a guardian row, a
 * verified membership link, the family relation and the portal grant. Nothing
 * in the API writes guardian_student_access, so the tests write it.
 */
export async function grantPortalAccess(input: {
  schoolId: string
  membershipId: string
  studentId: string
  approvedBy: string
  areas?: readonly string[]
}): Promise<{ guardianId: string }> {
  const pool = adminPool()
  const guardianId = randomUUID()
  await pool.query(
    `INSERT INTO guardians (id, school_id, first_name, phone) VALUES ($1, $2, 'Portal Guardian', $3)`,
    [guardianId, input.schoolId, `9${Math.floor(100000000 + Math.random() * 899999999)}`],
  )
  await pool.query(
    `INSERT INTO membership_guardian_links (school_id, membership_id, guardian_id, verified_at)
     VALUES ($1, $2, $3, now()) ON CONFLICT DO NOTHING`,
    [input.schoolId, input.membershipId, guardianId],
  )
  await pool.query(
    `INSERT INTO student_guardians (school_id, student_id, guardian_id, relation)
     VALUES ($1, $2, $3, 'guardian') ON CONFLICT DO NOTHING`,
    [input.schoolId, input.studentId, guardianId],
  )
  await pool.query(
    `INSERT INTO guardian_student_access
       (school_id, guardian_id, student_id, status, areas, approved_by_membership_id, approved_at)
     VALUES ($1, $2, $3, 'approved', $4::text[], $5, now()) ON CONFLICT DO NOTHING`,
    [input.schoolId, guardianId, input.studentId, [...(input.areas ?? ['basic'])], input.approvedBy],
  )
  return { guardianId }
}

/** Write a person-specific exception exactly as the access rules table stores it. */
export async function writeExceptionRule(input: {
  schoolId: string
  membershipId: string
  permission: string
  effect: 'allow' | 'deny'
  targetType: 'school' | 'section' | 'student' | 'staff' | 'document'
  targetId?: string
  authorMembershipId: string
  effectiveFrom?: string
  expiresAt?: string | null
}): Promise<string> {
  const column = {
    school: null,
    section: 'section_id',
    student: 'student_id',
    staff: 'staff_id',
    document: 'document_id',
  }[input.targetType]
  const id = randomUUID()
  const columns = ['id', 'school_id', 'membership_id', 'permission', 'effect', 'target_type',
    'effective_from', 'expires_at', 'reason', 'author_membership_id']
  const values: unknown[] = [
    id, input.schoolId, input.membershipId, input.permission, input.effect, input.targetType,
    input.effectiveFrom ?? '2020-01-01', input.expiresAt === undefined ? '2099-01-01' : input.expiresAt,
    'security acceptance suite', input.authorMembershipId,
  ]
  if (column) {
    columns.push(column)
    values.push(input.targetId)
  }
  await adminPool().query(
    `INSERT INTO resource_access_rules (${columns.join(',')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(',')})`,
    values,
  )
  return id
}
