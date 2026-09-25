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
  grant('students.manage_login', 'school'),
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

/** Everything about fees: set them, collect them, read them and export them. */
const feesFull = (scope: 'school' | 'finance'): readonly RoleGrant[] => [
  grant('fees.read', scope), grant('fees.collect', scope),
  grant('fees.manage', scope), grant('fees.export', scope),
]

/**
 * Everything about attendance for the office: read, mark and correct the
 * pupil registers and export them, and the same for the staff register.
 */
/**
 * Everything about exams and report cards for the office: set the exams up,
 * enter and correct marks, publish results and cards, and export them.
 */
const examsOffice: readonly RoleGrant[] = [
  grant('exams.read', 'school'), grant('exams.record_marks', 'school'),
  grant('exams.manage', 'school'), grant('exams.publish', 'school'),
  grant('exams.export', 'school'),
  grant('report_cards.read', 'school'), grant('report_cards.manage', 'school'),
  grant('report_cards.publish', 'school'), grant('report_cards.export', 'school'),
]

/** Messages for the office: send to anyone in the school, set the automatic messages, export the record. */
const communicationOffice: readonly RoleGrant[] = [
  grant('communication.read', 'school'), grant('communication.send', 'school'),
  grant('communication.manage', 'school'), grant('communication.export', 'school'),
]

const attendanceOffice: readonly RoleGrant[] = [
  grant('attendance.read', 'school'), grant('attendance.record', 'school'),
  grant('attendance.manage', 'school'), grant('attendance.export', 'school'),
  grant('staff_attendance.read', 'school'), grant('staff_attendance.record', 'school'),
  grant('staff_attendance.manage', 'school'), grant('staff_attendance.export', 'school'),
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
      grant('access.manage', 'school'),
      grant('ownership.transfer', 'school'), grant('audit.read', 'school'),
      grant('audit.export', 'school'),
      grant('students.read_consents', 'school'), grant('students.manage_consents', 'school'),
      grant('students.anonymise', 'school'), grant('staff.anonymise', 'school'),
      grant('students.export_subject', 'school'), grant('audit.redact_notes', 'school'),
      ...feesFull('school'),
      ...attendanceOffice,
      ...examsOffice,
      ...communicationOffice,
      grant('ai_assistant.use', 'self'), grant('ai_assistant.manage', 'school'),
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
      grant('roles.assign', 'school'), grant('access.manage', 'school'),
      grant('audit.read', 'school'),
      grant('students.read_consents', 'school'), grant('students.manage_consents', 'school'),
      grant('students.anonymise', 'school'), grant('staff.anonymise', 'school'),
      grant('students.export_subject', 'school'),
      ...feesFull('school'),
      ...attendanceOffice,
      ...examsOffice,
      ...communicationOffice,
      grant('ai_assistant.use', 'self'), grant('ai_assistant.manage', 'school'),
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
      grant('students.read_consents', 'school'), grant('students.manage_consents', 'school'),
      // The office counter takes money; it does not set fees or refund them.
      grant('fees.read', 'school'), grant('fees.collect', 'school'),
      ...attendanceOffice,
      ...examsOffice,
      ...communicationOffice,
      grant('ai_assistant.use', 'self'),
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
      ...feesFull('finance'),
      // The staff register is payroll input; the accountant reads it and
      // holds nothing about pupil attendance.
      grant('staff_attendance.read', 'school'),
      // Their own inbox: staff notices and the school's birthday wishes.
      grant('communication.read', 'self'),
      grant('ai_assistant.use', 'self'),
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
      // A class teacher marks and reads their own sections; every staff member
      // reads their own month of the staff register.
      grant('attendance.read', 'assigned_sections'), grant('attendance.record', 'assigned_sections'),
      grant('staff_attendance.read', 'self'),
      // A subject teacher reads, enters and exports the marks of their own
      // subject in their own section (assigned_subjects). A class teacher
      // reads every subject of their own class, and prepares, reads and
      // prints its report cards (assigned_sections, which for exams and
      // report cards is the class-teacher post alone).
      grant('exams.read', 'assigned_subjects'), grant('exams.read', 'assigned_sections'),
      grant('exams.record_marks', 'assigned_subjects'),
      grant('exams.export', 'assigned_subjects'), grant('exams.export', 'assigned_sections'),
      grant('report_cards.read', 'assigned_sections'), grant('report_cards.manage', 'assigned_sections'),
      grant('report_cards.export', 'assigned_sections'),
      // Class teachers and subject teachers both write to the families of
      // their own sections, and read what the school sent there; everybody
      // reads their own inbox and what they wrote.
      grant('communication.read', 'self'), grant('communication.read', 'assigned_sections'),
      grant('communication.send', 'assigned_sections'),
      grant('ai_assistant.use', 'self'),
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
      grant('students.read_consents', 'own_children'),
      grant('students.manage_consents', 'own_children'),
      grant('students.export_subject', 'own_children'),
      grant('fees.read', 'own_children'),
      grant('attendance.read', 'own_children'),
      // Published results and report cards only: the scope term matches a
      // published row and nothing else.
      grant('exams.read', 'own_children'), grant('report_cards.read', 'own_children'),
      grant('report_cards.export', 'own_children'),
      // What the school addressed to this parent, and nothing addressed to
      // another guardian of the same child.
      grant('communication.read', 'self'),
      grant('ai_assistant.use', 'self'),
    ],
  },
  // A pupil in Class 9 to 12 reads their own published learning record and
  // nothing financial or administrative: no fees, no guardians, no consents,
  // no documents, no exports. Results and report cards answer published rows
  // only, exactly as for a parent. The calendar is the school's own.
  student: {
    displayName: 'Student', enabled: true, requiredMfa: false,
    grants: [
      grant('grades.read', 'own_record'), grant('sections.read', 'own_record'),
      grant('subjects.read', 'own_record'), grant('holidays.read', 'school'),
      grant('students.read_basic', 'own_record'),
      grant('students.read_enrollments', 'own_record'),
      grant('timetable.read', 'own_record'),
      grant('dashboard.read', 'own_record'),
      grant('attendance.read', 'own_record'),
      grant('exams.read', 'own_record'), grant('report_cards.read', 'own_record'),
      // Notices addressed to the pupil themself, and nothing written to their family.
      grant('communication.read', 'self'),
      // Only after a guardian gives the ai_assistant consent; the API checks it.
      grant('ai_assistant.use', 'self'),
    ],
  },
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
/**
 * Whom a member restriction may be put on (September 2026). Wider than the
 * lifecycle rules above because a restriction can only take access away: a
 * principal may restrict an administrator or accountant they could not
 * suspend. Nobody restricts an owner, and only an owner restricts a principal.
 * A parent or pupil role on the target is ignored; the control is for staff.
 */
export const ROLE_RESTRICTION_RULES = {
  owner: { restrictableTargetRoles: ['principal', 'admin', 'accountant', 'teacher'] },
  principal: { restrictableTargetRoles: ['admin', 'accountant', 'teacher'] },
  admin: { restrictableTargetRoles: [] },
  accountant: { restrictableTargetRoles: [] },
  teacher: { restrictableTargetRoles: [] },
  parent: { restrictableTargetRoles: [] },
  student: { restrictableTargetRoles: [] },
} as const satisfies Record<RoleKey, { readonly restrictableTargetRoles: readonly RoleKey[] }>

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
