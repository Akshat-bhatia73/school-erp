import { PERMISSION_CATALOGUE, PermissionKey, ROLE_TEMPLATES, isFinanceAuditAction } from '@erp/contracts'
import type { AccessScope, ErrorCode, ResourceAccessRule, ResourceType, RoleKey } from '@erp/contracts'
import type {
  AccessExplanation,
  AuthorizationDecision,
  FieldGroup,
  PolicyGrant,
  PolicySnapshot,
  RequestContext,
  ResourceReference,
} from '@erp/contracts/server'

export interface RelationshipFacts {
  readonly selfStaffId: string | null
  /** Already filtered to assignments effective at context.now. */
  readonly assignments: readonly { sectionId: string; subjectId: string; academicYearId: string }[]
  /** Approved, unrevoked guardian_student_access reached through a verified membership_guardian_link. */
  readonly ownChildStudentIds: readonly string[]
}

/**
 * Attributes of the referenced resource, loaded by the caller.
 * The caller passes null when the resource does not exist in this school.
 * `sectionIds` only ever holds sections whose academic year is `academicYearId`
 * when that field is set; otherwise any assignment year may match.
 */
export interface ResourceFacts {
  readonly resourceType: ResourceType
  readonly id: string
  readonly studentId?: string
  readonly staffId?: string
  readonly sectionIds?: readonly string[]
  readonly subjectIds?: readonly string[]
  readonly academicYearId?: string
  /** The audited action of one audit event, which decides its finance audience. */
  readonly action?: string
  /** Set for resources that summarise the whole authorized dataset, such as the dashboard. */
  readonly aggregate?: true
}

export interface EvaluateInput {
  readonly context: RequestContext
  readonly permission: string
  readonly resource: ResourceReference
  readonly snapshot: PolicySnapshot
  readonly facts: RelationshipFacts
  readonly resourceFacts: ResourceFacts | null
  readonly requestedFieldGroups?: readonly FieldGroup[]
}

const FIELD_GROUPS: Partial<Record<PermissionKey, readonly FieldGroup[]>> = {
  'students.read_basic': ['student_basic'],
  'students.read_sensitive': ['student_sensitive'],
  'students.read_medical': ['student_medical'],
  'students.read_guardian_contact': ['guardian_contact'],
  'students.read_guardians': ['guardian_private'],
  'students.read_documents': ['document_metadata'],
  'students.download_documents': ['document_metadata'],
  'staff.read_directory': ['staff_directory'],
  'staff.read_employment': ['staff_employment'],
  'staff.read_private': ['staff_private'],
  'staff.read_pay': ['staff_pay'],
  'timetable.read': ['timetable'],
  'audit.read': ['audit_summary'],
  'school.read': ['setup'],
  'academic_years.read': ['setup'],
  'grades.read': ['setup'],
  'sections.read': ['setup'],
  'subjects.read': ['setup'],
  'holidays.read': ['setup'],
}

const NO_FIELD_GROUPS: readonly FieldGroup[] = []

export function fieldGroupsFor(permission: PermissionKey): readonly FieldGroup[] {
  return FIELD_GROUPS[permission] ?? NO_FIELD_GROUPS
}

export function matchesScope(scope: AccessScope, facts: RelationshipFacts, resourceFacts: ResourceFacts): boolean {
  switch (scope) {
    case 'school':
      return true
    case 'finance':
      // Row scope is the school and the projection is narrowed by field
      // groups, except over the audit trail, where the rows themselves carry
      // the audience: one audit event is readable only when its action is a
      // finance action, exactly as the list predicate selects it.
      if (resourceFacts.resourceType === 'audit_event' && resourceFacts.aggregate !== true)
        return resourceFacts.action !== undefined && isFinanceAuditAction(resourceFacts.action)
      return true
    case 'self':
      if (facts.selfStaffId === null) return false
      // An aggregate resource stands for the whole dataset, so a caller who has
      // a staff record of their own can exercise the scope somewhere in it.
      if (resourceFacts.aggregate === true) return true
      return resourceFacts.staffId === facts.selfStaffId
    case 'assigned_sections':
      if (resourceFacts.aggregate === true) return facts.assignments.length > 0
      return facts.assignments.some((assignment) => sectionMatches(assignment, resourceFacts))
    case 'assigned_subjects':
      if (resourceFacts.aggregate === true) return facts.assignments.length > 0
      return facts.assignments.some(
        (assignment) =>
          sectionMatches(assignment, resourceFacts) &&
          (resourceFacts.subjectIds ?? []).includes(assignment.subjectId),
      )
    case 'own_children':
      if (resourceFacts.aggregate === true) return facts.ownChildStudentIds.length > 0
      return resourceFacts.studentId !== undefined && facts.ownChildStudentIds.includes(resourceFacts.studentId)
    case 'own_record':
      // Student login is disabled, so nothing is ever the caller's own record.
      return false
  }
}

function sectionMatches(
  assignment: { sectionId: string; academicYearId: string },
  resourceFacts: ResourceFacts,
): boolean {
  if (!(resourceFacts.sectionIds ?? []).includes(assignment.sectionId)) return false
  return resourceFacts.academicYearId === undefined || resourceFacts.academicYearId === assignment.academicYearId
}

type Step =
  | {
      readonly kind: 'denied'
      readonly code: ErrorCode
      readonly reason: string
      readonly denyRules?: readonly ResourceAccessRule[]
    }
  | {
      readonly kind: 'allowed'
      readonly permission: PermissionKey
      readonly grants: readonly PolicyGrant[]
      readonly allows: readonly ResourceAccessRule[]
      readonly relationships: readonly string[]
    }

function isPermissionKey(value: string): value is PermissionKey {
  return PermissionKey.safeParse(value).success
}

function ruleApplicableAt(rule: ResourceAccessRule, now: number): boolean {
  if (rule.revokedAt !== null) return false
  if (Date.parse(rule.validFrom) > now) return false
  return rule.expiresAt === null || Date.parse(rule.expiresAt) > now
}

function ruleTargetMatches(rule: ResourceAccessRule, resourceFacts: ResourceFacts): boolean {
  const target = rule.target
  switch (target.kind) {
    case 'school':
      return true
    case 'section':
      return sectionMatches({ sectionId: target.sectionId, academicYearId: target.academicYearId }, resourceFacts)
    case 'student':
      return resourceFacts.studentId === target.studentId
    case 'staff':
      return resourceFacts.staffId === target.staffId
    case 'document':
      return resourceFacts.resourceType === 'student_document' && resourceFacts.id === target.documentId
  }
}

/** The scope an exception behaves like when deciding whether action-level MFA is required. */
function scopeOfRuleTarget(rule: ResourceAccessRule): AccessScope {
  return rule.target.kind === 'section' ? 'assigned_sections' : 'school'
}

function relationshipsUsed(scope: AccessScope): string | null {
  switch (scope) {
    case 'self':
      return 'Own staff record'
    case 'assigned_sections':
      return 'Current teaching assignment for this section'
    case 'assigned_subjects':
      return 'Current teaching assignment for this section and subject'
    case 'own_children':
      return 'Approved guardian link to this student'
    default:
      return null
  }
}

function run(input: EvaluateInput): Step {
  const { context, resource, snapshot, facts, resourceFacts } = input

  // 1. Unknown or reserved permissions never grant anything.
  if (!isPermissionKey(input.permission)) {
    return { kind: 'denied', code: 'ACCESS_DENIED', reason: 'The action is not a known permission.' }
  }
  const permission = input.permission
  const metadata = PERMISSION_CATALOGUE[permission]
  if (metadata.availability !== 'active') {
    return { kind: 'denied', code: 'ACCESS_DENIED', reason: 'The action is not available yet.' }
  }

  // 2. Student logins are disabled.
  if (context.membershipKind === 'student' || context.roleKeys.includes('student')) {
    return { kind: 'denied', code: 'FEATURE_DISABLED', reason: 'Student accounts cannot use this feature.' }
  }

  // 3. The resource must belong to this school and match the permission.
  if (resource.schoolId !== context.schoolId || resource.resourceType !== metadata.resourceType) {
    return { kind: 'denied', code: 'RESOURCE_NOT_FOUND', reason: 'The record is not part of this school.' }
  }
  if (resourceFacts === null) {
    return { kind: 'denied', code: 'RESOURCE_NOT_FOUND', reason: 'The record was not found.' }
  }

  // 4. A stale context must be re-resolved before it can be trusted.
  if (snapshot.accessVersion !== context.accessVersion) {
    return { kind: 'denied', code: 'ACCESS_DENIED', reason: 'Access has changed since this request started.' }
  }

  // 5. Role-level authentication strength.
  const mfaRole = context.roleKeys.some((role: RoleKey) => ROLE_TEMPLATES[role].requiredMfa)
  if (mfaRole && context.assurance !== 'mfa') {
    return { kind: 'denied', code: 'MFA_REQUIRED', reason: 'This role requires two-step verification.' }
  }

  // 6. Role grants. Scope predicates are independent and never ranked.
  const matchedGrants = snapshot.grants.filter(
    (policyGrant) => policyGrant.permission === permission && matchesScope(policyGrant.scope, facts, resourceFacts),
  )

  // 7. Exceptions.
  const now = Date.parse(context.now)
  const applicable = snapshot.exceptions.filter(
    (rule) =>
      rule.permission === permission &&
      rule.schoolId === context.schoolId &&
      rule.membershipId === context.membershipId &&
      ruleApplicableAt(rule, now) &&
      ruleTargetMatches(rule, resourceFacts),
  )

  // 8. Any applicable deny wins, however broad or narrow.
  const matchedDenies = applicable.filter((rule) => rule.effect === 'deny')
  if (matchedDenies.length > 0) {
    return {
      kind: 'denied',
      code: 'ACCESS_DENIED',
      reason: 'An explicit deny applies to this record.',
      denyRules: matchedDenies,
    }
  }

  const matchedAllows = applicable.filter((rule) => rule.effect === 'allow')

  // 9. Default deny.
  if (matchedGrants.length === 0 && matchedAllows.length === 0) {
    return { kind: 'denied', code: 'ACCESS_DENIED', reason: 'No role or exception allows this action here.' }
  }

  // 10. Action-level authentication strength. An exception never lowers it.
  if (context.assurance !== 'mfa') {
    const privileged: readonly AccessScope[] = metadata.privilegedScopes
    const matchedScopes: AccessScope[] = [
      ...matchedGrants.map((policyGrant) => policyGrant.scope),
      ...matchedAllows.map(scopeOfRuleTarget),
    ]
    if (matchedScopes.every((scope) => privileged.includes(scope))) {
      return { kind: 'denied', code: 'MFA_REQUIRED', reason: 'This action requires two-step verification.' }
    }
  }

  // 11. Field groups.
  const allowedGroups = fieldGroupsFor(permission)
  const requested = input.requestedFieldGroups ?? []
  if (requested.some((group) => !allowedGroups.includes(group))) {
    return { kind: 'denied', code: 'ACCESS_DENIED', reason: 'The requested fields are outside this permission.' }
  }

  const relationships = [
    ...new Set(
      matchedGrants
        .map((policyGrant) => relationshipsUsed(policyGrant.scope))
        .filter((value): value is string => value !== null),
    ),
  ]
  return { kind: 'allowed', permission, grants: matchedGrants, allows: matchedAllows, relationships }
}

export function evaluate(input: EvaluateInput): AuthorizationDecision {
  const step = run(input)
  if (step.kind === 'denied') return { allowed: false, code: step.code }
  return {
    allowed: true,
    fieldGroups: fieldGroupsFor(step.permission),
    accessVersion: input.snapshot.accessVersion,
  }
}

export function explain(input: EvaluateInput): AccessExplanation {
  const step = run(input)
  const sources: { kind: 'role' | 'relationship' | 'exception' | 'invariant'; description: string }[] = []
  if (step.kind === 'denied') {
    sources.push({ kind: 'invariant', description: step.reason })
    for (const rule of step.denyRules ?? []) {
      sources.push({ kind: 'exception', description: `Exception with effect ${rule.effect} on a ${rule.target.kind} target.` })
    }
    return { allowed: false, sources }
  }
  for (const policyGrant of step.grants) {
    sources.push({ kind: 'role', description: `Role grant for ${policyGrant.permission} with scope ${policyGrant.scope}.` })
  }
  for (const description of step.relationships) {
    sources.push({ kind: 'relationship', description })
  }
  for (const rule of step.allows) {
    sources.push({ kind: 'exception', description: `Exception with effect ${rule.effect} on a ${rule.target.kind} target.` })
  }
  return { allowed: true, sources }
}
