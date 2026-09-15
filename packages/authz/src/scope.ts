import { and, eq, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import {
  academicYears,
  enrollments,
  grades,
  guardians,
  holidays,
  sections,
  staff,
  studentDocuments,
  students,
  subjects,
} from '@erp/db/schema'
import { PERMISSION_CATALOGUE, PermissionKey, ROLE_TEMPLATES } from '@erp/contracts'
import type { AccessScope, ResourceAccessRule, ResourceType, RoleKey } from '@erp/contracts'
import type { AuthorizedReadPlan, PolicySnapshot, RequestContext } from '@erp/contracts/server'

import { AuthorizationError } from './errors.ts'
import type { RelationshipFacts } from './policy.ts'
import type { AuthzConnection } from './snapshot.ts'

/** A (section, year) pair the member teaches. Both parts must match together. */
interface AssignedPair {
  readonly sectionId: string
  readonly academicYearId: string
}

interface PlanInternals {
  readonly scopes: readonly AccessScope[]
  readonly allows: readonly ResourceAccessRule[]
  readonly denies: readonly ResourceAccessRule[]
  readonly pairs: readonly AssignedPair[]
  readonly subjectIds: readonly string[]
  readonly childStudentIds: readonly string[]
  readonly selfStaffId: string | null
}

/**
 * Plan internals never travel with the plan object, so a caller can neither
 * read the matched scopes nor forge a plan that widens them.
 */
const internals = new WeakMap<AuthorizedReadPlan, PlanInternals>()

/** The columns a predicate needs from the table being listed. */
export interface ScopedTable {
  readonly table: PgTable
  readonly schoolId: PgColumn
  readonly id: PgColumn
  readonly studentId?: PgColumn
  readonly sectionId?: PgColumn
  readonly academicYearId?: PgColumn
  readonly gradeId?: PgColumn
}

const SCOPED_TABLES: Partial<Record<ResourceType, ScopedTable>> = {
  student: { table: students, schoolId: students.schoolId, id: students.id },
  staff: { table: staff, schoolId: staff.schoolId, id: staff.id },
  section: {
    table: sections,
    schoolId: sections.schoolId,
    id: sections.id,
    academicYearId: sections.academicYearId,
    gradeId: sections.gradeId,
  },
  enrollment: {
    table: enrollments,
    schoolId: enrollments.schoolId,
    id: enrollments.id,
    studentId: enrollments.studentId,
    sectionId: enrollments.sectionId,
    academicYearId: enrollments.academicYearId,
  },
  student_document: {
    table: studentDocuments,
    schoolId: studentDocuments.schoolId,
    id: studentDocuments.id,
    studentId: studentDocuments.studentId,
  },
  subject: { table: subjects, schoolId: subjects.schoolId, id: subjects.id },
  grade: { table: grades, schoolId: grades.schoolId, id: grades.id },
  academic_year: { table: academicYears, schoolId: academicYears.schoolId, id: academicYears.id },
  holiday: { table: holidays, schoolId: holidays.schoolId, id: holidays.id },
  guardian: { table: guardians, schoolId: guardians.schoolId, id: guardians.id },
}

/** The table a plan of this resource type lists, or null when there is none. */
export function scopedTableFor(resourceType: ResourceType): ScopedTable | null {
  return SCOPED_TABLES[resourceType] ?? null
}

const TRUE = sql`TRUE`
const FALSE = sql`FALSE`

function ruleApplicableAt(rule: ResourceAccessRule, now: number): boolean {
  if (rule.revokedAt !== null) return false
  if (Date.parse(rule.validFrom) > now) return false
  return rule.expiresAt === null || Date.parse(rule.expiresAt) > now
}

/** The scope an exception behaves like when action level MFA is decided. */
function scopeOfRuleTarget(rule: ResourceAccessRule): AccessScope {
  return rule.target.kind === 'section' ? 'assigned_sections' : 'school'
}

export function createReadPlan(
  context: RequestContext,
  permission: PermissionKey,
  resourceType: ResourceType,
  snapshot: PolicySnapshot,
  facts: RelationshipFacts,
): AuthorizedReadPlan {
  // Steps 1 to 5 of evaluate, in the same order, so a list can never answer
  // what a single read would refuse.
  if (!PermissionKey.safeParse(permission).success) throw new AuthorizationError('ACCESS_DENIED')
  const metadata = PERMISSION_CATALOGUE[permission]
  if (metadata.availability !== 'active') throw new AuthorizationError('ACCESS_DENIED')
  if (context.membershipKind === 'student' || context.roleKeys.includes('student')) {
    throw new AuthorizationError('FEATURE_DISABLED')
  }
  if (resourceType !== metadata.resourceType) throw new AuthorizationError('RESOURCE_NOT_FOUND')
  if (snapshot.accessVersion !== context.accessVersion) throw new AuthorizationError('ACCESS_DENIED')
  if (context.roleKeys.some((role: RoleKey) => ROLE_TEMPLATES[role].requiredMfa) && context.assurance !== 'mfa') {
    throw new AuthorizationError('MFA_REQUIRED')
  }

  const now = Date.parse(context.now)
  const applicable = snapshot.exceptions.filter(
    (rule) =>
      rule.permission === permission &&
      rule.schoolId === context.schoolId &&
      rule.membershipId === context.membershipId &&
      ruleApplicableAt(rule, now),
  )
  const denies = applicable.filter((rule) => rule.effect === 'deny')
  const allAllows = applicable.filter((rule) => rule.effect === 'allow')
  const allScopes = snapshot.grants
    .filter((grant) => grant.permission === permission)
    .map((grant) => grant.scope)
  if (allScopes.length === 0 && allAllows.length === 0) throw new AuthorizationError('ACCESS_DENIED')

  // Action level MFA drops the privileged rows from the plan rather than
  // failing the whole list, so a single factor session still sees what it may.
  const privileged: readonly AccessScope[] = metadata.privilegedScopes
  const weak = context.assurance !== 'mfa'
  const scopes = weak ? allScopes.filter((scope) => !privileged.includes(scope)) : allScopes
  const allows = weak ? allAllows.filter((rule) => !privileged.includes(scopeOfRuleTarget(rule))) : allAllows
  if (scopes.length === 0 && allows.length === 0) throw new AuthorizationError('MFA_REQUIRED')

  const pairs: AssignedPair[] = []
  for (const assignment of facts.assignments) {
    if (pairs.some((p) => p.sectionId === assignment.sectionId && p.academicYearId === assignment.academicYearId)) {
      continue
    }
    pairs.push({ sectionId: assignment.sectionId, academicYearId: assignment.academicYearId })
  }

  const plan = Object.freeze({
    schoolId: context.schoolId,
    membershipId: context.membershipId,
    permission,
    resourceType,
    accessVersion: snapshot.accessVersion,
  }) as unknown as AuthorizedReadPlan

  internals.set(plan, {
    scopes: [...new Set(scopes)],
    allows,
    denies,
    pairs,
    subjectIds: [...new Set(facts.assignments.map((assignment) => assignment.subjectId))],
    childStudentIds: [...facts.ownChildStudentIds],
    selfStaffId: facts.selfStaffId,
  })
  return plan
}

function pairTerm(sectionColumn: SQL | PgColumn, yearColumn: SQL | PgColumn, pairs: readonly AssignedPair[]): SQL {
  if (pairs.length === 0) return FALSE
  const tuples = pairs.map((pair) => sql`(${pair.sectionId}::uuid, ${pair.academicYearId}::uuid)`)
  return sql`(${sectionColumn}, ${yearColumn}) IN (${sql.join(tuples, sql`, `)})`
}

function idInTerm(column: PgColumn, ids: readonly string[]): SQL {
  if (ids.length === 0) return FALSE
  return sql`${column} IN (${sql.join(
    ids.map((value) => sql`${value}::uuid`),
    sql`, `,
  )})`
}

/** Current enrollments of a student id expression, restricted by a predicate. */
function enrollmentExists(studentIdExpression: PgColumn, schoolColumn: PgColumn, restriction: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM enrollments e
      WHERE e.school_id = ${schoolColumn} AND e.student_id = ${studentIdExpression}
        AND e.left_on IS NULL AND ${restriction})`
}

function assignedSectionsTerm(plan: AuthorizedReadPlan, table: ScopedTable, pairs: readonly AssignedPair[]): SQL {
  if (pairs.length === 0) return FALSE
  const enrolledPairs = pairTerm(sql`e.section_id`, sql`e.academic_year_id`, pairs)
  switch (plan.resourceType) {
    case 'student':
      return enrollmentExists(table.id, table.schoolId, enrolledPairs)
    case 'student_document':
      return table.studentId === undefined
        ? FALSE
        : enrollmentExists(table.studentId, table.schoolId, enrolledPairs)
    case 'section':
      return table.academicYearId === undefined ? FALSE : pairTerm(table.id, table.academicYearId, pairs)
    case 'enrollment':
      return table.sectionId === undefined || table.academicYearId === undefined
        ? FALSE
        : pairTerm(table.sectionId, table.academicYearId, pairs)
    case 'grade':
      return sql`EXISTS (SELECT 1 FROM sections sec
          WHERE sec.school_id = ${table.schoolId} AND sec.grade_id = ${table.id}
            AND ${pairTerm(sql`sec.id`, sql`sec.academic_year_id`, pairs)})`
    default:
      return FALSE
  }
}

function ownChildrenTerm(plan: AuthorizedReadPlan, table: ScopedTable, childIds: readonly string[]): SQL {
  if (childIds.length === 0) return FALSE
  const childList = sql.join(
    childIds.map((value) => sql`${value}::uuid`),
    sql`, `,
  )
  switch (plan.resourceType) {
    case 'student':
      return idInTerm(table.id, childIds)
    case 'enrollment':
    case 'student_document':
      return table.studentId === undefined ? FALSE : idInTerm(table.studentId, childIds)
    case 'section':
      return enrollmentExistsForChildren(sql`e.section_id = ${table.id}`, table, childList)
    case 'grade':
      return enrollmentExistsForChildren(
        sql`EXISTS (SELECT 1 FROM sections sec WHERE sec.school_id = e.school_id
              AND sec.id = e.section_id AND sec.grade_id = ${table.id})`,
        table,
        childList,
      )
    case 'subject':
      // A subject is a shared row, so a parent reaches it through the class a
      // child is enrolled in and the subjects that class studies this year.
      return enrollmentExistsForChildren(
        sql`EXISTS (SELECT 1 FROM sections sec
              JOIN grade_subjects gs ON gs.school_id = sec.school_id AND gs.grade_id = sec.grade_id
               AND gs.academic_year_id = e.academic_year_id AND gs.subject_id = ${table.id}
             WHERE sec.school_id = e.school_id AND sec.id = e.section_id)`,
        table,
        childList,
      )
    default:
      return FALSE
  }
}

function enrollmentExistsForChildren(restriction: SQL, table: ScopedTable, childList: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM enrollments e
      WHERE e.school_id = ${table.schoolId} AND e.left_on IS NULL
        AND e.student_id IN (${childList}) AND ${restriction})`
}

function scopeTerm(plan: AuthorizedReadPlan, table: ScopedTable, scope: AccessScope, parts: PlanInternals): SQL {
  switch (scope) {
    case 'school':
    case 'finance':
      return TRUE
    case 'self':
      if (plan.resourceType !== 'staff' || parts.selfStaffId === null) return FALSE
      return sql`${table.id} = ${parts.selfStaffId}::uuid`
    case 'assigned_sections':
      return assignedSectionsTerm(plan, table, parts.pairs)
    case 'assigned_subjects':
      return plan.resourceType === 'subject' ? idInTerm(table.id, parts.subjectIds) : FALSE
    case 'own_children':
      return ownChildrenTerm(plan, table, parts.childStudentIds)
    case 'own_record':
      // Student login is disabled, so this scope never selects a row.
      return FALSE
  }
}

function ruleTerm(plan: AuthorizedReadPlan, table: ScopedTable, rule: ResourceAccessRule): SQL {
  const target = rule.target
  switch (target.kind) {
    case 'school':
      return TRUE
    case 'section':
      return assignedSectionsTerm(plan, table, [
        { sectionId: target.sectionId, academicYearId: target.academicYearId },
      ])
    case 'student':
      if (plan.resourceType === 'student') return sql`${table.id} = ${target.studentId}::uuid`
      if (table.studentId === undefined) return FALSE
      return sql`${table.studentId} = ${target.studentId}::uuid`
    case 'staff':
      return plan.resourceType === 'staff' ? sql`${table.id} = ${target.staffId}::uuid` : FALSE
    case 'document':
      return plan.resourceType === 'student_document' ? sql`${table.id} = ${target.documentId}::uuid` : FALSE
  }
}

function orTerms(terms: readonly SQL[]): SQL {
  if (terms.length === 0) return FALSE
  return sql`(${sql.join([...terms], sql` OR `)})`
}

/** The boolean a list or detail read must add to its WHERE clause. */
export function planPredicate(plan: AuthorizedReadPlan, table: ScopedTable): SQL {
  const parts = internals.get(plan)
  if (!parts) throw new AuthorizationError('ACCESS_DENIED', 'This read plan was not issued by the authorizer.')

  const allowTerms = [
    ...parts.scopes.map((scope) => scopeTerm(plan, table, scope, parts)),
    ...parts.allows.map((rule) => ruleTerm(plan, table, rule)),
  ]
  const denyTerms = parts.denies.map((rule) => ruleTerm(plan, table, rule))
  const base = sql`${table.schoolId} = ${plan.schoolId}::uuid AND ${orTerms(allowTerms)}`
  if (denyTerms.length === 0) return base
  return sql`${base} AND NOT ${orTerms(denyTerms)}`
}

export interface PageRequest {
  readonly page: number
  readonly pageSize: number
}

/** Lists the rows this plan allows. Projection is the caller's job. */
export async function scopedList<T>(
  conn: AuthzConnection,
  plan: AuthorizedReadPlan,
  table: ScopedTable,
  page: PageRequest,
): Promise<{ items: readonly T[]; total: number }> {
  const where = planPredicate(plan, table)
  const pageSize = Math.max(1, Math.trunc(page.pageSize))
  const offset = Math.max(0, (Math.max(1, Math.trunc(page.page)) - 1) * pageSize)
  const rows = await conn.db
    .select()
    .from(table.table)
    .where(where)
    .orderBy(table.id)
    .limit(pageSize)
    .offset(offset)
  const counted = (await conn.db
    .select({ total: sql<number>`count(*)::int` })
    .from(table.table)
    .where(where)) as { total: number }[]
  return { items: rows as readonly T[], total: counted[0]?.total ?? 0 }
}

/** Reads one row through the same predicate, so detail matches the list. */
export async function scopedGet<T>(
  conn: AuthzConnection,
  plan: AuthorizedReadPlan,
  table: ScopedTable,
  id: string,
): Promise<T | null> {
  const where = and(planPredicate(plan, table), eq(table.id, id))
  if (where === undefined) return null
  const rows = await conn.db.select().from(table.table).where(where).orderBy(table.id).limit(1).offset(0)
  return (rows[0] as T | undefined) ?? null
}
