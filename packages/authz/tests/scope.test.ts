import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { FINANCE_AUDIT_ACTIONS, isFinanceAuditAction } from '@erp/contracts'
import type { PermissionKey, ResourceType } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'

import { sql } from 'drizzle-orm'

import { createAuthorizationService } from '../src/service.ts'
import {
  attendanceScopedTable,
  createReadPlan,
  examScopedTable,
  feeScopedTable,
  planPredicate,
  reportCardScopedTable,
  scopedGet,
  scopedList,
  scopedTableFor,
  staffAttendanceScopedTable,
} from '../src/scope.ts'
import type { ScopedTable } from '../src/scope.ts'
import {
  cleanup,
  contextFor,
  fx,
  insertAccessRule,
  insertAcademicYear,
  insertEnrollment,
  insertGrade,
  insertGradeSubject,
  insertGuardianLink,
  insertMembership,
  insertMembershipStaffLink,
  insertSection,
  insertStaff,
  insertStudent,
  insertStudentLogin,
  insertSubject,
  insertSubstitution,
  insertTeachingAssignment,
  insertTimetableEntry,
  migrator,
  runtime,
  seed,
  withRuntime,
} from './harness.ts'

const authz = createAuthorizationService({ pool: runtime })

let schoolA = ''
let schoolB = ''
let sectionStudentId = ''
let unrelatedStudentId = ''
let accountant = { membershipId: '', userId: '' }
let deniedAccountant = { membershipId: '', userId: '' }
let teacherNoStaff = { membershipId: '', userId: '' }
let assignedSubjectId = ''
let unassignedSubjectId = ''
let childSectionId = ''
let parentSectionId = ''
let parentEnrollmentId = ''
let ownTimetableId = ''
let sectionTimetableId = ''
let childTimetableId = ''
let parentTimetableId = ''
let unrelatedTimetableId = ''
let sectionSubstitutionId = ''
let parentSubstitutionId = ''
let exceptionTeacher = { membershipId: '', userId: '' }
let financeAuditIds: string[] = []
let otherAuditIds: string[] = []

function tableFor(resourceType: ResourceType): ScopedTable {
  const table = scopedTableFor(resourceType)
  assert.ok(table, `${resourceType} must be listable`)
  return table
}

function studentTable(): ScopedTable {
  return tableFor('student')
}

interface StudentRow {
  id: string
  schoolId: string
}

/** The table each listable resource type reads, for the candidate queries. */
const TABLE_NAMES: Partial<Record<ResourceType, string>> = {
  student: 'students',
  staff: 'staff',
  section: 'sections',
  subject: 'subjects',
  enrollment: 'enrollments',
  student_document: 'student_documents',
  timetable: 'timetable_entries',
  substitution: 'substitutions',
}

async function idsOf(resourceType: ResourceType, schoolId: string): Promise<string[]> {
  const name = TABLE_NAMES[resourceType]
  assert.ok(name, `no candidate query for ${resourceType}`)
  const result = await migrator.query<{ id: string }>(
    `SELECT id FROM ${name} WHERE school_id = $1`,
    [schoolId],
  )
  return result.rows.map((row) => row.id)
}

/** Walks every page of the plan and checks that total agrees with the items. */
async function listRows(
  context: RequestContext,
  permission: PermissionKey,
  resourceType: ResourceType,
  pageSize = 2,
): Promise<string[]> {
  const plan = await authz.scopeQuery(context, permission, resourceType)
  const table = tableFor(resourceType)
  const ids: string[] = []
  let total = -1
  for (let page = 1; ; page += 1) {
    const result = await withRuntime(context, (conn) =>
      scopedList<StudentRow>(conn, plan, table, { page, pageSize }),
    )
    if (total === -1) total = result.total
    assert.equal(result.total, total, 'total must not change between pages')
    for (const row of result.items) {
      assert.equal(row.schoolId, context.schoolId, 'a plan must never return another school')
      ids.push(row.id)
    }
    if (result.items.length < pageSize) break
  }
  assert.equal(ids.length, total, 'total must match the number of rows across all pages')
  return ids
}

async function listStudents(context: RequestContext, pageSize = 2): Promise<string[]> {
  return listRows(context, 'students.read_basic', 'student', pageSize)
}

async function studentsOfSchool(schoolId: string): Promise<string[]> {
  return idsOf('student', schoolId)
}

/** The ids a one by one authorize call would allow, for the same permission. */
async function authorizedIds(
  context: RequestContext,
  permission: PermissionKey,
  resourceType: ResourceType,
  candidates: readonly string[],
): Promise<string[]> {
  const allowed: string[] = []
  for (const id of candidates) {
    const decision = await authz.authorize(context, permission, {
      schoolId: context.schoolId,
      resourceType,
      id,
    })
    if (decision.allowed) allowed.push(id)
  }
  return allowed
}

async function authorizedStudents(context: RequestContext, candidates: readonly string[]): Promise<string[]> {
  return authorizedIds(context, 'students.read_basic', 'student', candidates)
}

/**
 * Asserts that the list and the one by one reads describe the same rows, that
 * no row of the other school appears, and returns the listed ids sorted.
 */
async function agreeOn(input: {
  name: string
  context: RequestContext
  permission: PermissionKey
  resourceType: ResourceType
}): Promise<string[]> {
  const { name, context, permission, resourceType } = input
  const otherSchool = await idsOf(resourceType, schoolB)
  const candidates = [...(await idsOf(resourceType, context.schoolId)), ...otherSchool]
  const listed = await listRows(context, permission, resourceType)
  const expected = await authorizedIds(context, permission, resourceType, candidates)
  assert.deepEqual(
    [...listed].sort(),
    [...expected].sort(),
    `list and detail disagree for ${name} on ${resourceType}`,
  )
  for (const id of otherSchool) {
    assert.equal(listed.includes(id), false, `${name} must never see another school`)
  }
  return [...listed].sort()
}

before(async () => {
  await seed()
  schoolA = fx('schoolA')
  schoolB = fx('schoolB')
  assignedSubjectId = await insertSubject(schoolA)
  unassignedSubjectId = await insertSubject(schoolA)
  await insertTeachingAssignment({
    schoolId: schoolA,
    staffId: fx('staffA'),
    academicYearId: fx('yearA'),
    sectionId: fx('sectionA'),
    subjectId: assignedSubjectId,
  })
  // Only the assigned subject is studied by the fixture class this year, so a
  // parent reaches exactly that subject through their child's enrollment.
  await insertGradeSubject({
    schoolId: schoolA,
    gradeId: fx('gradeA'),
    academicYearId: fx('yearA'),
    subjectId: assignedSubjectId,
  })
  sectionStudentId = await insertStudent(schoolA, 'Section')
  await insertEnrollment({
    schoolId: schoolA,
    studentId: sectionStudentId,
    academicYearId: fx('yearA'),
    sectionId: fx('sectionA'),
  })
  unrelatedStudentId = await insertStudent(schoolA, 'Unrelated')
  // The teacher and parent member's own child sits in a section it does not
  // teach, so the two relationship scopes name different sections.
  childSectionId = await insertSection(schoolA, fx('yearA'), fx('gradeA'), 'Child')
  await insertEnrollment({
    schoolId: schoolA,
    studentId: fx('studentA'),
    academicYearId: fx('yearA'),
    sectionId: childSectionId,
  })
  parentSectionId = await insertSection(schoolA, fx('yearA'), fx('gradeA'), 'Parent')
  parentEnrollmentId = await insertEnrollment({
    schoolId: schoolA,
    studentId: fx('studentA2'),
    academicYearId: fx('yearA'),
    sectionId: parentSectionId,
  })
  // Timetable rows covering every relationship a teacher or parent can have:
  // the teacher's own period, another period in the same class, a period in
  // the class its child sits in, a period in the other parent's child's class
  // and one in a class nobody here is related to.
  ownTimetableId = await insertTimetableEntry({
    schoolId: schoolA,
    academicYearId: fx('yearA'),
    sectionId: fx('sectionA'),
    subjectId: assignedSubjectId,
    dayOfWeek: 1,
    periodIndex: 0,
    staffId: fx('staffA'),
  })
  sectionTimetableId = await insertTimetableEntry({
    schoolId: schoolA,
    academicYearId: fx('yearA'),
    sectionId: fx('sectionA'),
    subjectId: unassignedSubjectId,
    dayOfWeek: 1,
    periodIndex: 1,
  })
  childTimetableId = await insertTimetableEntry({
    schoolId: schoolA,
    academicYearId: fx('yearA'),
    sectionId: childSectionId,
    subjectId: assignedSubjectId,
    dayOfWeek: 1,
    periodIndex: 0,
  })
  parentTimetableId = await insertTimetableEntry({
    schoolId: schoolA,
    academicYearId: fx('yearA'),
    sectionId: parentSectionId,
    subjectId: assignedSubjectId,
    dayOfWeek: 1,
    periodIndex: 0,
  })
  const unrelatedSectionId = await insertSection(schoolA, fx('yearA'), fx('gradeA'), 'Unrelated')
  unrelatedTimetableId = await insertTimetableEntry({
    schoolId: schoolA,
    academicYearId: fx('yearA'),
    sectionId: unrelatedSectionId,
    subjectId: assignedSubjectId,
    dayOfWeek: 1,
    periodIndex: 0,
  })
  sectionSubstitutionId = await insertSubstitution({
    schoolId: schoolA,
    date: '2026-06-15',
    sectionId: fx('sectionA'),
    periodIndex: 0,
    subjectId: assignedSubjectId,
    absentStaffId: fx('staffA'),
  })
  parentSubstitutionId = await insertSubstitution({
    schoolId: schoolA,
    date: '2026-06-15',
    sectionId: parentSectionId,
    periodIndex: 0,
    subjectId: assignedSubjectId,
    absentStaffId: fx('staffA'),
  })

  // School B needs rows of its own, otherwise the cross school assertions
  // would pass on an empty set.
  const yearB = await insertAcademicYear(schoolB)
  const gradeB = await insertGrade(schoolB)
  const sectionB = await insertSection(schoolB, yearB, gradeB, 'B')
  const subjectB = await insertSubject(schoolB)
  const staffB = await insertStaff(schoolB)
  await insertTimetableEntry({
    schoolId: schoolB,
    academicYearId: yearB,
    sectionId: sectionB,
    subjectId: subjectB,
    dayOfWeek: 1,
    periodIndex: 0,
    staffId: staffB,
  })
  await insertSubstitution({
    schoolId: schoolB,
    date: '2026-06-15',
    sectionId: sectionB,
    periodIndex: 0,
    subjectId: subjectB,
    absentStaffId: staffB,
  })

  // A member with no relationship of its own, reaching one class through a
  // section exception. It proves the exception term on the timetable table.
  exceptionTeacher = await insertMembership({ schoolId: schoolA, roleKeys: ['teacher'] })
  await insertAccessRule({
    schoolId: schoolA,
    membershipId: exceptionTeacher.membershipId,
    permission: 'timetable.read',
    effect: 'allow',
    targetType: 'section',
    sectionId: fx('sectionA'),
    academicYearId: fx('yearA'),
    authorMembershipId: fx('ownerA'),
  })

  // The audit trail an accountant and an owner read. Only the finance actions
  // belong to the finance audience; the rest are the school's own history.
  for (const action of FINANCE_AUDIT_ACTIONS) {
    financeAuditIds.push(await insertAuditEvent(schoolA, action))
  }
  for (const action of ['roles.assign', 'students.create', 'members.invite']) {
    otherAuditIds.push(await insertAuditEvent(schoolA, action))
  }
  // School B gets a finance row too, so the school term is what excludes it.
  await insertAuditEvent(schoolB, 'staff.update_pay')

  teacherNoStaff = await insertMembership({ schoolId: schoolA, roleKeys: ['teacher'] })
  accountant = await insertMembership({ schoolId: schoolA, roleKeys: ['accountant'] })
  deniedAccountant = await insertMembership({ schoolId: schoolA, roleKeys: ['accountant'] })
  await insertAccessRule({
    schoolId: schoolA,
    membershipId: deniedAccountant.membershipId,
    permission: 'students.read_basic',
    effect: 'deny',
    targetType: 'student',
    studentId: unrelatedStudentId,
    authorMembershipId: fx('ownerA'),
  })
})

after(cleanup)

/** One audit row, written straight to the table the plan reads. */
async function insertAuditEvent(schoolId: string, action: string): Promise<string> {
  const result = await migrator.query<{ id: string }>(
    `INSERT INTO audit_events (school_id, action, target_type, result, summary, request_id)
     VALUES ($1, $2, 'test', 'allowed', $2, 'test-request') RETURNING id`,
    [schoolId, action],
  )
  return result.rows[0]!.id
}

function ownerContext(): RequestContext {
  return contextFor({ schoolId: schoolA, membershipId: fx('ownerA'), roleKeys: ['owner'] })
}

function adultContext(): RequestContext {
  return contextFor({
    schoolId: schoolA,
    membershipId: fx('adult'),
    roleKeys: ['teacher', 'parent'],
    assurance: 'single_factor',
  })
}

function parentContext(): RequestContext {
  return contextFor({
    schoolId: schoolA,
    membershipId: fx('parentA2'),
    roleKeys: ['parent'],
    assurance: 'single_factor',
  })
}

function accountantContext(membershipId: string): RequestContext {
  return contextFor({ schoolId: schoolA, membershipId, roleKeys: ['accountant'] })
}

test('a list returns exactly the students a single read would allow', async () => {
  const candidates = [...(await studentsOfSchool(schoolA)), ...(await studentsOfSchool(schoolB))]
  const contexts: { name: string; context: RequestContext }[] = [
    { name: 'owner', context: ownerContext() },
    { name: 'teacher and parent', context: adultContext() },
    { name: 'parent', context: parentContext() },
    { name: 'accountant', context: accountantContext(accountant.membershipId) },
    { name: 'accountant with a deny', context: accountantContext(deniedAccountant.membershipId) },
  ]
  for (const { name, context } of contexts) {
    const listed = new Set(await listStudents(context))
    const expected = new Set(await authorizedStudents(context, candidates))
    assert.deepEqual([...listed].sort(), [...expected].sort(), `list and detail disagree for ${name}`)
    for (const id of await studentsOfSchool(schoolB)) {
      assert.equal(listed.has(id), false, `${name} must never see another school`)
    }
  }
})

test('each role sees the rows its scope describes', async () => {
  const parent = await listStudents(parentContext())
  assert.deepEqual(parent, [fx('studentA2')])

  const teacherAndParent = new Set(await listStudents(adultContext()))
  // The fixture school-wide allow exception widens this member to the school.
  assert.equal(teacherAndParent.has(sectionStudentId), true)
  assert.equal(teacherAndParent.has(unrelatedStudentId), true)

  const accountantIds = new Set(await listStudents(accountantContext(accountant.membershipId)))
  assert.deepEqual(accountantIds, new Set(await studentsOfSchool(schoolA)))
})

test('a deny exception removes the row from the list and from the detail read', async () => {
  const context = accountantContext(deniedAccountant.membershipId)
  const listed = await listStudents(context)
  assert.equal(listed.includes(unrelatedStudentId), false)
  assert.equal(listed.includes(sectionStudentId), true)

  const plan = await authz.scopeQuery(context, 'students.read_basic', 'student')
  const table = studentTable()
  const denied = await withRuntime(context, (conn) =>
    scopedGet<StudentRow>(conn, plan, table, unrelatedStudentId),
  )
  assert.equal(denied, null)
  const visible = await withRuntime(context, (conn) =>
    scopedGet<StudentRow>(conn, plan, table, sectionStudentId),
  )
  assert.equal(visible?.id, sectionStudentId)
})

test('a plan for one school never reads a row from another school', async () => {
  const context = ownerContext()
  const plan = await authz.scopeQuery(context, 'students.read_basic', 'student')
  const table = studentTable()
  const other = await withRuntime(context, (conn) =>
    scopedGet<StudentRow>(conn, plan, table, fx('studentB')),
  )
  assert.equal(other, null)
})

test('a plan is refused for the same reasons a single read is', async () => {
  const stale = contextFor({
    schoolId: schoolA,
    membershipId: fx('ownerA'),
    roleKeys: ['owner'],
    accessVersion: 99,
  })
  await assert.rejects(
    () => authz.scopeQuery(stale, 'students.read_basic', 'student'),
    (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
  )

  const singleFactorOwner = contextFor({
    schoolId: schoolA,
    membershipId: fx('ownerA'),
    roleKeys: ['owner'],
    assurance: 'single_factor',
  })
  await assert.rejects(
    () => authz.scopeQuery(singleFactorOwner, 'students.read_basic', 'student'),
    (error: Error & { code?: string }) => error.code === 'MFA_REQUIRED',
  )

  const studentMember = contextFor({
    schoolId: schoolA,
    membershipId: fx('studentMember'),
    roleKeys: ['student'],
    membershipKind: 'student',
  })
  // The fixture student membership is suspended, so it has no plan.
  await assert.rejects(
    () => authz.scopeQuery(studentMember, 'students.read_basic', 'student'),
    (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
  )
  // A student context with an adult role, or an adult context with the
  // student role, never gets a plan, even from a snapshot granting the read.
  const grants = { accessVersion: 1, grants: [{ permission: 'students.read_basic' as const, scope: 'school' as const }], exceptions: [] }
  const noFacts = { selfStaffId: null, assignments: [], ownChildStudentIds: [], ownStudentId: fx('studentA2') }
  for (const [roleKeys, membershipKind] of [
    [['parent'], 'student'],
    [['student', 'parent'], 'student'],
    [['student'], 'adult'],
  ] as const)
    assert.throws(
      () =>
        createReadPlan(
          contextFor({ schoolId: schoolA, membershipId: fx('studentMember'), roleKeys, membershipKind }),
          'students.read_basic',
          'student',
          grants,
          noFacts,
        ),
      (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
      `${roleKeys.join('+')} as ${membershipKind}`,
    )

  await assert.rejects(
    () => authz.scopeQuery(ownerContext(), 'students.read_basic', 'staff'),
    (error: Error & { code?: string }) => error.code === 'RESOURCE_NOT_FOUND',
  )

  const teacherOnly = await insertMembership({ schoolId: schoolA, roleKeys: ['teacher'] })
  await assert.rejects(
    () =>
      authz.scopeQuery(
        contextFor({
          schoolId: schoolA,
          membershipId: teacherOnly.membershipId,
          roleKeys: ['teacher'],
          assurance: 'single_factor',
        }),
        'staff.read_pay',
        'staff',
      ),
    (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
  )
})

function teacherNoStaffContext(): RequestContext {
  return contextFor({
    schoolId: schoolA,
    membershipId: teacherNoStaff.membershipId,
    roleKeys: ['teacher'],
    assurance: 'single_factor',
  })
}

test('the staff list agrees with a single read for the school and self scopes', async () => {
  const owner = await agreeOn({
    name: 'owner',
    context: ownerContext(),
    permission: 'staff.read_directory',
    resourceType: 'staff',
  })
  assert.equal(owner.includes(fx('staffA')), true)

  const adult = await agreeOn({
    name: 'teacher and parent',
    context: adultContext(),
    permission: 'staff.read_directory',
    resourceType: 'staff',
  })
  assert.deepEqual(adult, [fx('staffA')])

  // The grant exists, so a plan is still issued; with no staff record of its
  // own the self scope simply selects nothing.
  const plan = await authz.scopeQuery(teacherNoStaffContext(), 'staff.read_directory', 'staff')
  assert.equal(plan.permission, 'staff.read_directory')
  const withoutStaffRecord = await agreeOn({
    name: 'teacher without a staff record',
    context: teacherNoStaffContext(),
    permission: 'staff.read_directory',
    resourceType: 'staff',
  })
  assert.deepEqual(withoutStaffRecord, [])
})

test('the section list agrees with a single read for assigned sections and own children', async () => {
  const adult = await agreeOn({
    name: 'teacher and parent',
    context: adultContext(),
    permission: 'sections.read',
    resourceType: 'section',
  })
  assert.deepEqual(adult, [fx('sectionA'), childSectionId].sort())

  const parent = await agreeOn({
    name: 'parent',
    context: parentContext(),
    permission: 'sections.read',
    resourceType: 'section',
  })
  assert.deepEqual(parent, [parentSectionId])
})

test('the subject list agrees with a single read for assigned subjects and own children', async () => {
  const adult = await agreeOn({
    name: 'teacher and parent',
    context: adultContext(),
    permission: 'subjects.read',
    resourceType: 'subject',
  })
  assert.deepEqual(adult, [assignedSubjectId])

  // A parent reads a subject through the class its child studies it in.
  const parent = await agreeOn({
    name: 'parent',
    context: parentContext(),
    permission: 'subjects.read',
    resourceType: 'subject',
  })
  assert.deepEqual(parent, [assignedSubjectId])
  assert.equal(parent.includes(unassignedSubjectId), false)
})

test('the enrollment list agrees with a single read for each scope', async () => {
  const adult = await agreeOn({
    name: 'teacher and parent',
    context: adultContext(),
    permission: 'students.read_enrollments',
    resourceType: 'enrollment',
  })
  assert.equal(adult.length > 0, true)

  const parent = await agreeOn({
    name: 'parent',
    context: parentContext(),
    permission: 'students.read_enrollments',
    resourceType: 'enrollment',
  })
  assert.deepEqual(parent, [parentEnrollmentId])
})

test('documents are listed for the school scope and refused where there is no grant', async () => {
  const owner = await agreeOn({
    name: 'owner',
    context: ownerContext(),
    permission: 'students.read_documents',
    resourceType: 'student_document',
  })
  assert.equal(owner.includes(fx('documentA')), true)

  // No role template gives a parent a document grant, so no plan exists.
  await assert.rejects(
    () => authz.scopeQuery(parentContext(), 'students.read_documents', 'student_document'),
    (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
  )
})

test('the timetable list agrees with a single read for every relationship', async () => {
  const adult = await agreeOn({
    name: 'teacher and parent',
    context: adultContext(),
    permission: 'timetable.read',
    resourceType: 'timetable',
  })
  // Its own period, the rest of the class it teaches and its own child's class.
  assert.deepEqual(adult, [ownTimetableId, sectionTimetableId, childTimetableId].sort())
  assert.equal(adult.includes(unrelatedTimetableId), false)

  const parent = await agreeOn({
    name: 'parent',
    context: parentContext(),
    permission: 'timetable.read',
    resourceType: 'timetable',
  })
  assert.deepEqual(parent, [parentTimetableId])

  const owner = await agreeOn({
    name: 'owner',
    context: ownerContext(),
    permission: 'timetable.read',
    resourceType: 'timetable',
  })
  assert.equal(owner.includes(unrelatedTimetableId), true)

  // An exception naming one section and year reaches exactly that class.
  const viaException = await agreeOn({
    name: 'teacher with a section exception',
    context: contextFor({
      schoolId: schoolA,
      membershipId: exceptionTeacher.membershipId,
      roleKeys: ['teacher'],
      assurance: 'single_factor',
    }),
    permission: 'timetable.read',
    resourceType: 'timetable',
  })
  assert.deepEqual(viaException, [ownTimetableId, sectionTimetableId].sort())
})

test('the substitution list agrees with a single read and stays inside the school', async () => {
  const owner = await agreeOn({
    name: 'owner',
    context: ownerContext(),
    permission: 'timetable.manage_substitutions',
    resourceType: 'substitution',
  })
  assert.deepEqual(owner, [sectionSubstitutionId, parentSubstitutionId].sort())

  // No role template gives a teacher or a parent a substitution grant, so no
  // plan exists for them at all.
  await assert.rejects(
    () => authz.scopeQuery(adultContext(), 'timetable.manage_substitutions', 'substitution'),
    (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
  )
})

test('a finance audit plan selects only the finance actions', async () => {
  const table = tableFor('audit_event')
  const financeContext = accountantContext(accountant.membershipId)
  const financePlan = await authz.scopeQuery(financeContext, 'audit.read', 'audit_event')
  const finance = await withRuntime(financeContext, (conn) =>
    scopedList<{ id: string; action: string }>(conn, financePlan, table, { page: 1, pageSize: 100 }),
  )
  const financeIds = finance.items.map((row) => row.id)
  for (const id of financeAuditIds) {
    assert.equal(financeIds.includes(id), true, 'a finance action is listed')
  }
  for (const id of otherAuditIds) {
    assert.equal(financeIds.includes(id), false, 'a non finance action is never listed')
  }
  assert.equal(finance.total, finance.items.length, 'the total counts the same rows')
  for (const row of finance.items) {
    assert.ok(
      isFinanceAuditAction(row.action),
      `${row.action} is not a finance action`,
    )
  }

  const ownerCtx = ownerContext()
  const ownerPlan = await authz.scopeQuery(ownerCtx, 'audit.read', 'audit_event')
  const owner = await withRuntime(ownerCtx, (conn) =>
    scopedList<{ id: string; action: string }>(conn, ownerPlan, table, { page: 1, pageSize: 200 }),
  )
  const ownerIds = owner.items.map((row) => row.id)
  for (const id of [...financeAuditIds, ...otherAuditIds]) {
    assert.equal(ownerIds.includes(id), true, 'a school scope reads the whole log')
  }
  assert.ok(owner.total > finance.total, 'the owner reads more rows than the accountant')

  // A row the finance plan refuses is refused one by one as well.
  for (const id of otherAuditIds) {
    const row = await withRuntime(financeContext, (conn) =>
      scopedGet<{ id: string }>(conn, financePlan, table, id),
    )
    assert.equal(row, null, 'a non finance action is not readable by a finance plan')
  }
  for (const id of financeAuditIds) {
    const row = await withRuntime(financeContext, (conn) =>
      scopedGet<{ id: string }>(conn, financePlan, table, id),
    )
    assert.ok(row, 'a finance action stays readable')
  }
})

test('a single audit event decision agrees with the finance plan', async () => {
  const financeContext = accountantContext(accountant.membershipId)
  const resource = (id: string) => ({ resourceType: 'audit_event' as const, id, schoolId: schoolA })
  for (const id of financeAuditIds) {
    const decision = await authz.authorize(financeContext, 'audit.read', resource(id))
    assert.equal(decision.allowed, true, 'a finance action is readable one at a time')
  }
  for (const id of otherAuditIds) {
    const decision = await authz.authorize(financeContext, 'audit.read', resource(id))
    assert.equal(decision.allowed, false, 'a non finance action is refused one at a time')
    const ownerDecision = await authz.authorize(ownerContext(), 'audit.read', resource(id))
    assert.equal(ownerDecision.allowed, true, 'a school scope reads any single row')
  }
})

// ---------------------------------------------------------------------------
// Fees (Task 19). One plan of resource type 'fee' is read through six tables,
// so the same plan has to describe the same rows in every one of them.

/**
 * A fee head, an amount, two ledger rows, an optional fee and a concession.
 * The ledger refuses a DELETE even to the owner of the table, so these rows
 * are never registered for cleanup: the test database is disposable and the
 * ids are fresh on every run.
 */
let feeRows: Promise<{
  headId: string
  structureId: string
  childReceiptId: string
  otherReceiptId: string
  childOptInId: string
  childConcessionId: string
}> | null = null

async function seedFeeRows(): Promise<NonNullable<Awaited<typeof feeRows>>> {
  feeRows ??= (async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const head = await migrator.query<{ id: string }>(
      `INSERT INTO fee_heads(school_id,name,category,applies_to,frequency)
       VALUES ($1,$2,'tuition','class','yearly') RETURNING id`,
      [schoolA, `Scope tuition ${tag}`],
    )
    const optInHead = await migrator.query<{ id: string }>(
      `INSERT INTO fee_heads(school_id,name,category,applies_to,frequency)
       VALUES ($1,$2,'transport','opt_in','monthly') RETURNING id`,
      [schoolA, `Scope bus ${tag}`],
    )
    const structure = await migrator.query<{ id: string }>(
      `INSERT INTO fee_structures(school_id,academic_year_id,fee_head_id,amount_paise)
       VALUES ($1,$2,$3,1200000) RETURNING id`,
      [schoolA, fx('yearA'), head.rows[0]!.id],
    )
    const receipt = async (studentId: string, number: string) => {
      const row = await migrator.query<{ id: string }>(
        `INSERT INTO fee_receipts(school_id,student_id,academic_year_id,kind,receipt_number,
                                  amount_paise,mode,received_on,recorded_by_membership_id)
         VALUES ($1,$2,$3,'payment',$4,100000,'cash','2026-04-10',$5) RETURNING id`,
        [schoolA, studentId, fx('yearA'), number, fx('ownerA')],
      )
      await migrator.query(
        `INSERT INTO fee_receipt_lines(school_id,receipt_id,fee_head_id,amount_paise)
         VALUES ($1,$2,$3,100000)`,
        [schoolA, row.rows[0]!.id, head.rows[0]!.id],
      )
      return row.rows[0]!.id
    }
    const optIn = await migrator.query<{ id: string }>(
      `INSERT INTO fee_student_heads(school_id,student_id,academic_year_id,fee_head_id,starts_on)
       VALUES ($1,$2,$3,$4,'2026-04-01') RETURNING id`,
      [schoolA, fx('studentA2'), fx('yearA'), optInHead.rows[0]!.id],
    )
    const concession = await migrator.query<{ id: string }>(
      `INSERT INTO fee_concessions(school_id,student_id,academic_year_id,category,kind,percent_bp)
       VALUES ($1,$2,$3,'sibling','percent',1000) RETURNING id`,
      [schoolA, fx('studentA2'), fx('yearA')],
    )
    return {
      headId: head.rows[0]!.id,
      structureId: structure.rows[0]!.id,
      // studentA2 is parentA2's own child; studentA belongs to another family.
      childReceiptId: await receipt(fx('studentA2'), `SCOPE/${tag}/R0001`),
      otherReceiptId: await receipt(fx('studentA'), `SCOPE/${tag}/R0002`),
      childOptInId: optIn.rows[0]!.id,
      childConcessionId: concession.rows[0]!.id,
    }
  })()
  return feeRows
}

/** The ids one fee table hands a plan, through the predicate and nothing else. */
async function feeIds(
  context: RequestContext,
  kind: Parameters<typeof feeScopedTable>[0],
  table: string,
): Promise<string[]> {
  const plan = await authz.scopeQuery(context, 'fees.read', 'fee')
  const rows = await withRuntime(context, (conn) =>
    conn.db.execute<{ id: string }>(
      sql`SELECT ${sql.raw(table)}.id FROM ${sql.raw(table)}
           WHERE ${planPredicate(plan, feeScopedTable(kind))}`,
    ),
  )
  return rows.rows.map((row) => row.id)
}

test('a parent fee plan reaches their own children and nothing else', async () => {
  const rows = await seedFeeRows()
  const parent = parentContext()

  const receipts = await feeIds(parent, 'receipt', 'fee_receipts')
  assert.equal(receipts.includes(rows.childReceiptId), true, 'a parent reads their own child')
  assert.equal(receipts.includes(rows.otherReceiptId), false, 'another family stays hidden')

  // The fee account is the pupil, so the account table is the students table.
  const accounts = await feeIds(parent, 'account', 'students')
  assert.deepEqual(accounts, [fx('studentA2')])

  const optIns = await feeIds(parent, 'opt_in', 'fee_student_heads')
  assert.equal(optIns.includes(rows.childOptInId), true)
  const concessions = await feeIds(parent, 'concession', 'fee_concessions')
  assert.equal(concessions.includes(rows.childConcessionId), true)

  // By design a parent's plan selects no head and no structure at all: the
  // names of the fees their child is charged come from the statement.
  assert.deepEqual(await feeIds(parent, 'head', 'fee_heads'), [])
  assert.deepEqual(await feeIds(parent, 'structure', 'fee_structures'), [])
})

test('the fee list agrees with a single fee decision, row by row', async () => {
  const rows = await seedFeeRows()
  const parent = parentContext()
  const listed = new Set(await feeIds(parent, 'receipt', 'fee_receipts'))
  const candidates = [
    rows.childReceiptId,
    rows.otherReceiptId,
    rows.childOptInId,
    rows.childConcessionId,
    rows.headId,
    rows.structureId,
    fx('studentA'),
    fx('studentA2'),
  ]
  for (const id of candidates) {
    const decision = await authz.authorize(parent, 'fees.read', {
      schoolId: schoolA,
      resourceType: 'fee',
      id,
    })
    // Only a ledger row can be in the ledger list; for one that can be, the
    // list and the single decision have to say the same thing.
    if (id === rows.childReceiptId || id === rows.otherReceiptId) {
      assert.equal(listed.has(id), decision.allowed, `${id} disagrees with its own decision`)
    }
  }
  const own = await authz.authorize(parent, 'fees.read', {
    schoolId: schoolA,
    resourceType: 'fee',
    id: fx('studentA2'),
  })
  assert.equal(own.allowed, true, 'a parent reads their own child’s fee account')
  const other = await authz.authorize(parent, 'fees.read', {
    schoolId: schoolA,
    resourceType: 'fee',
    id: fx('studentA'),
  })
  assert.equal(other.allowed, false, 'another family’s fee account is refused')
})

test('a teacher gets no fee plan at all', async () => {
  const teacher = contextFor({
    schoolId: schoolA,
    membershipId: teacherNoStaff.membershipId,
    roleKeys: ['teacher'],
    assurance: 'single_factor',
  })
  await assert.rejects(authz.scopeQuery(teacher, 'fees.read', 'fee'), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error)
    assert.equal((error as { code: string }).code, 'ACCESS_DENIED')
    return true
  })
})

test('an accountant fee plan selects the whole school', async () => {
  const rows = await seedFeeRows()
  const finance = accountantContext(accountant.membershipId)
  const receipts = await feeIds(finance, 'receipt', 'fee_receipts')
  assert.equal(receipts.includes(rows.childReceiptId), true)
  assert.equal(receipts.includes(rows.otherReceiptId), true, 'finance scope is the whole school')
  assert.ok((await feeIds(finance, 'head', 'fee_heads')).includes(rows.headId))
  assert.ok((await feeIds(finance, 'structure', 'fee_structures')).includes(rows.structureId))

  // The plan stops at the school boundary even though the scope is the school.
  const foreign = await migrator.query<{ id: string }>(
    'SELECT id FROM fee_receipts WHERE school_id = $1',
    [schoolB],
  )
  for (const row of foreign.rows) {
    assert.equal(receipts.includes(row.id), false, 'another school never appears')
  }
})

// ---------------------------------------------------------------------------
// Attendance (Task 20). One plan of resource type 'attendance' is read through
// three faces — the mark, the roster and the pupil — and a 'staff_attendance'
// plan through two, so the same plan has to describe the same rows in each.

/**
 * A class of this suite's own with a teacher assigned to it, a mark for a
 * pupil of that class, a mark for a parent's own child sitting in it and a
 * mark in a class nobody here is related to, plus two staff rows.
 *
 * A mark refuses a DELETE even to the owner of the table, so neither these
 * rows nor the class and pupil they point at are ever registered for cleanup:
 * the test database is disposable and the ids are fresh on every run. The day
 * is random for the same reason: two runs must never write the same mark.
 */
const ATTENDANCE_DAY = `2026-06-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`

let attendanceRows: Promise<{
  teacher: { membershipId: string; userId: string }
  sectionId: string
  pupilId: string
  teacherStaffId: string
  otherStaffId: string
  sectionEntryId: string
  childEntryId: string
  otherEntryId: string
  ownStaffEntryId: string
  otherStaffEntryId: string
}> | null = null

async function seedAttendanceRows(): Promise<NonNullable<Awaited<typeof attendanceRows>>> {
  attendanceRows ??= (async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const section = await migrator.query<{ id: string }>(
      `INSERT INTO sections(school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4) RETURNING id`,
      [schoolA, fx('yearA'), fx('gradeA'), `Att-${tag}`],
    )
    const sectionId = section.rows[0]!.id
    const pupil = await migrator.query<{ id: string }>(
      `INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,$2,'Att pupil','active') RETURNING id`,
      [schoolA, `ATT-${tag}`],
    )
    const pupilId = pupil.rows[0]!.id
    await migrator.query(
      `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on)
       VALUES ($1,$2,$3,$4,'2026-04-01')`,
      [schoolA, pupilId, fx('yearA'), sectionId],
    )
    const staffRow = async () => {
      const row = await migrator.query<{ id: string }>(
        `INSERT INTO staff(school_id,employee_code,first_name,staff_type,designation,status,joining_date)
         VALUES ($1,$2,'Att','teaching','Teacher','active','2026-04-01') RETURNING id`,
        [schoolA, `ATT-${crypto.randomUUID().slice(0, 8)}`],
      )
      return row.rows[0]!.id
    }
    const teacherStaffId = await staffRow()
    const otherStaffId = await staffRow()

    const teacher = await insertMembership({ schoolId: schoolA, roleKeys: ['teacher'] })
    await insertMembershipStaffLink(schoolA, teacher.membershipId, teacherStaffId)
    await insertTeachingAssignment({
      schoolId: schoolA,
      staffId: teacherStaffId,
      academicYearId: fx('yearA'),
      sectionId,
      subjectId: assignedSubjectId,
    })

    const mark = async (studentId: string, inSection: string) => {
      const row = await migrator.query<{ id: string }>(
        `INSERT INTO attendance_entries(school_id,student_id,section_id,academic_year_id,date,mark,
                                        revision,kind,recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,$5::date,'present',1,'marking',$6) RETURNING id`,
        [schoolA, studentId, inSection, fx('yearA'), ATTENDANCE_DAY, fx('ownerA')],
      )
      return row.rows[0]!.id
    }
    const staffMark = async (staffId: string) => {
      const row = await migrator.query<{ id: string }>(
        `INSERT INTO staff_attendance_entries(school_id,staff_id,date,mark,revision,kind,recorded_by_membership_id)
         VALUES ($1,$2,$3::date,'present',1,'marking',$4) RETURNING id`,
        [schoolA, staffId, ATTENDANCE_DAY, fx('ownerA')],
      )
      return row.rows[0]!.id
    }
    return {
      teacher,
      sectionId,
      pupilId,
      teacherStaffId,
      otherStaffId,
      sectionEntryId: await mark(pupilId, sectionId),
      // studentA2 is parentA2's own child; studentA belongs to another family.
      childEntryId: await mark(fx('studentA2'), sectionId),
      otherEntryId: await mark(fx('studentA'), fx('sectionA')),
      ownStaffEntryId: await staffMark(teacherStaffId),
      otherStaffEntryId: await staffMark(otherStaffId),
    }
  })()
  return attendanceRows
}

/** The ids one attendance face hands a plan, through the predicate alone. */
async function attendanceIds(
  context: RequestContext,
  kind: Parameters<typeof attendanceScopedTable>[0],
  table: string,
): Promise<string[]> {
  const plan = await authz.scopeQuery(context, 'attendance.read', 'attendance')
  const rows = await withRuntime(context, (conn) =>
    conn.db.execute<{ id: string }>(
      sql`SELECT ${sql.raw(table)}.id FROM ${sql.raw(table)}
           WHERE ${planPredicate(plan, attendanceScopedTable(kind))}`,
    ),
  )
  return rows.rows.map((row) => row.id)
}

async function staffAttendanceIds(
  context: RequestContext,
  kind: Parameters<typeof staffAttendanceScopedTable>[0],
  table: string,
): Promise<string[]> {
  const plan = await authz.scopeQuery(context, 'staff_attendance.read', 'staff_attendance')
  const rows = await withRuntime(context, (conn) =>
    conn.db.execute<{ id: string }>(
      sql`SELECT ${sql.raw(table)}.id FROM ${sql.raw(table)}
           WHERE ${planPredicate(plan, staffAttendanceScopedTable(kind))}`,
    ),
  )
  return rows.rows.map((row) => row.id)
}

function attendanceTeacherContext(membershipId: string): RequestContext {
  return contextFor({
    schoolId: schoolA,
    membershipId,
    roleKeys: ['teacher'],
    assurance: 'single_factor',
  })
}

test('a teacher attendance plan reaches exactly the sections they are assigned', async () => {
  const rows = await seedAttendanceRows()
  const teacher = attendanceTeacherContext(rows.teacher.membershipId)

  const entries = await attendanceIds(teacher, 'entry', 'attendance_entries')
  assert.deepEqual(
    [...entries].sort(),
    [rows.sectionEntryId, rows.childEntryId].sort(),
    'every mark of their own class, and no other',
  )

  assert.deepEqual(await attendanceIds(teacher, 'roster', 'sections'), [rows.sectionId])

  // The pupil face answers through a current enrolment, exactly as a student
  // does, so it is the roll of that one class.
  const pupils = new Set(await attendanceIds(teacher, 'pupil', 'students'))
  assert.equal(pupils.has(rows.pupilId), true)
  assert.equal(pupils.has(fx('studentA')), false, 'a class they do not teach stays hidden')
})

test('a parent attendance plan reaches exactly their own children', async () => {
  const rows = await seedAttendanceRows()
  const parent = parentContext()

  const entries = await attendanceIds(parent, 'entry', 'attendance_entries')
  assert.deepEqual([...entries].sort(), [rows.childEntryId], 'a parent reads their own child')
  assert.deepEqual(await attendanceIds(parent, 'pupil', 'students'), [fx('studentA2')])

  // The roster is a shared row, so it answers through a class their own child
  // currently sits in and no other.
  const rosters = new Set(await attendanceIds(parent, 'roster', 'sections'))
  assert.equal(rosters.has(parentSectionId), true)
  assert.equal(rosters.has(fx('sectionA')), false)
})

test('the attendance list agrees with a single attendance decision, face by face', async () => {
  const rows = await seedAttendanceRows()
  const candidates = [
    rows.sectionEntryId,
    rows.childEntryId,
    rows.otherEntryId,
    rows.sectionId,
    parentSectionId,
    fx('sectionA'),
    rows.pupilId,
    fx('studentA'),
    fx('studentA2'),
  ]
  const contexts: { name: string; context: RequestContext }[] = [
    { name: 'teacher', context: attendanceTeacherContext(rows.teacher.membershipId) },
    { name: 'parent', context: parentContext() },
    { name: 'owner', context: ownerContext() },
  ]
  for (const { name, context } of contexts) {
    const listed = new Set([
      ...(await attendanceIds(context, 'entry', 'attendance_entries')),
      ...(await attendanceIds(context, 'roster', 'sections')),
      ...(await attendanceIds(context, 'pupil', 'students')),
    ])
    for (const id of candidates) {
      const decision = await authz.authorize(context, 'attendance.read', {
        schoolId: schoolA,
        resourceType: 'attendance',
        id,
      })
      assert.equal(listed.has(id), decision.allowed, `${name} disagrees with the decision on ${id}`)
    }
  }
})

test('a scoped get of one mark says what the list says', async () => {
  const rows = await seedAttendanceRows()
  const teacher = attendanceTeacherContext(rows.teacher.membershipId)
  const plan = await authz.scopeQuery(teacher, 'attendance.read', 'attendance')
  const got = await withRuntime(teacher, async (conn) => ({
    own: await scopedGet<{ id: string }>(conn, plan, attendanceScopedTable('entry'), rows.sectionEntryId),
    other: await scopedGet<{ id: string }>(conn, plan, attendanceScopedTable('entry'), rows.otherEntryId),
  }))
  assert.equal(got.own?.id, rows.sectionEntryId)
  assert.equal(got.other, null, 'a mark outside their classes is not there at all')
})

test('a staff attendance plan at self lists only that person’s own rows', async () => {
  const rows = await seedAttendanceRows()
  const teacher = attendanceTeacherContext(rows.teacher.membershipId)

  assert.deepEqual(await staffAttendanceIds(teacher, 'entry', 'staff_attendance_entries'), [
    rows.ownStaffEntryId,
  ])
  assert.deepEqual(await staffAttendanceIds(teacher, 'person', 'staff'), [rows.teacherStaffId])

  for (const [id, allowed] of [
    [rows.ownStaffEntryId, true],
    [rows.otherStaffEntryId, false],
    [rows.teacherStaffId, true],
    [rows.otherStaffId, false],
  ] as [string, boolean][]) {
    const decision = await authz.authorize(teacher, 'staff_attendance.read', {
      schoolId: schoolA,
      resourceType: 'staff_attendance',
      id,
    })
    assert.equal(decision.allowed, allowed, `the self scope disagrees on ${id}`)
  }

  // An accountant holds the key at the whole school, so both rows are theirs.
  const finance = accountantContext(accountant.membershipId)
  const all = await staffAttendanceIds(finance, 'entry', 'staff_attendance_entries')
  assert.equal(all.includes(rows.ownStaffEntryId), true)
  assert.equal(all.includes(rows.otherStaffEntryId), true)
})

// ---------------------------------------------------------------------------
// Exams and report cards. One resource type each, laid over several faces, so
// for every face and every relationship the list has to select exactly what a
// single decision allows. assigned_sections is the class-teacher post alone
// for both; assigned_subjects is the (section, year, subject) triple of a live
// teaching assignment; a family reaches only published rows.
//
// Marks, publications and published cards refuse a DELETE, so none of these
// rows (nor the classes, pupils and staff they point at) are ever registered
// for cleanup: the test database is disposable and the ids are fresh. The
// API suite runs on the same database after this one and counts school A's
// cards, so these rows live in school B, and nothing here touches a fixture
// pupil or a fixture year: the years, the class, the child and the parent
// are all this block's own.

type Membership = { membershipId: string; userId: string }

let examRows: Promise<{
  parent: Membership
  child: string
  subjectTeacher: Membership
  classTeacher: Membership
  endedTeacher: Membership
  sectionOne: string
  sectionTwo: string
  lastYearSection: string
  examId: string
  lastYearExamId: string
  paperOneMaths: string
  paperOneScience: string
  paperTwoMaths: string
  lastYearPaper: string
  pupilOne: string
  pupilTwo: string
  markPupilMaths: string
  markChildMaths: string
  markChildMathsLate: string
  markPupilScience: string
  markChildScience: string
  markTwoMaths: string
  lastYearChildMark: string
  lastYearPupilMark: string
  entryPupil: string
  entryChild: string
  entryTwo: string
  cardPupil: string
  cardChild: string
  lastYearChildCard: string
  lastYearPupilCard: string
}> | null = null

async function seedExamRows(): Promise<NonNullable<Awaited<typeof examRows>>> {
  examRows ??= (async () => {
    const tag = crypto.randomUUID().slice(0, 8)
    const one = async (text: string, values: unknown[]) => (await migrator.query<{ id: string }>(text, values)).rows[0]!.id
    const gradeId = await one(
      `INSERT INTO grades(school_id,name,short_name,sort_order) VALUES ($1,$2,$3,9) RETURNING id`,
      [schoolB, `Exam grade ${tag}`, tag.slice(0, 4)],
    )
    const section = (yearId: string, name: string) =>
      one(`INSERT INTO sections(school_id,academic_year_id,grade_id,name) VALUES ($1,$2,$3,$4) RETURNING id`, [
        schoolB,
        yearId,
        gradeId,
        `${name}-${tag}`,
      ])
    const subject = (name: string) =>
      one(`INSERT INTO subjects(school_id,name,code,type) VALUES ($1,$2,$3,'scholastic') RETURNING id`, [
        schoolB,
        name,
        `${name}-${tag}`,
      ])
    const pupil = (name: string) =>
      one(`INSERT INTO students(school_id,admission_number,first_name,status) VALUES ($1,$2,$3,'active') RETURNING id`, [
        schoolB,
        `EXM-${name}-${tag}`,
        name,
      ])
    const staffRow = () =>
      one(
        `INSERT INTO staff(school_id,employee_code,first_name,staff_type,designation,status,joining_date)
         VALUES ($1,$2,'Exam','teaching','Teacher','active','2025-04-01') RETURNING id`,
        [schoolB, `EXM-${crypto.randomUUID().slice(0, 8)}`],
      )
    const enrol = (studentId: string, yearId: string, sectionId: string, joinedOn: string, leftOn: string | null) =>
      migrator.query(
        `INSERT INTO enrollments(school_id,student_id,academic_year_id,section_id,joined_on,left_on,outcome)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [schoolB, studentId, yearId, sectionId, joinedOn, leftOn, leftOn === null ? 'ongoing' : 'promoted'],
      )

    const thisYear = await one(
      `INSERT INTO academic_years(school_id,name,start_date,end_date,status)
       VALUES ($1,$2,'2026-04-01','2027-03-31','upcoming') RETURNING id`,
      [schoolB, `Exams this year ${tag}`],
    )
    const lastYear = await one(
      `INSERT INTO academic_years(school_id,name,start_date,end_date,status)
       VALUES ($1,$2,'2025-04-01','2026-03-31','closed') RETURNING id`,
      [schoolB, `Exams last year ${tag}`],
    )
    const sectionOne = await section(thisYear, 'ExamOne')
    const sectionTwo = await section(thisYear, 'ExamTwo')
    const lastYearSection = await section(lastYear, 'ExamLast')
    const maths = await subject('ExMaths')
    const science = await subject('ExScience')
    const child = await pupil('Exam child')
    const pupilOne = await pupil('Exam pupil one')
    const pupilTwo = await pupil('Exam pupil two')
    // The child is the parent's own: promoted from last year's class into
    // section one. Pupil one sat beside them in both years, in another family.
    await enrol(child, lastYear, lastYearSection, '2025-04-01', '2026-03-31')
    await enrol(pupilOne, lastYear, lastYearSection, '2025-04-01', '2026-03-31')
    await enrol(child, thisYear, sectionOne, '2026-04-01', null)
    await enrol(pupilOne, thisYear, sectionOne, '2026-04-01', null)
    await enrol(pupilTwo, thisYear, sectionTwo, '2026-04-01', null)

    // The parent reaches the child through a verified guardian link and an
    // approved portal grant, exactly as the fixture parents do.
    const parent = await insertMembership({ schoolId: schoolB, roleKeys: ['parent'] })
    const guardian = await one(`INSERT INTO guardians(school_id,first_name) VALUES ($1,'Exam guardian') RETURNING id`, [
      schoolB,
    ])
    await insertGuardianLink(schoolB, parent.membershipId, guardian)
    await migrator.query(
      `INSERT INTO student_guardians(school_id,student_id,guardian_id,relation) VALUES ($1,$2,$3,'guardian')`,
      [schoolB, child, guardian],
    )
    await migrator.query(
      `INSERT INTO guardian_student_access(school_id,guardian_id,student_id,status,areas,approved_by_membership_id,approved_at)
       VALUES ($1,$2,$3,'approved',ARRAY['basic'],$4,'2026-01-01')`,
      [schoolB, guardian, child, fx('ownerB')],
    )

    // The subject teacher teaches maths in section one and nothing else. The
    // class teacher of section one teaches nothing. The third teacher taught
    // maths in section one until last month.
    const subjectTeacher = await insertMembership({ schoolId: schoolB, roleKeys: ['teacher'] })
    const subjectStaff = await staffRow()
    await insertMembershipStaffLink(schoolB, subjectTeacher.membershipId, subjectStaff)
    await insertTeachingAssignment({
      schoolId: schoolB,
      staffId: subjectStaff,
      academicYearId: thisYear,
      sectionId: sectionOne,
      subjectId: maths,
    })
    const classTeacher = await insertMembership({ schoolId: schoolB, roleKeys: ['teacher'] })
    const classStaff = await staffRow()
    await insertMembershipStaffLink(schoolB, classTeacher.membershipId, classStaff)
    await migrator.query('UPDATE sections SET class_teacher_staff_id = $2 WHERE id = $1', [sectionOne, classStaff])
    const endedTeacher = await insertMembership({ schoolId: schoolB, roleKeys: ['teacher'] })
    const endedStaff = await staffRow()
    await insertMembershipStaffLink(schoolB, endedTeacher.membershipId, endedStaff)
    await insertTeachingAssignment({
      schoolId: schoolB,
      staffId: endedStaff,
      academicYearId: thisYear,
      sectionId: sectionOne,
      subjectId: maths,
      effectiveTo: '2026-05-15',
    })

    const exam = (yearId: string, startsOn: string) =>
      one(
        `INSERT INTO exams(school_id,academic_year_id,kind,starts_on,ends_on,recheck_deadline)
         VALUES ($1,$2,'periodic_test_1',$3::date,$3::date,$3::date + 7) RETURNING id`,
        [schoolB, yearId, startsOn],
      )
    const examId = await exam(thisYear, '2026-05-04')
    const lastYearExamId = await exam(lastYear, '2025-05-05')
    const paper = (examOf: string, yearId: string, sectionId: string, subjectId: string) =>
      one(
        `INSERT INTO exam_papers(school_id,exam_id,academic_year_id,section_id,subject_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [schoolB, examOf, yearId, sectionId, subjectId],
      )
    const paperOneMaths = await paper(examId, thisYear, sectionOne, maths)
    const paperOneScience = await paper(examId, thisYear, sectionOne, science)
    const paperTwoMaths = await paper(examId, thisYear, sectionTwo, maths)
    const lastYearPaper = await paper(lastYearExamId, lastYear, lastYearSection, maths)
    const papers: Record<string, [string, string, string, string]> = {
      [paperOneMaths]: [examId, thisYear, sectionOne, maths],
      [paperOneScience]: [examId, thisYear, sectionOne, science],
      [paperTwoMaths]: [examId, thisYear, sectionTwo, maths],
      [lastYearPaper]: [lastYearExamId, lastYear, lastYearSection, maths],
    }
    const mark = (paperId: string, studentId: string, tenths: number, supersedes: string | null = null) =>
      one(
        `INSERT INTO exam_marks(school_id,paper_id,exam_id,academic_year_id,section_id,subject_id,student_id,
                                component,status,marks_tenths,revision,supersedes_mark_id,kind,reason_kind,
                                recorded_by_membership_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'periodic_test','marked',$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          schoolB,
          paperId,
          ...papers[paperId]!,
          studentId,
          tenths,
          supersedes === null ? 1 : 2,
          supersedes,
          supersedes === null ? 'entry' : 'correction',
          supersedes === null ? null : 'recheck',
          fx('ownerB'),
        ],
      )
    const publish = (examOf: string, yearId: string, sectionId: string) =>
      migrator.query(
        `INSERT INTO exam_publications(school_id,exam_id,academic_year_id,section_id,published_by_membership_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [schoolB, examOf, yearId, sectionId, fx('ownerB')],
      )

    const lastYearChildMark = await mark(lastYearPaper, child, 80)
    const lastYearPupilMark = await mark(lastYearPaper, pupilOne, 70)
    await publish(lastYearExamId, lastYear, lastYearSection)

    const markPupilMaths = await mark(paperOneMaths, pupilOne, 60)
    const markChildMaths = await mark(paperOneMaths, child, 50)
    const markPupilScience = await mark(paperOneScience, pupilOne, 40)
    const markChildScience = await mark(paperOneScience, child, 30)
    const markTwoMaths = await mark(paperTwoMaths, pupilTwo, 20)
    await publish(examId, thisYear, sectionOne)
    // A correction after publishing: the family keeps seeing the mark as it
    // stood at the publication until the office publishes again.
    const markChildMathsLate = await mark(paperOneMaths, child, 90, markChildMaths)

    const entry = (studentId: string, sectionId: string) =>
      one(
        `INSERT INTO report_card_entries(school_id,student_id,academic_year_id,section_id,term,discipline,remarks,
                                         updated_by_membership_id)
         VALUES ($1,$2,$3,$4,'term_1','A','Works hard',$5) RETURNING id`,
        [schoolB, studentId, thisYear, sectionId, fx('ownerB')],
      )
    const card = (studentId: string, yearId: string, sectionId: string) =>
      one(
        `INSERT INTO report_card_versions(school_id,student_id,academic_year_id,section_id,card,version_number,
                                          content,content_hash,published_by_membership_id)
         VALUES ($1,$2,$3,$4,'term_1',1,'{}'::jsonb,$5,$6) RETURNING id`,
        [schoolB, studentId, yearId, sectionId, `hash-${crypto.randomUUID()}`, fx('ownerB')],
      )
    return {
      parent,
      child,
      subjectTeacher,
      classTeacher,
      endedTeacher,
      sectionOne,
      sectionTwo,
      lastYearSection,
      examId,
      lastYearExamId,
      paperOneMaths,
      paperOneScience,
      paperTwoMaths,
      lastYearPaper,
      pupilOne,
      pupilTwo,
      markPupilMaths,
      markChildMaths,
      markChildMathsLate,
      markPupilScience,
      markChildScience,
      markTwoMaths,
      lastYearChildMark,
      lastYearPupilMark,
      entryPupil: await entry(pupilOne, sectionOne),
      entryChild: await entry(child, sectionOne),
      entryTwo: await entry(pupilTwo, sectionTwo),
      cardPupil: await card(pupilOne, thisYear, sectionOne),
      cardChild: await card(child, thisYear, sectionOne),
      lastYearChildCard: await card(child, lastYear, lastYearSection),
      lastYearPupilCard: await card(pupilOne, lastYear, lastYearSection),
    }
  })()
  return examRows
}

const EXAM_FACES = [
  ['exam', 'exams'],
  ['paper', 'exam_papers'],
  ['mark', 'exam_marks'],
  ['pupil', 'students'],
] as const
const REPORT_CARD_FACES = [
  ['card', 'report_card_versions'],
  ['entry', 'report_card_entries'],
  ['roster', 'sections'],
  ['pupil', 'students'],
] as const

/** Every id one plan selects on one face, through the predicate alone. */
async function examFaceIds(
  context: RequestContext,
  permission: PermissionKey,
  resourceType: 'exam' | 'report_card',
  face: string,
  table: string,
): Promise<string[]> {
  const plan = await authz.scopeQuery(context, permission, resourceType)
  const scoped =
    resourceType === 'exam'
      ? examScopedTable(face as Parameters<typeof examScopedTable>[0])
      : reportCardScopedTable(face as Parameters<typeof reportCardScopedTable>[0])
  const rows = await withRuntime(context, (conn) =>
    conn.db.execute<{ id: string }>(
      sql`SELECT ${sql.raw(table)}.id FROM ${sql.raw(table)} WHERE ${planPredicate(plan, scoped)}`,
    ),
  )
  return rows.rows.map((row) => row.id)
}

/**
 * Lists every face, checks each candidate's single decision agrees with the
 * list, and returns the candidates the list selected, sorted.
 */
async function examAgree(
  name: string,
  context: RequestContext,
  permission: PermissionKey,
  resourceType: 'exam' | 'report_card',
  candidates: readonly string[],
): Promise<string[]> {
  const faces = resourceType === 'exam' ? EXAM_FACES : REPORT_CARD_FACES
  const listed = new Set<string>()
  for (const [face, table] of faces) {
    for (const id of await examFaceIds(context, permission, resourceType, face, table)) listed.add(id)
  }
  for (const id of candidates) {
    const decision = await authz.authorize(context, permission, { schoolId: schoolB, resourceType, id })
    assert.equal(listed.has(id), decision.allowed, `${name}: ${permission} list and decision disagree on ${id}`)
  }
  return candidates.filter((id) => listed.has(id)).sort()
}

function examCandidates(rows: Awaited<ReturnType<typeof seedExamRows>>): string[] {
  return [
    rows.examId,
    rows.lastYearExamId,
    rows.paperOneMaths,
    rows.paperOneScience,
    rows.paperTwoMaths,
    rows.lastYearPaper,
    rows.markPupilMaths,
    rows.markChildMaths,
    rows.markChildMathsLate,
    rows.markPupilScience,
    rows.markChildScience,
    rows.markTwoMaths,
    rows.lastYearChildMark,
    rows.lastYearPupilMark,
    rows.pupilOne,
    rows.pupilTwo,
    rows.child,
  ]
}

function cardCandidates(rows: Awaited<ReturnType<typeof seedExamRows>>): string[] {
  return [
    rows.cardPupil,
    rows.cardChild,
    rows.lastYearChildCard,
    rows.lastYearPupilCard,
    rows.entryPupil,
    rows.entryChild,
    rows.entryTwo,
    rows.sectionOne,
    rows.sectionTwo,
    rows.lastYearSection,
    rows.pupilOne,
    rows.pupilTwo,
    rows.child,
  ]
}

function examTeacher(member: Membership): RequestContext {
  return contextFor({ schoolId: schoolB, membershipId: member.membershipId, roleKeys: ['teacher'], assurance: 'single_factor' })
}

const sorted = (ids: readonly string[]) => [...ids].sort()

test('a subject teacher reaches their subject in their section and nothing else', async () => {
  const rows = await seedExamRows()
  const teacher = examTeacher(rows.subjectTeacher)
  const exams = await examAgree('subject teacher', teacher, 'exams.read', 'exam', examCandidates(rows))
  assert.deepEqual(
    exams,
    sorted([
      rows.paperOneMaths,
      rows.markPupilMaths,
      rows.markChildMaths,
      rows.markChildMathsLate,
      // The pupil face: both pupils sit, today, in a class they teach in.
      rows.pupilOne,
      rows.child,
    ]),
    'not science in the same class, not maths in another class, not the exam row',
  )
  // Recording follows the same triple.
  const recording = await examAgree('subject teacher', teacher, 'exams.record_marks', 'exam', examCandidates(rows))
  assert.equal(recording.includes(rows.paperOneMaths), true)
  assert.equal(recording.includes(rows.paperOneScience), false)
  assert.equal(recording.includes(rows.paperTwoMaths), false)
  // Teaching a subject in a class is not looking after it: no report card rows.
  const cards = await examAgree('subject teacher', teacher, 'report_cards.read', 'report_card', cardCandidates(rows))
  assert.deepEqual(cards, [], 'the assigned_sections narrowing: a subject teacher reads no card, entry or roster')
})

test('a class teacher who teaches nothing reaches every paper, mark and card of their class', async () => {
  const rows = await seedExamRows()
  const teacher = examTeacher(rows.classTeacher)
  const exams = await examAgree('class teacher', teacher, 'exams.read', 'exam', examCandidates(rows))
  assert.deepEqual(
    exams,
    sorted([
      rows.paperOneMaths,
      rows.paperOneScience,
      rows.markPupilMaths,
      rows.markChildMaths,
      rows.markChildMathsLate,
      rows.markPupilScience,
      rows.markChildScience,
      rows.pupilOne,
      rows.child,
    ]),
  )
  // The post names no subject, so it never opens recording marks.
  const recording = await examAgree('class teacher', teacher, 'exams.record_marks', 'exam', examCandidates(rows))
  assert.deepEqual(recording, [])
  const cards = await examAgree('class teacher', teacher, 'report_cards.read', 'report_card', cardCandidates(rows))
  assert.deepEqual(
    cards,
    sorted([rows.cardPupil, rows.cardChild, rows.entryPupil, rows.entryChild, rows.sectionOne, rows.pupilOne, rows.child]),
    'last year’s cards were another class teacher’s',
  )
  const managed = await examAgree('class teacher', teacher, 'report_cards.manage', 'report_card', cardCandidates(rows))
  assert.deepEqual(managed, cards)
})

test('a teacher whose assignment ended reaches nothing', async () => {
  const rows = await seedExamRows()
  const teacher = examTeacher(rows.endedTeacher)
  assert.deepEqual(await examAgree('ended teacher', teacher, 'exams.read', 'exam', examCandidates(rows)), [])
  assert.deepEqual(
    await examAgree('ended teacher', teacher, 'report_cards.read', 'report_card', cardCandidates(rows)),
    [],
  )
})

test('a parent reaches published marks and every card of their own child, in every year', async () => {
  const rows = await seedExamRows()
  const parent = contextFor({
    schoolId: schoolB,
    membershipId: rows.parent.membershipId,
    roleKeys: ['parent'],
    assurance: 'single_factor',
  })
  const exams = await examAgree('parent', parent, 'exams.read', 'exam', examCandidates(rows))
  assert.deepEqual(
    exams,
    sorted([rows.markChildMaths, rows.markChildScience, rows.lastYearChildMark, rows.child]),
    'the correction after publishing is not selected; another family’s child never is',
  )
  const late = await authz.authorize(parent, 'exams.read', {
    schoolId: schoolB,
    resourceType: 'exam',
    id: rows.markChildMathsLate,
  })
  assert.equal(late.allowed, false, 'a mark recorded after the newest publication is refused')
  const cards = await examAgree('parent', parent, 'report_cards.read', 'report_card', cardCandidates(rows))
  assert.deepEqual(
    cards,
    sorted([rows.cardChild, rows.lastYearChildCard, rows.child]),
    'every version of their own child’s card, no working entry, no roster',
  )
})

test('an office role reaches every exam and card row of the school', async () => {
  const rows = await seedExamRows()
  const owner = contextFor({ schoolId: schoolB, membershipId: fx('ownerB'), roleKeys: ['owner'] })
  assert.deepEqual(
    await examAgree('owner', owner, 'exams.read', 'exam', examCandidates(rows)),
    sorted(examCandidates(rows)),
  )
  assert.deepEqual(
    await examAgree('owner', owner, 'report_cards.read', 'report_card', cardCandidates(rows)),
    sorted(cardCandidates(rows)),
  )
})

test('the accountant has no exam or report card plan at all', async () => {
  await seedExamRows()
  const finance = accountantContext(accountant.membershipId)
  for (const [permission, resourceType] of [
    ['exams.read', 'exam'],
    ['exams.record_marks', 'exam'],
    ['report_cards.read', 'report_card'],
  ] as const) {
    await assert.rejects(authz.scopeQuery(finance, permission, resourceType), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'ACCESS_DENIED', permission)
      return true
    })
  }
})

test('a pupil\'s plans list exactly the pupil and what the pupil\'s current class reaches', async () => {
  // A pupil of the parent's section, with a login of their own (the fixture
  // pupil there already has the fixture's suspended login).
  const pupilId = await insertStudent(schoolA, 'Pupil')
  const pupilEnrollmentId = await insertEnrollment({
    schoolId: schoolA,
    studentId: pupilId,
    academicYearId: fx('yearA'),
    sectionId: parentSectionId,
  })
  const pupil = await insertStudentLogin(schoolA, pupilId)
  const context = contextFor({
    schoolId: schoolA,
    membershipId: pupil.membershipId,
    roleKeys: ['student'],
    membershipKind: 'student',
    assurance: 'single_factor',
  })
  const agree = (permission: PermissionKey, resourceType: ResourceType) =>
    agreeOn({ name: 'pupil', context, permission, resourceType })
  // Never a classmate: the parent's child sits in the same section.
  assert.deepEqual(await agree('students.read_basic', 'student'), [pupilId])
  assert.deepEqual(await agree('students.read_enrollments', 'enrollment'), [pupilEnrollmentId])
  assert.deepEqual(await agree('sections.read', 'section'), [parentSectionId])
  assert.deepEqual(await agree('subjects.read', 'subject'), [assignedSubjectId])
  assert.deepEqual(await agree('timetable.read', 'timetable'), [parentTimetableId])
  // Nothing the pupil holds no key for.
  await assert.rejects(
    () => authz.scopeQuery(context, 'students.read_documents', 'student_document'),
    (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
  )
  await assert.rejects(
    () => authz.scopeQuery(context, 'staff.read_directory', 'staff'),
    (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
  )
})
