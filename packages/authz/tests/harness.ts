import pg from 'pg'

import { createPool, withTenantTransaction } from '@erp/db'
import { fixtureIds, seedFixtures } from '@erp/db/fixtures'
import { ROLE_TEMPLATES } from '@erp/contracts'
import type { RoleKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'

import type { AuthzConnection } from '../src/snapshot.ts'

const connectionString = process.env.TEST_DATABASE_URL
if (!connectionString) {
  throw new Error('TEST_DATABASE_URL must name a disposable PostgreSQL database')
}
if (new URL(connectionString).pathname === '/erp') {
  throw new Error(
    'The authz tests refuse to run against "erp", the development database; use erp_test (pnpm db:test:prepare)',
  )
}

/** Superuser pool. Used only to seed fixtures and insert extra test rows. */
export const migrator = new pg.Pool({ connectionString, max: 4 })

const runtimeUrl = new URL(connectionString)
runtimeUrl.username = 'erp_runtime'
runtimeUrl.password = 'erp_runtime'
/** The pool the library runs on: non-owner, row level security enforced. */
export const runtime = createPool({ connectionString: runtimeUrl.toString(), max: 4 })

export { fixtureIds }

export const NOW = '2026-06-15T09:00:00.000Z'

let seeded: Promise<void> | null = null
export async function seed(): Promise<void> {
  seeded ??= seedFixtures(migrator)
  await seeded
}

export interface ContextInput {
  schoolId: string
  membershipId: string
  roleKeys: readonly RoleKey[]
  userId?: string
  assurance?: 'single_factor' | 'mfa'
  accessVersion?: number
  membershipKind?: 'adult' | 'student'
  now?: string
}

/** Builds a RequestContext exactly as apps/api/src/auth/request-context.ts does. */
export function contextFor(input: ContextInput): RequestContext {
  const assurance = input.assurance ?? 'mfa'
  const now = input.now ?? NOW
  return Object.freeze({
    requestId: crypto.randomUUID(),
    userId: input.userId ?? crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    schoolId: input.schoolId,
    membershipId: input.membershipId,
    membershipKind: input.membershipKind ?? 'adult',
    accessVersion: input.accessVersion ?? 1,
    roleKeys: Object.freeze([...input.roleKeys]),
    assurance,
    mfaVerifiedAt: assurance === 'mfa' ? now : null,
    now,
  }) as unknown as RequestContext
}

export async function withRuntime<T>(
  context: RequestContext,
  work: (conn: AuthzConnection) => Promise<T>,
): Promise<T> {
  return withTenantTransaction(runtime, context, work)
}

/** Undo statements for every row this run created, in insertion order. */
const created: { text: string; params: readonly unknown[] }[] = []

function rememberDelete(text: string, params: readonly unknown[]): void {
  created.push({ text, params })
}

function remember(table: string, id: string): string {
  rememberDelete(`DELETE FROM ${table} WHERE id = $1`, [id])
  return id
}

export async function insertSubject(schoolId: string, code = `SUB-${Date.now()}`): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO subjects(id, school_id, name, code, type) VALUES ($1,$2,'Test subject',$3,'scholastic')`,
    [id, schoolId, `${code}-${id.slice(0, 8)}`],
  )
  return remember('subjects', id)
}

export async function insertAcademicYear(
  schoolId: string,
  name = 'Test year',
): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO academic_years(id, school_id, name, start_date, end_date, status)
     VALUES ($1,$2,$3,'2026-04-01','2027-03-31','current')`,
    [id, schoolId, `${name}-${id.slice(0, 8)}`],
  )
  return remember('academic_years', id)
}

export async function insertGrade(schoolId: string, order = 6): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO grades(id, school_id, name, short_name, sort_order) VALUES ($1,$2,$3,$4,$5)`,
    [id, schoolId, `Grade-${id.slice(0, 8)}`, id.slice(0, 4), order],
  )
  return remember('grades', id)
}

export async function insertSection(
  schoolId: string,
  academicYearId: string,
  gradeId: string,
  name: string,
): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO sections(id, school_id, academic_year_id, grade_id, name) VALUES ($1,$2,$3,$4,$5)`,
    [id, schoolId, academicYearId, gradeId, `${name}-${id.slice(0, 8)}`],
  )
  return remember('sections', id)
}

export async function insertStudent(schoolId: string, label = 'Test'): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO students(id, school_id, admission_number, first_name, status) VALUES ($1,$2,$3,$4,'active')`,
    [id, schoolId, `ADM-${id.slice(0, 8)}`, label],
  )
  return remember('students', id)
}

export async function insertStaff(schoolId: string): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO staff(id, school_id, employee_code, first_name, staff_type, designation, status)
     VALUES ($1,$2,$3,'Test','teaching','Teacher','active')`,
    [id, schoolId, `EMP-${id.slice(0, 8)}`],
  )
  return remember('staff', id)
}

export async function insertEnrollment(input: {
  schoolId: string
  studentId: string
  academicYearId: string
  sectionId: string
  joinedOn?: string
  leftOn?: string | null
}): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO enrollments(id, school_id, student_id, academic_year_id, section_id, joined_on, left_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      input.schoolId,
      input.studentId,
      input.academicYearId,
      input.sectionId,
      input.joinedOn ?? '2026-04-01',
      input.leftOn ?? null,
    ],
  )
  return remember('enrollments', id)
}

export async function insertTeachingAssignment(input: {
  schoolId: string
  staffId: string
  academicYearId: string
  sectionId: string
  subjectId: string
  effectiveFrom?: string
  effectiveTo?: string | null
}): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO teaching_assignments(id, school_id, staff_id, academic_year_id, section_id, subject_id, effective_from, effective_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      input.schoolId,
      input.staffId,
      input.academicYearId,
      input.sectionId,
      input.subjectId,
      input.effectiveFrom ?? '2026-04-01',
      input.effectiveTo ?? null,
    ],
  )
  return remember('teaching_assignments', id)
}

export async function insertTimetableEntry(input: {
  schoolId: string
  academicYearId: string
  sectionId: string
  subjectId: string
  dayOfWeek: number
  periodIndex: number
  staffId?: string | null
}): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO timetable_entries(id, school_id, academic_year_id, section_id, day_of_week, period_index, subject_id, staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      input.schoolId,
      input.academicYearId,
      input.sectionId,
      input.dayOfWeek,
      input.periodIndex,
      input.subjectId,
      input.staffId ?? null,
    ],
  )
  return remember('timetable_entries', id)
}

export async function insertSubstitution(input: {
  schoolId: string
  date: string
  sectionId: string
  periodIndex: number
  subjectId: string
  absentStaffId: string
  substituteStaffId?: string | null
}): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO substitutions(id, school_id, date, section_id, period_index, subject_id, absent_staff_id, substitute_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      input.schoolId,
      input.date,
      input.sectionId,
      input.periodIndex,
      input.subjectId,
      input.absentStaffId,
      input.substituteStaffId ?? null,
    ],
  )
  return remember('substitutions', id)
}

/** Creates a user, a membership and its role rows, returning the membership id. */
export async function insertMembership(input: {
  schoolId: string
  roleKeys: readonly RoleKey[]
  kind?: 'adult' | 'student'
  status?: 'active' | 'suspended' | 'removed'
}): Promise<{ membershipId: string; userId: string }> {
  const userId = crypto.randomUUID()
  const membershipId = crypto.randomUUID()
  await migrator.query(`INSERT INTO auth_user(id, name, email) VALUES ($1,'Test',$2)`, [
    userId,
    `authz-${userId}@test`,
  ])
  rememberDelete(`DELETE FROM auth_user WHERE id = $1`, [userId])
  await migrator.query(
    `INSERT INTO school_memberships(id, school_id, user_id, kind, status) VALUES ($1,$2,$3,$4,$5)`,
    [membershipId, input.schoolId, userId, input.kind ?? 'adult', input.status ?? 'active'],
  )
  // Undo runs newest first, so the child rows must be remembered last.
  rememberDelete(`DELETE FROM school_memberships WHERE id = $1`, [membershipId])
  rememberDelete(`DELETE FROM membership_roles WHERE membership_id = $1`, [membershipId])
  for (const key of input.roleKeys) {
    const role = await migrator.query<{ id: string }>(
      `SELECT id FROM roles WHERE school_id = $1 AND key = $2`,
      [input.schoolId, key],
    )
    const roleId = role.rows[0]?.id
    if (!roleId) throw new Error(`Fixture role ${key} is missing; check seedFixtures`)
    await migrator.query(
      `INSERT INTO membership_roles(school_id, membership_id, role_id) VALUES ($1,$2,$3)`,
      [input.schoolId, membershipId, roleId],
    )
  }
  return { membershipId, userId }
}

export async function insertGuardian(schoolId: string, name = 'Test guardian'): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(`INSERT INTO guardians(id, school_id, first_name) VALUES ($1,$2,$3)`, [
    id,
    schoolId,
    name,
  ])
  return remember('guardians', id)
}

/** Links a membership to a guardian record without granting access to a child. */
export async function insertGuardianLink(
  schoolId: string,
  membershipId: string,
  guardianId: string,
): Promise<void> {
  await migrator.query(
    `INSERT INTO membership_guardian_links(school_id, membership_id, guardian_id, verified_at)
     VALUES ($1,$2,$3,'2026-01-01')`,
    [schoolId, membershipId, guardianId],
  )
  rememberDelete(`DELETE FROM membership_guardian_links WHERE school_id = $1 AND membership_id = $2`, [
    schoolId,
    membershipId,
  ])
}

/**
 * A pupil's own login: an active student membership holding the student role,
 * linked to the pupil through membership_student_links.
 */
export async function insertStudentLogin(
  schoolId: string,
  studentId: string,
): Promise<{ membershipId: string; userId: string }> {
  const member = await insertMembership({ schoolId, roleKeys: ['student'], kind: 'student' })
  await migrator.query(
    `INSERT INTO membership_student_links(school_id, membership_id, student_id) VALUES ($1,$2,$3)`,
    [schoolId, member.membershipId, studentId],
  )
  rememberDelete(`DELETE FROM membership_student_links WHERE school_id = $1 AND membership_id = $2`, [
    schoolId,
    member.membershipId,
  ])
  return member
}

export async function insertMembershipStaffLink(
  schoolId: string,
  membershipId: string,
  staffId: string,
): Promise<void> {
  await migrator.query(
    `INSERT INTO membership_staff_links(school_id, membership_id, staff_id) VALUES ($1,$2,$3)`,
    [schoolId, membershipId, staffId],
  )
  rememberDelete(`DELETE FROM membership_staff_links WHERE school_id = $1 AND membership_id = $2`, [
    schoolId,
    membershipId,
  ])
}

/** The row that says a class studies a subject in a year. */
export async function insertGradeSubject(input: {
  schoolId: string
  gradeId: string
  academicYearId: string
  subjectId: string
}): Promise<void> {
  await migrator.query(
    `INSERT INTO grade_subjects(school_id, grade_id, academic_year_id, subject_id) VALUES ($1,$2,$3,$4)`,
    [input.schoolId, input.gradeId, input.academicYearId, input.subjectId],
  )
  rememberDelete(
    `DELETE FROM grade_subjects WHERE school_id = $1 AND grade_id = $2 AND academic_year_id = $3 AND subject_id = $4`,
    [input.schoolId, input.gradeId, input.academicYearId, input.subjectId],
  )
}

export async function insertAccessRule(input: {
  schoolId: string
  membershipId: string
  permission: string
  effect: 'allow' | 'deny'
  targetType: 'school' | 'section' | 'student' | 'staff' | 'document'
  sectionId?: string
  academicYearId?: string
  studentId?: string
  staffId?: string
  documentId?: string
  effectiveFrom?: string
  expiresAt?: string | null
  revokedAt?: string | null
  authorMembershipId: string
}): Promise<string> {
  const id = crypto.randomUUID()
  await migrator.query(
    `INSERT INTO resource_access_rules(id, school_id, membership_id, permission, effect, target_type,
        academic_year_id, section_id, student_id, staff_id, document_id, effective_from, expires_at,
        revoked_at, reason, author_membership_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'authz test rule',$15)`,
    [
      id,
      input.schoolId,
      input.membershipId,
      input.permission,
      input.effect,
      input.targetType,
      input.academicYearId ?? null,
      input.sectionId ?? null,
      input.studentId ?? null,
      input.staffId ?? null,
      input.documentId ?? null,
      input.effectiveFrom ?? '2026-01-01T00:00:00.000Z',
      input.expiresAt === undefined ? null : input.expiresAt,
      input.revokedAt ?? null,
      input.authorMembershipId,
    ],
  )
  return remember('resource_access_rules', id)
}

export async function bumpAccessVersion(schoolId: string, membershipId: string): Promise<void> {
  await migrator.query(
    `UPDATE school_memberships SET access_version = access_version + 1, version = version + 1
      WHERE school_id = $1 AND id = $2`,
    [schoolId, membershipId],
  )
}

export async function resetVersions(schoolId: string, membershipId: string): Promise<void> {
  await migrator.query(
    `UPDATE school_memberships SET access_version = 1, version = 1 WHERE school_id = $1 AND id = $2`,
    [schoolId, membershipId],
  )
}

/** Removes every row this run created, newest first, then closes the pools. */
export async function cleanup(): Promise<void> {
  for (const statement of [...created].reverse()) {
    await migrator.query(statement.text, [...statement.params])
  }
  created.length = 0
  await migrator.end()
  await runtime.end()
}

export const ALL_ROLE_KEYS = Object.keys(ROLE_TEMPLATES) as RoleKey[]

/** Fixture ids are declared as a string map, so read them through this guard. */
export function fx(name: string): string {
  const value = fixtureIds[name]
  if (value === undefined) throw new Error(`Unknown fixture id: ${name}`)
  return value
}
