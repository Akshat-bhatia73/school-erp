import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { PermissionKey, ResourceType } from '@erp/contracts'
import type { RequestContext, ResourceReference } from '@erp/contracts/server'

import { AuthorizationError } from '../src/errors.ts'
import { createAuthorizationService } from '../src/service.ts'
import {
  cleanup,
  contextFor,
  fx,
  insertAccessRule,
  insertEnrollment,
  insertGuardian,
  insertGuardianLink,
  insertMembership,
  insertStudent,
  insertStudentLogin,
  insertSubject,
  insertTeachingAssignment,
  runtime,
  seed,
} from './harness.ts'

const authz = createAuthorizationService({ pool: runtime })

let schoolA = ''
let schoolB = ''
let sectionStudentId = ''
let unrelatedStudentId = ''

function ref(resourceType: ResourceType, id: string, schoolId = schoolA): ResourceReference {
  return { schoolId, resourceType, id }
}

async function code(
  context: RequestContext,
  permission: PermissionKey,
  resource: ResourceReference,
): Promise<string> {
  const decision = await authz.authorize(context, permission, resource)
  return decision.allowed ? 'ALLOWED' : decision.code
}

before(async () => {
  await seed()
  schoolA = fx('schoolA')
  schoolB = fx('schoolB')
  const subjectId = await insertSubject(schoolA)
  await insertTeachingAssignment({
    schoolId: schoolA,
    staffId: fx('staffA'),
    academicYearId: fx('yearA'),
    sectionId: fx('sectionA'),
    subjectId,
  })
  sectionStudentId = await insertStudent(schoolA, 'Section')
  await insertEnrollment({
    schoolId: schoolA,
    studentId: sectionStudentId,
    academicYearId: fx('yearA'),
    sectionId: fx('sectionA'),
  })
  unrelatedStudentId = await insertStudent(schoolA, 'Unrelated')
})

after(cleanup)

function ownerContext(assurance: 'single_factor' | 'mfa' = 'mfa'): RequestContext {
  return contextFor({ schoolId: schoolA, membershipId: fx('ownerA'), roleKeys: ['owner'], assurance })
}

function adultContext(): RequestContext {
  return contextFor({
    schoolId: schoolA,
    membershipId: fx('adult'),
    roleKeys: ['teacher', 'parent'],
    assurance: 'single_factor',
  })
}

test('owner reads a student with two-step verification and is refused without it', async () => {
  assert.equal(await code(ownerContext(), 'students.read_basic', ref('student', fx('studentA'))), 'ALLOWED')
  assert.equal(
    await code(ownerContext('single_factor'), 'students.read_basic', ref('student', fx('studentA'))),
    'MFA_REQUIRED',
  )
})

test('a resource in another school is not found, whichever school id is supplied', async () => {
  assert.equal(
    await code(ownerContext(), 'students.read_basic', ref('student', fx('studentB'), schoolB)),
    'RESOURCE_NOT_FOUND',
  )
  assert.equal(
    await code(ownerContext(), 'students.read_basic', ref('student', fx('studentB'))),
    'RESOURCE_NOT_FOUND',
  )
})

test('teacher and parent relationships are read from the database', async () => {
  const context = adultContext()
  assert.equal(await code(context, 'students.read_basic', ref('student', fx('studentA'))), 'ALLOWED')
  assert.equal(await code(context, 'students.read_basic', ref('student', sectionStudentId)), 'ALLOWED')
  assert.equal(
    await code(context, 'students.read_guardian_contact', ref('student', unrelatedStudentId)),
    'ACCESS_DENIED',
  )
  // Own child fields outside the parent template stay closed.
  assert.equal(await code(context, 'students.read_sensitive', ref('student', fx('studentA'))), 'ACCESS_DENIED')
})

test('the school-wide allow exception widens the basic student read', async () => {
  assert.equal(
    await code(adultContext(), 'students.read_basic', ref('student', unrelatedStudentId)),
    'ALLOWED',
  )
})

test('an expired allow exception grants nothing', async () => {
  const current = await insertMembership({ schoolId: schoolA, roleKeys: ['parent'] })
  const expired = await insertMembership({ schoolId: schoolA, roleKeys: ['parent'] })
  await insertAccessRule({
    schoolId: schoolA,
    membershipId: current.membershipId,
    permission: 'students.read_basic',
    effect: 'allow',
    targetType: 'school',
    expiresAt: '2099-01-01T00:00:00.000Z',
    authorMembershipId: fx('ownerA'),
  })
  await insertAccessRule({
    schoolId: schoolA,
    membershipId: expired.membershipId,
    permission: 'students.read_basic',
    effect: 'allow',
    targetType: 'school',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    expiresAt: '2021-01-01T00:00:00.000Z',
    authorMembershipId: fx('ownerA'),
  })
  const resource = ref('student', unrelatedStudentId)
  const currentContext = contextFor({
    schoolId: schoolA,
    membershipId: current.membershipId,
    roleKeys: ['parent'],
    assurance: 'single_factor',
  })
  const expiredContext = contextFor({
    schoolId: schoolA,
    membershipId: expired.membershipId,
    roleKeys: ['parent'],
    assurance: 'single_factor',
  })
  assert.equal(await code(currentContext, 'students.read_basic', resource), 'ALLOWED')
  assert.equal(await code(expiredContext, 'students.read_basic', resource), 'ACCESS_DENIED')
})

test('a suspended membership has no access at all', async () => {
  const context = contextFor({
    schoolId: schoolA,
    membershipId: fx('suspended'),
    roleKeys: ['teacher'],
    assurance: 'single_factor',
  })
  assert.equal(await code(context, 'holidays.read', ref('holiday', crypto.randomUUID())), 'ACCESS_DENIED')
})

test('a pupil\'s own login reads the pupil, and a student context with any other role is refused', async () => {
  // Task 23: an active student membership exists now. It reads its own pupil
  // and nobody else.
  const pupil = await insertStudentLogin(schoolA, sectionStudentId)
  const own = contextFor({
    schoolId: schoolA,
    membershipId: pupil.membershipId,
    roleKeys: ['student'],
    membershipKind: 'student',
    assurance: 'single_factor',
  })
  assert.equal(await code(own, 'students.read_basic', ref('student', sectionStudentId)), 'ALLOWED')
  assert.equal(await code(own, 'sections.read', ref('section', fx('sectionA'))), 'ALLOWED')
  assert.equal(await code(own, 'students.read_basic', ref('student', fx('studentA'))), 'ACCESS_DENIED')
  assert.equal(await code(own, 'students.read_basic', ref('student', unrelatedStudentId)), 'ACCESS_DENIED')
  assert.equal(await code(own, 'students.read_guardian_contact', ref('student', sectionStudentId)), 'ACCESS_DENIED')
  assert.equal(await code(own, 'students.read_basic', ref('student', fx('studentB'), schoolB)), 'RESOURCE_NOT_FOUND')

  // A student context holding an adult role is refused, whatever the role grants.
  const member = await insertMembership({ schoolId: schoolA, roleKeys: ['parent'] })
  const context = contextFor({
    schoolId: schoolA,
    membershipId: member.membershipId,
    roleKeys: ['parent'],
    membershipKind: 'student',
    assurance: 'single_factor',
  })
  assert.equal(
    await code(context, 'students.read_basic', ref('student', fx('studentA2'))),
    'ACCESS_DENIED',
  )
  // And an adult context holding the student role.
  assert.equal(
    await code({ ...own, membershipKind: 'adult' }, 'students.read_basic', ref('student', sectionStudentId)),
    'ACCESS_DENIED',
  )
  // The suspended student membership from the fixtures has no access at all.
  const suspendedStudent = contextFor({
    schoolId: schoolA,
    membershipId: fx('studentMember'),
    roleKeys: ['student'],
    membershipKind: 'student',
    assurance: 'single_factor',
  })
  assert.equal(
    await code(suspendedStudent, 'students.read_basic', ref('student', fx('studentA2'))),
    'ACCESS_DENIED',
  )
})

test('a stale access version is refused', async () => {
  const context = contextFor({
    schoolId: schoolA,
    membershipId: fx('ownerA'),
    roleKeys: ['owner'],
    accessVersion: 99,
  })
  assert.equal(await code(context, 'students.read_basic', ref('student', fx('studentA'))), 'ACCESS_DENIED')
})

test('allowedActions lists only what the parent may do on its own child', async () => {
  const context = contextFor({
    schoolId: schoolA,
    membershipId: fx('parentA2'),
    roleKeys: ['parent'],
    assurance: 'single_factor',
  })
  const actions = await authz.allowedActions(context, ref('student', fx('studentA2')))
  assert.ok(actions.includes('students.read_basic'))
  assert.ok(actions.includes('students.read_guardian_contact'))
  assert.ok(!actions.includes('students.read_sensitive'))
  assert.ok(!actions.includes('students.update_basic'))
})

test('capabilities list what a member could exercise somewhere in the school', async () => {
  const owner = await authz.capabilities(ownerContext())
  assert.ok(owner.includes('students.read_medical'))
  assert.ok(owner.includes('members.invite'))

  // Role level assurance is a property of the caller, so the whole hint is
  // refused rather than returned as an empty list.
  await assert.rejects(
    () => authz.capabilities(ownerContext('single_factor')),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'MFA_REQUIRED',
  )

  const adult = await authz.capabilities(adultContext())
  assert.ok(adult.includes('students.read_basic'))
  // The self scope answers on the aggregate because this member has a staff record.
  assert.ok(adult.includes('staff.read_employment'))
  assert.ok(adult.includes('timetable.read'))
  assert.ok(!adult.includes('staff.read_pay'))
  assert.ok(!adult.includes('students.read_medical'))

  // A guardian link on its own is not access: the approval row is what counts.
  const unapproved = await insertMembership({ schoolId: schoolA, roleKeys: ['parent'] })
  const guardianId = await insertGuardian(schoolA)
  await insertGuardianLink(schoolA, unapproved.membershipId, guardianId)
  const childless = await authz.capabilities(
    contextFor({
      schoolId: schoolA,
      membershipId: unapproved.membershipId,
      roleKeys: ['parent'],
      assurance: 'single_factor',
    }),
  )
  assert.ok(!childless.includes('students.read_basic'))
})

test('allowedActions refuses a membership that is not active', async () => {
  const context = contextFor({
    schoolId: schoolA,
    membershipId: fx('suspended'),
    roleKeys: ['teacher'],
    assurance: 'single_factor',
  })
  await assert.rejects(
    () => authz.allowedActions(context, ref('school', schoolA)),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'ACCESS_DENIED',
  )
})

test('explainAccess needs the explain permission and then describes the target', async () => {
  const admin = await insertMembership({ schoolId: schoolA, roleKeys: ['admin'] })
  const adminContext = contextFor({
    schoolId: schoolA,
    membershipId: admin.membershipId,
    roleKeys: ['admin'],
  })
  await assert.rejects(
    () =>
      authz.explainAccess(adminContext, fx('parentA2'), 'students.read_basic', ref('student', fx('studentA2'))),
    (error: unknown) => error instanceof AuthorizationError && error.code === 'ACCESS_DENIED',
  )

  const explanation = await authz.explainAccess(
    ownerContext(),
    fx('parentA2'),
    'students.read_basic',
    ref('student', fx('studentA2')),
  )
  assert.equal(explanation.allowed, true)
  assert.ok(explanation.sources.some((source) => source.kind === 'role'))
  assert.ok(explanation.sources.some((source) => source.kind === 'relationship'))

  const refused = await authz.explainAccess(
    ownerContext(),
    fx('parentA2'),
    'students.read_basic',
    ref('student', unrelatedStudentId),
  )
  assert.equal(refused.allowed, false)
  assert.ok(refused.sources.every((source) => !source.description.includes(fx('studentA2'))))
})

test('scopeQuery returns a plan bound to this school, member and version', async () => {
  const plan = await authz.scopeQuery(ownerContext(), 'students.read_basic', 'student')
  assert.equal(plan.schoolId, schoolA)
  assert.equal(plan.membershipId, fx('ownerA'))
  assert.equal(plan.permission, 'students.read_basic')
  assert.equal(plan.resourceType, 'student')
  assert.equal(plan.accessVersion, 1)
})
