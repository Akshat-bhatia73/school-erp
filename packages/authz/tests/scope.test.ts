import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { PermissionKey, ResourceType } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'

import { createAuthorizationService } from '../src/service.ts'
import { createReadPlan, scopedGet, scopedList, scopedTableFor } from '../src/scope.ts'
import type { ScopedTable } from '../src/scope.ts'
import {
  cleanup,
  contextFor,
  fx,
  insertAccessRule,
  insertEnrollment,
  insertGradeSubject,
  insertMembership,
  insertSection,
  insertStudent,
  insertSubject,
  insertTeachingAssignment,
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
  // The fixture student membership is suspended, so it never reaches the
  // student kind guard. That guard is checked directly below.
  await assert.rejects(
    () => authz.scopeQuery(studentMember, 'students.read_basic', 'student'),
    (error: Error & { code?: string }) => error.code === 'ACCESS_DENIED',
  )
  assert.throws(
    () =>
      createReadPlan(studentMember, 'students.read_basic', 'student', { accessVersion: 1, grants: [], exceptions: [] }, {
        selfStaffId: null,
        assignments: [],
        ownChildStudentIds: [],
      }),
    (error: Error & { code?: string }) => error.code === 'FEATURE_DISABLED',
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
