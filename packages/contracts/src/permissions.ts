import { z } from 'zod'

export const AccessScope = z.enum([
  'school',
  'self',
  'assigned_sections',
  'assigned_subjects',
  'own_children',
  'own_record',
  'finance',
])
export type AccessScope = z.infer<typeof AccessScope>

const permissionKeys = [
  'school.read', 'school.update',
  'academic_years.read', 'academic_years.manage',
  'grades.read', 'grades.manage',
  'sections.read', 'sections.read_strengths', 'sections.manage',
  'subjects.read', 'subjects.manage',
  'holidays.read', 'holidays.manage',
  'students.read_basic', 'students.read_sensitive', 'students.read_medical',
  'students.read_guardian_contact', 'students.read_guardians', 'students.read_siblings',
  'students.read_documents', 'students.download_documents', 'students.read_enrollments',
  'students.create', 'students.update_basic', 'students.update_sensitive',
  'students.manage_enrollment', 'students.manage_guardians', 'students.import',
  'students.export', 'students.promote',
  'students.read_consents', 'students.manage_consents', 'students.anonymise',
  'students.export_subject',
  'staff.read_directory', 'staff.read_employment', 'staff.read_private', 'staff.read_pay',
  'staff.create', 'staff.update_employment', 'staff.update_private', 'staff.update_pay',
  'staff.manage_assignments', 'staff.export', 'staff.anonymise',
  'members.read', 'members.invite', 'members.update', 'members.suspend',
  'members.remove', 'members.restore', 'members.manage_credentials',
  'roles.read', 'roles.assign', 'roles.manage', 'access.explain', 'access.manage', 'ownership.transfer',
  'audit.read', 'audit.export', 'audit.redact_notes',
  'timetable.read', 'timetable.manage_periods', 'timetable.manage_entries',
  'timetable.generate', 'timetable.read_conflicts', 'timetable.read_teacher_loads',
  'timetable.manage_substitutions', 'timetable.notify_substitutions',
  'dashboard.read',
  'fees.read', 'fees.collect', 'fees.manage', 'fees.export',
  'attendance.read', 'attendance.record', 'attendance.manage', 'attendance.export',
  'exams.read', 'exams.record_marks', 'exams.manage', 'exams.publish', 'exams.export',
  'communication.read', 'communication.send', 'communication.manage', 'communication.export',
  'report_cards.read', 'report_cards.manage', 'report_cards.publish', 'report_cards.export',
  'staff_attendance.read', 'staff_attendance.record', 'staff_attendance.manage', 'staff_attendance.export',
  'ai_assistant.use', 'ai_assistant.manage',
] as const

export const PermissionKey = z.enum(permissionKeys)
export type PermissionKey = z.infer<typeof PermissionKey>

export const ResourceType = z.enum([
  'school', 'academic_year', 'grade', 'section', 'subject', 'holiday',
  'student', 'guardian', 'student_document', 'enrollment', 'staff',
  'teaching_assignment', 'membership', 'invitation', 'role', 'role_assignment',
  'access_decision', 'access_exception', 'school_ownership', 'audit_event',
  'timetable', 'bell_schedule', 'substitution', 'dashboard', 'fee', 'attendance',
  'exam', 'communication', 'report_card', 'staff_attendance', 'ai_assistant',
])
export type ResourceType = z.infer<typeof ResourceType>

export type PermissionAvailability = 'active' | 'reserved'

export interface PermissionMetadata {
  resourceType: ResourceType
  scopes: readonly AccessScope[]
  availability: PermissionAvailability
  description: string
  privileged: boolean
  privilegedScopes: readonly AccessScope[]
}

const active = (
  resourceType: ResourceType,
  scopes: readonly AccessScope[],
  description: string,
  privileged = false,
  privilegedScopes: readonly AccessScope[] = privileged ? scopes : [],
): PermissionMetadata => ({ resourceType, scopes, availability: 'active', description, privileged, privilegedScopes })

const reserved = (
  resourceType: ResourceType,
  scopes: readonly AccessScope[],
  description: string,
  privileged = false,
  privilegedScopes: readonly AccessScope[] = privileged ? scopes : [],
): PermissionMetadata => ({ resourceType, scopes, availability: 'reserved', description, privileged, privilegedScopes })

export const PERMISSION_CATALOGUE = {
  'school.read': active('school', ['school'], 'Read the selected school profile.'),
  'school.update': active('school', ['school'], 'Update the selected school profile.', true),
  'academic_years.read': active('academic_year', ['school'], 'Read academic years.'),
  'academic_years.manage': active('academic_year', ['school'], 'Create, update, open, or close academic years.', true),
  'grades.read': active('grade', ['school', 'assigned_sections', 'own_children'], 'Read class definitions relevant to the granted scope.'),
  'grades.manage': active('grade', ['school'], 'Create, update, or remove classes.', true),
  'sections.read': active('section', ['school', 'assigned_sections', 'own_children'], 'Read section definitions relevant to the granted scope.'),
  'sections.read_strengths': active('section', ['school', 'assigned_sections'], 'Read authorized section student counts.'),
  'sections.manage': active('section', ['school'], 'Create, update, or remove sections.', true),
  'subjects.read': active('subject', ['school', 'assigned_subjects', 'own_children'], 'Read subjects relevant to the granted scope.'),
  'subjects.manage': active('subject', ['school'], 'Create, update, remove, or map subjects to classes.', true),
  'holidays.read': active('holiday', ['school'], 'Read the school calendar.'),
  'holidays.manage': active('holiday', ['school'], 'Create, update, or remove holidays.', true),
  'students.read_basic': active('student', ['school', 'assigned_sections', 'own_children', 'own_record', 'finance'], 'Read the safe basic student record and authorized roster/search results.'),
  'students.read_sensitive': active('student', ['school', 'own_children', 'own_record'], 'Read restricted demographic and administrative student fields.', true),
  'students.read_medical': active('student', ['school', 'own_children', 'own_record'], 'Read medical notes and health fields.', true),
  'students.read_guardian_contact': active('student', ['school', 'assigned_sections', 'own_children', 'own_record', 'finance'], 'Read the minimal guardian name, relationship, and approved contact fields.'),
  'students.read_guardians': active('guardian', ['school', 'own_children', 'own_record'], 'Read full authorized guardian records and relationships.', true),
  'students.read_siblings': active('student', ['school', 'own_children', 'own_record'], 'Read authorized sibling links without widening child access.'),
  'students.read_documents': active('student_document', ['school', 'own_children', 'own_record'], 'Read safe document metadata.', true),
  'students.download_documents': active('student_document', ['school', 'own_children', 'own_record'], 'Download a private student document after a fresh authorization check.', true),
  'students.read_enrollments': active('enrollment', ['school', 'assigned_sections', 'own_children', 'own_record'], 'Read authorized current and historical enrollment summaries.'),
  'students.create': active('student', ['school'], 'Admit a student and create the initial enrollment and guardian links.', true),
  'students.update_basic': active('student', ['school'], 'Update allowlisted basic student fields.', true),
  'students.update_sensitive': active('student', ['school'], 'Update restricted student fields; medical writes additionally require students.read_medical.', true),
  'students.manage_enrollment': active('enrollment', ['school'], 'Move a student or mark an enrollment as ended.', true),
  'students.manage_guardians': active('guardian', ['school'], 'Create or update guardian records and student links.', true),
  'students.import': active('student', ['school'], 'Validate and commit a bulk student import.', true),
  'students.export': active('student', ['school', 'assigned_sections'], 'Export only the authorized student dataset and fields.', true),
  'students.promote': active('enrollment', ['school'], 'Promote or detain a validated student cohort.', true),
  'students.read_consents': active('student', ['school', 'own_children'], 'Read the guardian consent record of an authorized student.'),
  // Only the office answer is privileged: a parent answering for their own child
  // signs in with a phone code and has no second factor to be asked for.
  'students.manage_consents': active('student', ['school', 'own_children'], 'Record or withdraw a guardian consent for an authorized student.', true, ['school']),
  'students.anonymise': active('student', ['school'], 'Anonymise a student who has left, after the retention period.', true),
  // A parent asking for their own child's record is answering a subject access
  // request about themselves, so the office answer is the only privileged one.
  'students.export_subject': active('student', ['school', 'own_children'], 'Export everything the system holds about one authorized student.', true, ['school']),
  'staff.read_directory': active('staff', ['school', 'self', 'assigned_sections', 'own_children'], 'Read a minimal staff directory or timetable attribution.'),
  'staff.read_employment': active('staff', ['school', 'self'], 'Read authorized employment fields, excluding private and pay data.'),
  'staff.read_private': active('staff', ['school', 'self', 'finance'], 'Read private staff contact, identity, or bank fields.', true, ['school', 'finance']),
  'staff.read_pay': active('staff', ['school', 'finance'], 'Read salary and compensation fields.', true),
  'staff.create': active('staff', ['school'], 'Create a staff employment record without creating login access.', true),
  'staff.update_employment': active('staff', ['school'], 'Update allowlisted employment fields.', true),
  'staff.update_private': active('staff', ['school', 'self'], 'Update employment contact fields, never verified login identifiers.', true, ['school']),
  'staff.update_pay': active('staff', ['school', 'finance'], 'Update salary and compensation fields.', true),
  'staff.manage_assignments': active('teaching_assignment', ['school'], 'Assign teachers to sections and subjects.', true),
  'staff.export': active('staff', ['school', 'finance'], 'Export authorized staff fields.', true),
  'staff.anonymise': active('staff', ['school'], 'Anonymise a staff member who has left, after the retention period.', true),
  'members.read': active('membership', ['school'], 'Read the safe school membership directory.', true),
  'members.invite': active('invitation', ['school'], 'Invite a person using only a separately grantable fixed role.', true),
  'members.update': reserved('membership', ['school'], 'Reserved until a specific membership-update workflow is commissioned.', true),
  'members.suspend': active('membership', ['school'], 'Suspend a school membership.', true),
  'members.remove': active('membership', ['school'], 'End a school membership.', true),
  'members.restore': active('membership', ['school'], 'Restore a reviewed school membership.', true),
  'members.manage_credentials': active('membership', ['school'], 'Start restricted credential recovery for another membership.', true),
  'roles.read': active('role', ['school'], 'Read fixed roles and effective grant summaries.', true),
  'roles.assign': active('role_assignment', ['school'], 'Assign only roles allowed by the separate delegation policy.', true),
  'roles.manage': reserved('role', ['school'], 'Reserved for a future custom role editor; fixed templates remain immutable.', true),
  'access.explain': active('access_decision', ['school'], 'Read a restricted explanation of a membership’s effective access.', true),
  'access.manage': reserved('access_exception', ['school'], 'Reserved for a future resource-exception editor.', true),
  'ownership.transfer': active('school_ownership', ['school'], 'Transfer school ownership through the protected fresh-MFA workflow.', true),
  'audit.read': active('audit_event', ['school', 'finance'], 'Read authorized, redacted audit events.', true),
  'audit.export': active('audit_event', ['school', 'finance'], 'Export authorized, redacted audit events.', true),
  'audit.redact_notes': active('audit_event', ['school'], 'Redact the free-text note attached to an audit event.', true),
  'timetable.read': active('timetable', ['school', 'self', 'assigned_sections', 'assigned_subjects', 'own_children', 'own_record'], 'Read timetable entries relevant to the granted relationship.'),
  'timetable.manage_periods': active('bell_schedule', ['school'], 'Create or update bell schedules.', true),
  'timetable.manage_entries': active('timetable', ['school'], 'Set or clear timetable entries.', true),
  'timetable.generate': active('timetable', ['school'], 'Generate a timetable proposal for a section.', true),
  'timetable.read_conflicts': active('timetable', ['school'], 'Read timetable conflict details.', true),
  'timetable.read_teacher_loads': active('teaching_assignment', ['school'], 'Read school-wide teacher workload aggregates.', true),
  'timetable.manage_substitutions': active('substitution', ['school'], 'Create or remove teacher substitutions.', true),
  'timetable.notify_substitutions': active('substitution', ['school'], 'Mark substitution notices as sent.', true),
  'dashboard.read': active('dashboard', ['school', 'self', 'assigned_sections', 'own_children', 'finance'], 'Read a safe dashboard variant computed from the authorized dataset.'),
  // A parent reading their own child's statement signs in with a phone code, so
  // the read is not privileged; every fee write and every fee file is.
  'fees.read': active('fee', ['school', 'own_children', 'finance'], 'Read fee heads, structures, statements, receipts and the dues list within the granted scope.'),
  'fees.collect': active('fee', ['school', 'finance'], 'Record a fee payment and issue its receipt.', true),
  'fees.manage': active('fee', ['school', 'finance'], 'Set fee heads and structures, concessions and optional fees, and record refunds, cancellations and adjustments.', true),
  'fees.export': active('fee', ['school', 'finance'], 'Export the dues list and the collection register.', true),
  'attendance.read': reserved('attendance', ['school', 'assigned_sections', 'own_children', 'own_record'], 'Reserved for attendance views.'),
  'attendance.record': reserved('attendance', ['school', 'assigned_sections'], 'Reserved for recording attendance.', true),
  'attendance.manage': reserved('attendance', ['school'], 'Reserved for correcting and administering attendance.', true),
  'attendance.export': reserved('attendance', ['school', 'assigned_sections'], 'Reserved for exporting authorized attendance data.', true),
  'exams.read': reserved('exam', ['school', 'assigned_sections', 'assigned_subjects', 'own_children', 'own_record'], 'Reserved for published exam and result views.'),
  'exams.record_marks': reserved('exam', ['school', 'assigned_sections', 'assigned_subjects'], 'Reserved for recording marks for an assigned section and subject.', true),
  'exams.manage': reserved('exam', ['school'], 'Reserved for exam setup and administration.', true),
  'exams.publish': reserved('exam', ['school'], 'Reserved for publishing results.', true),
  'exams.export': reserved('exam', ['school', 'assigned_sections', 'assigned_subjects'], 'Reserved for exporting authorized exam data.', true),
  'communication.read': reserved('communication', ['school', 'assigned_sections', 'own_children', 'own_record'], 'Reserved for reading authorized school messages.'),
  'communication.send': reserved('communication', ['school', 'assigned_sections'], 'Reserved for sending messages to an authorized audience.', true),
  'communication.manage': reserved('communication', ['school'], 'Reserved for communication templates and administration.', true),
  'communication.export': reserved('communication', ['school'], 'Reserved for exporting authorized communication records.', true),
  'report_cards.read': reserved('report_card', ['school', 'assigned_sections', 'assigned_subjects', 'own_children', 'own_record'], 'Reserved for reading authorized published report cards.'),
  'report_cards.manage': reserved('report_card', ['school', 'assigned_sections', 'assigned_subjects'], 'Reserved for preparing report cards.', true),
  'report_cards.publish': reserved('report_card', ['school'], 'Reserved for publishing report cards.', true),
  'report_cards.export': reserved('report_card', ['school', 'assigned_sections', 'assigned_subjects', 'own_children'], 'Reserved for exporting authorized report cards.', true),
  'staff_attendance.read': reserved('staff_attendance', ['school', 'self'], 'Reserved for reading staff attendance.'),
  'staff_attendance.record': reserved('staff_attendance', ['school'], 'Reserved for recording staff attendance.', true),
  'staff_attendance.manage': reserved('staff_attendance', ['school'], 'Reserved for correcting and administering staff attendance.', true),
  'staff_attendance.export': reserved('staff_attendance', ['school'], 'Reserved for exporting authorized staff attendance.', true),
  'ai_assistant.use': reserved('ai_assistant', ['school', 'self', 'assigned_sections', 'assigned_subjects', 'own_children', 'finance'], 'Reserved for an assistant that remains bounded by the caller’s permissions.'),
  'ai_assistant.manage': reserved('ai_assistant', ['school'], 'Reserved for school assistant configuration.', true),
} as const satisfies Record<PermissionKey, PermissionMetadata>

export const ACTIVE_PERMISSION_KEYS = PermissionKey.options.filter(
  (permission) => PERMISSION_CATALOGUE[permission].availability === 'active',
)

export const RESERVED_PERMISSION_KEYS = PermissionKey.options.filter(
  (permission) => PERMISSION_CATALOGUE[permission].availability === 'reserved',
)
