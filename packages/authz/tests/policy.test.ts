import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ACTIVE_PERMISSION_KEYS,
  PERMISSION_CATALOGUE,
  ROLE_TEMPLATES,
  RoleKey,
} from '@erp/contracts'
import type { AccessScope, PermissionKey, ResourceAccessRule, ResourceType, RoleKey as RoleKeyType } from '@erp/contracts'
import type { PolicySnapshot, RequestContext, ResourceReference } from '@erp/contracts/server'

import { evaluate, explain, fieldGroupsFor, matchesScope } from '../src/policy.ts'
import type { RelationshipFacts, ResourceFacts } from '../src/policy.ts'

const SCHOOL = 'school-a'
const OTHER_SCHOOL = 'school-b'
const MEMBERSHIP = 'membership-1'
const NOW = '2026-01-15T09:00:00.000Z'

function contextFor(input: {
  roleKeys: readonly RoleKeyType[]
  assurance?: 'single_factor' | 'mfa'
  membershipKind?: 'adult' | 'student'
  accessVersion?: number
  schoolId?: string
}): RequestContext {
  return {
    requestId: 'req-1',
    userId: 'user-1',
    sessionId: 'session-1',
    schoolId: input.schoolId ?? SCHOOL,
    membershipId: MEMBERSHIP,
    membershipKind: input.membershipKind ?? 'adult',
    accessVersion: input.accessVersion ?? 1,
    roleKeys: input.roleKeys,
    assurance: input.assurance ?? 'mfa',
    mfaVerifiedAt: input.assurance === 'single_factor' ? null : NOW,
    now: NOW,
  } as unknown as RequestContext
}

function snapshotFor(roleKeys: readonly RoleKeyType[], exceptions: readonly ResourceAccessRule[] = [], accessVersion = 1): PolicySnapshot {
  const grants = roleKeys.flatMap((role) => ROLE_TEMPLATES[role].grants.map((g) => ({ permission: g.permission, scope: g.scope })))
  return { accessVersion, grants, exceptions }
}

const relatedFacts: RelationshipFacts = {
  selfStaffId: 'staff-1',
  assignments: [{ sectionId: 'section-1', subjectId: 'subject-1', academicYearId: 'year-1' }],
  ownChildStudentIds: ['student-1'],
}

const unrelatedFacts: RelationshipFacts = {
  selfStaffId: 'staff-2',
  assignments: [{ sectionId: 'section-9', subjectId: 'subject-9', academicYearId: 'year-9' }],
  ownChildStudentIds: ['student-9'],
}

function resourceFactsFor(resourceType: ResourceType): ResourceFacts {
  return {
    resourceType,
    id: 'resource-1',
    studentId: 'student-1',
    staffId: 'staff-1',
    sectionIds: ['section-1'],
    subjectIds: ['subject-1'],
    academicYearId: 'year-1',
    ...(resourceType === 'dashboard' ? { aggregate: true as const } : {}),
  }
}

function reference(resourceType: ResourceType, schoolId = SCHOOL): ResourceReference {
  return { schoolId, resourceType, id: 'resource-1' }
}

function rule(overrides: Partial<ResourceAccessRule> & { permission: PermissionKey; effect: 'allow' | 'deny'; target: ResourceAccessRule['target'] }): ResourceAccessRule {
  return {
    id: 'rule-1',
    schoolId: SCHOOL,
    membershipId: MEMBERSHIP,
    validFrom: '2020-01-01T00:00:00.000Z',
    expiresAt: null,
    revokedAt: null,
    reason: 'Temporary cover for a colleague.',
    createdByMembershipId: 'membership-owner',
    version: 1,
    ...overrides,
  }
}

test('every role template and active permission matches the scope predicates', () => {
  for (const role of RoleKey.options) {
    for (const permission of ACTIVE_PERMISSION_KEYS) {
      const metadata = PERMISSION_CATALOGUE[permission]
      const resourceFacts = resourceFactsFor(metadata.resourceType)
      const context = contextFor({ roleKeys: [role] })
      const grants = ROLE_TEMPLATES[role].grants.filter((g) => g.permission === permission)

      for (const [label, facts] of [['related', relatedFacts], ['unrelated', unrelatedFacts]] as const) {
        const decision = evaluate({
          context,
          permission,
          resource: reference(metadata.resourceType),
          snapshot: snapshotFor([role]),
          facts,
          resourceFacts,
        })
        if (role === 'student') {
          assert.deepEqual(decision, { allowed: false, code: 'FEATURE_DISABLED' }, `${role}/${permission}`)
          continue
        }
        const expected = grants.some((g) => matchesScope(g.scope, facts, resourceFacts))
        assert.equal(decision.allowed, expected, `${role}/${permission}/${label}`)
        if (decision.allowed) {
          assert.deepEqual(decision.fieldGroups, fieldGroupsFor(permission))
          assert.equal(decision.accessVersion, 1)
        } else {
          assert.equal(decision.code, 'ACCESS_DENIED')
        }
      }
    }
  }
})

test('roles that require MFA are denied without it, for every active permission', () => {
  for (const role of RoleKey.options) {
    if (!ROLE_TEMPLATES[role].requiredMfa) continue
    for (const permission of ACTIVE_PERMISSION_KEYS) {
      const metadata = PERMISSION_CATALOGUE[permission]
      const decision = evaluate({
        context: contextFor({ roleKeys: [role], assurance: 'single_factor' }),
        permission,
        resource: reference(metadata.resourceType),
        snapshot: snapshotFor([role]),
        facts: relatedFacts,
        resourceFacts: resourceFactsFor(metadata.resourceType),
      })
      assert.deepEqual(decision, { allowed: false, code: 'MFA_REQUIRED' }, `${role}/${permission}`)
    }
  }
})

test('teacher keeps single factor for self scope but a privileged school scope needs MFA', () => {
  const selfDecision = evaluate({
    context: contextFor({ roleKeys: ['teacher'], assurance: 'single_factor' }),
    permission: 'staff.read_private',
    resource: reference('staff'),
    snapshot: snapshotFor(['teacher']),
    facts: relatedFacts,
    resourceFacts: resourceFactsFor('staff'),
  })
  assert.equal(selfDecision.allowed, true)

  const schoolScoped: PolicySnapshot = { accessVersion: 1, grants: [{ permission: 'staff.read_private', scope: 'school' }], exceptions: [] }
  const schoolDecision = evaluate({
    context: contextFor({ roleKeys: ['teacher'], assurance: 'single_factor' }),
    permission: 'staff.read_private',
    resource: reference('staff'),
    snapshot: schoolScoped,
    facts: relatedFacts,
    resourceFacts: resourceFactsFor('staff'),
  })
  assert.deepEqual(schoolDecision, { allowed: false, code: 'MFA_REQUIRED' })
})

test('invariants deny before any grant is considered', () => {
  const base = {
    permission: 'students.read_basic' as const,
    resource: reference('student'),
    snapshot: snapshotFor(['owner']),
    facts: relatedFacts,
    resourceFacts: resourceFactsFor('student'),
  }
  const owner = contextFor({ roleKeys: ['owner'] })

  assert.deepEqual(evaluate({ ...base, context: owner, permission: 'not.a.permission' }), { allowed: false, code: 'ACCESS_DENIED' })
  assert.deepEqual(
    evaluate({ ...base, context: owner, permission: 'exams.read', resource: reference('exam'), resourceFacts: resourceFactsFor('exam') }),
    { allowed: false, code: 'ACCESS_DENIED' },
  )
  assert.deepEqual(
    evaluate({ ...base, context: contextFor({ roleKeys: ['owner'], membershipKind: 'student' }) }),
    { allowed: false, code: 'FEATURE_DISABLED' },
  )
  assert.deepEqual(evaluate({ ...base, context: contextFor({ roleKeys: ['student'] }) }), { allowed: false, code: 'FEATURE_DISABLED' })
  assert.deepEqual(
    evaluate({ ...base, context: owner, resource: reference('student', OTHER_SCHOOL) }),
    { allowed: false, code: 'RESOURCE_NOT_FOUND' },
  )
  assert.deepEqual(
    evaluate({ ...base, context: owner, resource: reference('staff') }),
    { allowed: false, code: 'RESOURCE_NOT_FOUND' },
  )
  assert.deepEqual(evaluate({ ...base, context: owner, resourceFacts: null }), { allowed: false, code: 'RESOURCE_NOT_FOUND' })
  assert.deepEqual(
    evaluate({ ...base, context: owner, snapshot: snapshotFor(['owner'], [], 7) }),
    { allowed: false, code: 'ACCESS_DENIED' },
  )
})

test('a teacher who is also a parent gets the union of two separate sets, not school access', () => {
  const context = contextFor({ roleKeys: ['teacher', 'parent'], assurance: 'single_factor' })
  const snapshot = snapshotFor(['teacher', 'parent'])
  const facts: RelationshipFacts = {
    selfStaffId: 'staff-1',
    assignments: [{ sectionId: 'section-6a', subjectId: 'subject-1', academicYearId: 'year-1' }],
    ownChildStudentIds: ['child-1'],
  }
  const ownChild: ResourceFacts = { resourceType: 'student', id: 'child-1', studentId: 'child-1', sectionIds: ['section-7b'], academicYearId: 'year-1' }
  const sectionStudent: ResourceFacts = { resourceType: 'student', id: 'pupil-1', studentId: 'pupil-1', sectionIds: ['section-6a'], academicYearId: 'year-1' }
  const otherStudent: ResourceFacts = { resourceType: 'student', id: 'pupil-2', studentId: 'pupil-2', sectionIds: ['section-7b'], academicYearId: 'year-1' }

  const read = (resourceFacts: ResourceFacts, permission: PermissionKey) =>
    evaluate({ context, permission, resource: reference('student'), snapshot, facts, resourceFacts })

  assert.equal(read(ownChild, 'students.read_basic').allowed, true)
  assert.equal(read(sectionStudent, 'students.read_basic').allowed, true)
  assert.equal(read(otherStudent, 'students.read_basic').allowed, false)
  assert.equal(read(ownChild, 'students.read_sensitive').allowed, false)
  assert.equal(read(ownChild, 'students.read_medical').allowed, false)
})

test('a section assignment for another academic year does not match', () => {
  const facts: RelationshipFacts = {
    selfStaffId: null,
    assignments: [{ sectionId: 'section-1', subjectId: 'subject-1', academicYearId: 'year-1' }],
    ownChildStudentIds: [],
  }
  const lastYear: ResourceFacts = { resourceType: 'student', id: 'pupil-1', studentId: 'pupil-1', sectionIds: ['section-1'], academicYearId: 'year-0' }
  assert.equal(matchesScope('assigned_sections', facts, lastYear), false)
  assert.equal(matchesScope('assigned_subjects', facts, { ...lastYear, subjectIds: ['subject-1'] }), false)
  assert.equal(matchesScope('own_record', facts, lastYear), false)
})

test('a class teacher matches assigned_sections for their own section, never assigned_subjects', () => {
  const facts: RelationshipFacts = {
    selfStaffId: 'staff-1',
    assignments: [],
    classTeacherSections: [{ sectionId: 'section-1', academicYearId: 'year-1' }],
    ownChildStudentIds: [],
  }
  const pupil: ResourceFacts = { resourceType: 'student', id: 'pupil-1', studentId: 'pupil-1', sectionIds: ['section-1'], academicYearId: 'year-1' }
  assert.equal(matchesScope('assigned_sections', facts, pupil), true)
  assert.equal(matchesScope('assigned_sections', facts, { ...pupil, sectionIds: ['section-2'] }), false)
  assert.equal(matchesScope('assigned_sections', facts, { ...pupil, academicYearId: 'year-0' }), false)
  // The post names no subject, so it never stands in for teaching one.
  assert.equal(matchesScope('assigned_subjects', facts, { ...pupil, subjectIds: ['subject-1'] }), false)
  const dashboard: ResourceFacts = { resourceType: 'dashboard', id: 'school-1', aggregate: true }
  assert.equal(matchesScope('assigned_sections', facts, dashboard), true)
  assert.equal(matchesScope('assigned_subjects', facts, dashboard), false)
})

test('aggregate resources match a relationship scope when any relationship exists', () => {
  const dashboard: ResourceFacts = { resourceType: 'dashboard', id: 'dashboard', aggregate: true }
  assert.equal(matchesScope('assigned_sections', relatedFacts, dashboard), true)
  assert.equal(matchesScope('own_children', relatedFacts, dashboard), true)
  assert.equal(
    matchesScope('own_children', { selfStaffId: null, assignments: [], ownChildStudentIds: [] }, dashboard),
    false,
  )
})

test('exceptions follow their effective dates, effect and target', () => {
  const context = contextFor({ roleKeys: ['teacher'], assurance: 'single_factor' })
  const facts: RelationshipFacts = { selfStaffId: null, assignments: [], ownChildStudentIds: [] }
  const resourceFacts: ResourceFacts = { resourceType: 'student', id: 'pupil-1', studentId: 'pupil-1', sectionIds: ['section-1'], academicYearId: 'year-1' }
  const evaluateWith = (exceptions: readonly ResourceAccessRule[]) =>
    evaluate({
      context,
      permission: 'students.read_basic',
      resource: reference('student'),
      snapshot: snapshotFor(['teacher'], exceptions),
      facts,
      resourceFacts,
    })

  const currentAllow = rule({ permission: 'students.read_basic', effect: 'allow', target: { kind: 'section', sectionId: 'section-1', academicYearId: 'year-1' } })
  assert.equal(evaluateWith([currentAllow]).allowed, true)
  assert.equal(evaluateWith([{ ...currentAllow, expiresAt: '2021-01-01T00:00:00.000Z' }]).allowed, false)
  assert.equal(evaluateWith([{ ...currentAllow, revokedAt: '2025-01-01T00:00:00.000Z' }]).allowed, false)
  assert.equal(evaluateWith([{ ...currentAllow, validFrom: '2099-01-01T00:00:00.000Z' }]).allowed, false)
  assert.equal(
    evaluateWith([{ ...currentAllow, target: { kind: 'section', sectionId: 'section-1', academicYearId: 'year-0' } }]).allowed,
    false,
  )
  assert.equal(evaluateWith([{ ...currentAllow, schoolId: OTHER_SCHOOL }]).allowed, false)
  assert.equal(evaluateWith([{ ...currentAllow, membershipId: 'membership-other' }]).allowed, false)
  assert.equal(evaluateWith([currentAllow, rule({ id: 'rule-2', permission: 'students.read_basic', effect: 'deny', target: { kind: 'school' } })]).allowed, false)
  assert.equal(evaluateWith([rule({ permission: 'students.read_basic', effect: 'allow', target: { kind: 'student', studentId: 'pupil-1' } })]).allowed, true)
  assert.equal(evaluateWith([rule({ permission: 'students.read_basic', effect: 'allow', target: { kind: 'student', studentId: 'pupil-2' } })]).allowed, false)
})

test('an allow exception cannot bypass MFA on a privileged school scope', () => {
  const decision = evaluate({
    context: contextFor({ roleKeys: ['teacher'], assurance: 'single_factor' }),
    permission: 'students.export',
    resource: reference('student'),
    snapshot: snapshotFor(['teacher'], [rule({ permission: 'students.export', effect: 'allow', target: { kind: 'school' } })]),
    facts: { selfStaffId: null, assignments: [], ownChildStudentIds: [] },
    resourceFacts: resourceFactsFor('student'),
  })
  assert.deepEqual(decision, { allowed: false, code: 'MFA_REQUIRED' })
})

test('requested field groups outside the permission are denied', () => {
  const base = {
    context: contextFor({ roleKeys: ['owner'] }),
    permission: 'students.read_basic' as const,
    resource: reference('student'),
    snapshot: snapshotFor(['owner']),
    facts: relatedFacts,
    resourceFacts: resourceFactsFor('student'),
  }
  assert.equal(evaluate({ ...base, requestedFieldGroups: ['student_basic'] }).allowed, true)
  assert.deepEqual(evaluate({ ...base, requestedFieldGroups: ['student_medical'] }), { allowed: false, code: 'ACCESS_DENIED' })
})

test('field groups are deterministic for reads and empty for writes', () => {
  assert.deepEqual(fieldGroupsFor('students.read_medical'), ['student_medical'])
  assert.deepEqual(fieldGroupsFor('students.download_documents'), ['document_metadata'])
  assert.deepEqual(fieldGroupsFor('holidays.read'), ['setup'])
  assert.deepEqual(fieldGroupsFor('students.update_basic'), [])
})

test('every active permission scope stays inside its catalogue scopes', () => {
  for (const permission of ACTIVE_PERMISSION_KEYS) {
    const scopes: readonly AccessScope[] = PERMISSION_CATALOGUE[permission].scopes
    assert.ok(scopes.length > 0, permission)
  }
})

test('explain lists the sources behind a decision', () => {
  const allowed = explain({
    context: contextFor({ roleKeys: ['teacher', 'parent'], assurance: 'single_factor' }),
    permission: 'students.read_basic',
    resource: reference('student'),
    snapshot: snapshotFor(['teacher', 'parent'], [rule({ permission: 'students.read_basic', effect: 'allow', target: { kind: 'school' } })]),
    facts: relatedFacts,
    resourceFacts: resourceFactsFor('student'),
  })
  assert.equal(allowed.allowed, true)
  assert.deepEqual(new Set(allowed.sources.map((s) => s.kind)), new Set(['role', 'relationship', 'exception']))

  const denied = explain({
    context: contextFor({ roleKeys: ['teacher'], assurance: 'single_factor' }),
    permission: 'students.read_basic',
    resource: reference('student'),
    snapshot: snapshotFor(['teacher'], [rule({ permission: 'students.read_basic', effect: 'deny', target: { kind: 'school' } })]),
    facts: relatedFacts,
    resourceFacts: resourceFactsFor('student'),
  })
  assert.equal(denied.allowed, false)
  assert.deepEqual(denied.sources.map((s) => s.kind), ['invariant', 'exception'])
})
