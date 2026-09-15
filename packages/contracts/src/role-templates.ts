import { z } from 'zod'

import { AccessScope, PermissionKey, PERMISSION_CATALOGUE } from './permissions.ts'

export const RoleKey = z.enum(['owner', 'principal', 'admin', 'accountant', 'teacher', 'parent', 'student'])
export type RoleKey = z.infer<typeof RoleKey>

export const RoleGrant = z.strictObject({
  permission: PermissionKey,
  scope: AccessScope,
}).superRefine((grantValue, context) => {
  const metadata = PERMISSION_CATALOGUE[grantValue.permission]
  if (metadata.availability !== 'active') {
    context.addIssue({ code: 'custom', path: ['permission'], message: 'Reserved permissions cannot be granted' })
  }
  if (!(metadata.scopes as readonly AccessScope[]).includes(grantValue.scope)) {
    context.addIssue({ code: 'custom', path: ['scope'], message: 'Scope is not supported by this permission' })
  }
})
export type RoleGrant = z.infer<typeof RoleGrant>

export interface RoleTemplate {
  displayName: string
  enabled: boolean
  requiredMfa: boolean
  grants: readonly RoleGrant[]
}

const grant = (permission: PermissionKey, scope: AccessScope): RoleGrant => ({ permission, scope })

const setupRead: readonly RoleGrant[] = [
  grant('school.read', 'school'), grant('academic_years.read', 'school'),
  grant('grades.read', 'school'), grant('sections.read', 'school'),
  grant('subjects.read', 'school'), grant('holidays.read', 'school'),
]

const operationsRead: readonly RoleGrant[] = [
  grant('students.read_basic', 'school'), grant('students.read_sensitive', 'school'),
  grant('students.read_guardian_contact', 'school'), grant('students.read_guardians', 'school'),
  grant('students.read_siblings', 'school'), grant('students.read_documents', 'school'),
  grant('students.download_documents', 'school'), grant('students.read_enrollments', 'school'),
  grant('staff.read_directory', 'school'), grant('staff.read_employment', 'school'),
  grant('timetable.read', 'school'), grant('timetable.read_conflicts', 'school'),
  grant('timetable.read_teacher_loads', 'school'), grant('dashboard.read', 'school'),
]

const operationsWrite: readonly RoleGrant[] = [
  grant('students.create', 'school'), grant('students.update_basic', 'school'),
  grant('students.update_sensitive', 'school'), grant('students.manage_enrollment', 'school'),
  grant('students.manage_guardians', 'school'), grant('students.import', 'school'),
  grant('students.export', 'school'), grant('students.promote', 'school'),
  grant('staff.create', 'school'), grant('staff.update_employment', 'school'),
  grant('staff.manage_assignments', 'school'), grant('staff.export', 'school'),
  grant('timetable.manage_periods', 'school'), grant('timetable.manage_entries', 'school'),
  grant('timetable.generate', 'school'), grant('timetable.manage_substitutions', 'school'),
  grant('timetable.notify_substitutions', 'school'),
]

const setupWrite: readonly RoleGrant[] = [
  grant('school.update', 'school'), grant('academic_years.manage', 'school'),
  grant('grades.manage', 'school'), grant('sections.manage', 'school'),
  grant('sections.read_strengths', 'school'), grant('subjects.manage', 'school'),
  grant('holidays.manage', 'school'),
]

export const ROLE_TEMPLATES = {
  owner: {
    displayName: 'Owner', enabled: true, requiredMfa: true,
    grants: [
      ...setupRead, ...setupWrite, ...operationsRead, ...operationsWrite,
      grant('students.read_medical', 'school'), grant('staff.read_private', 'school'),
      grant('staff.read_pay', 'finance'), grant('staff.update_private', 'school'),
      grant('staff.update_pay', 'finance'),
      grant('members.read', 'school'), grant('members.invite', 'school'),
      grant('members.suspend', 'school'),
      grant('members.remove', 'school'), grant('members.restore', 'school'),
      grant('members.manage_credentials', 'school'), grant('roles.read', 'school'),
      grant('roles.assign', 'school'), grant('access.explain', 'school'),
      grant('ownership.transfer', 'school'), grant('audit.read', 'school'),
      grant('audit.export', 'school'),
    ],
  },
  principal: {
    displayName: 'Principal', enabled: true, requiredMfa: true,
    grants: [
      ...setupRead, ...setupWrite, ...operationsRead, ...operationsWrite,
      grant('students.read_medical', 'school'), grant('staff.read_private', 'school'),
      grant('staff.update_private', 'school'), grant('members.read', 'school'),
      grant('members.invite', 'school'),
      grant('members.suspend', 'school'), grant('members.remove', 'school'),
      grant('members.restore', 'school'), grant('roles.read', 'school'),
      grant('roles.assign', 'school'), grant('audit.read', 'school'),
    ],
  },
  admin: {
    displayName: 'Administrator', enabled: true, requiredMfa: true,
    grants: [
      ...setupRead, ...setupWrite, ...operationsRead, ...operationsWrite,
      grant('staff.read_private', 'school'), grant('staff.update_private', 'school'),
      grant('members.read', 'school'), grant('members.invite', 'school'),
      grant('members.suspend', 'school'),
      grant('members.restore', 'school'), grant('roles.read', 'school'),
      grant('roles.assign', 'school'),
    ],
  },
  accountant: {
    displayName: 'Accountant', enabled: true, requiredMfa: true,
    grants: [
      ...setupRead,
      grant('students.read_basic', 'finance'),
      grant('students.read_guardian_contact', 'finance'),
      grant('staff.read_directory', 'school'), grant('staff.read_employment', 'school'),
      grant('staff.read_private', 'finance'), grant('staff.read_pay', 'finance'),
      grant('staff.update_pay', 'finance'), grant('staff.export', 'finance'),
      grant('audit.read', 'finance'), grant('audit.export', 'finance'),
      grant('dashboard.read', 'finance'),
    ],
  },
  teacher: {
    displayName: 'Teacher', enabled: true, requiredMfa: false,
    grants: [
      grant('grades.read', 'assigned_sections'), grant('sections.read', 'assigned_sections'),
      grant('sections.read_strengths', 'assigned_sections'), grant('subjects.read', 'assigned_subjects'),
      grant('holidays.read', 'school'), grant('students.read_basic', 'assigned_sections'),
      grant('students.read_guardian_contact', 'assigned_sections'),
      grant('students.read_enrollments', 'assigned_sections'),
      grant('staff.read_directory', 'self'), grant('staff.read_employment', 'self'),
      grant('staff.read_private', 'self'), grant('staff.update_private', 'self'),
      grant('timetable.read', 'self'), grant('timetable.read', 'assigned_sections'),
      grant('timetable.read', 'assigned_subjects'), grant('dashboard.read', 'assigned_sections'),
    ],
  },
  parent: {
    displayName: 'Parent', enabled: true, requiredMfa: false,
    grants: [
      grant('grades.read', 'own_children'), grant('sections.read', 'own_children'),
      grant('subjects.read', 'own_children'), grant('holidays.read', 'school'),
      grant('students.read_basic', 'own_children'),
      grant('students.read_guardian_contact', 'own_children'),
      grant('students.read_enrollments', 'own_children'),
      grant('timetable.read', 'own_children'),
      grant('dashboard.read', 'own_children'),
    ],
  },
  student: { displayName: 'Student', enabled: false, requiredMfa: false, grants: [] },
} as const satisfies Record<RoleKey, RoleTemplate>

export interface RoleDelegationRule {
  assignableRoles: readonly RoleKey[]
  mayTransferOwnership: boolean
}

/** Delegation is checked independently from the permissions a membership can exercise. */
export const ROLE_DELEGATION_RULES = {
  owner: { assignableRoles: ['principal', 'admin', 'accountant', 'teacher', 'parent'], mayTransferOwnership: true },
  principal: { assignableRoles: ['teacher'], mayTransferOwnership: false },
  admin: { assignableRoles: ['teacher'], mayTransferOwnership: false },
  accountant: { assignableRoles: [], mayTransferOwnership: false },
  teacher: { assignableRoles: [], mayTransferOwnership: false },
  parent: { assignableRoles: [], mayTransferOwnership: false },
  student: { assignableRoles: [], mayTransferOwnership: false },
} as const satisfies Record<RoleKey, RoleDelegationRule>

export interface RoleManagementRule {
  manageableTargetRoles: readonly RoleKey[]
}

/**
 * Lifecycle authority is independent from role assignment and members.* grants.
 * Every role on the target membership must be manageable by the actor, so a
 * teacher+owner target is forbidden to principals and administrators.
 */
export const ROLE_MANAGEMENT_RULES = {
  owner: { manageableTargetRoles: ['principal', 'admin', 'accountant', 'teacher', 'parent'] },
  principal: { manageableTargetRoles: ['teacher'] },
  admin: { manageableTargetRoles: ['teacher'] },
  accountant: { manageableTargetRoles: [] },
  teacher: { manageableTargetRoles: [] },
  parent: { manageableTargetRoles: [] },
  student: { manageableTargetRoles: [] },
} as const satisfies Record<RoleKey, RoleManagementRule>

// Compile-time shape checks above are paired with this import-time guard for reserved grants.
for (const template of Object.values(ROLE_TEMPLATES)) {
  for (const roleGrant of template.grants) {
    if (PERMISSION_CATALOGUE[roleGrant.permission].availability !== 'active') {
      throw new Error(`Role template includes reserved permission: ${roleGrant.permission}`)
    }
    if (!(PERMISSION_CATALOGUE[roleGrant.permission].scopes as readonly AccessScope[]).includes(roleGrant.scope)) {
      throw new Error(`Role template uses unsupported scope: ${roleGrant.permission}:${roleGrant.scope}`)
    }
  }
}
