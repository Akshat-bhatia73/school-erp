import type { Module, RoleKey, Scope, AuditAction, AuditEntity, UserStatus } from '@erp/shared'
import { PageTabs } from '@/components/shared/page'
import type { TagColor } from '@/components/shared/tag'

/** Tabs shared by the three settings screens */
export function SettingsTabs() {
  return (
    <PageTabs
      tabs={[
        { label: 'Users & logins', to: '/settings/users' },
        { label: 'Roles & permissions', to: '/settings/roles' },
        { label: 'Audit log', to: '/settings/audit-log' },
      ]}
    />
  )
}

export const roleColor: Record<RoleKey, TagColor> = {
  owner: 'red',
  admin: 'purple',
  accountant: 'orange',
  teacher: 'blue',
  parent: 'teal',
  student: 'grey',
  custom: 'indigo',
}

export const userStatusColor: Record<UserStatus, TagColor> = {
  active: 'green',
  invited: 'orange',
  disabled: 'grey',
}

export const auditActionColor: Record<AuditAction, TagColor> = {
  create: 'green',
  update: 'blue',
  delete: 'red',
  import: 'purple',
  promote: 'orange',
  login: 'grey',
  export: 'teal',
  send: 'cyan',
}

export const moduleLabels: Record<Module, { label: string; description: string }> = {
  school_setup: { label: 'School setup', description: 'School details, years, classes and subjects' },
  students: { label: 'Students', description: 'Student records and enrolment' },
  staff: { label: 'Staff', description: 'Teacher and staff records' },
  student_attendance: { label: 'Student attendance', description: 'Daily attendance for students' },
  staff_attendance: { label: 'Staff attendance', description: 'Attendance and leave for staff' },
  fee_structure: { label: 'Fee structure', description: 'Fee heads, plans and concessions' },
  fee_collection: { label: 'Fee collection', description: 'Receipts, dues and refunds' },
  fee_reports: { label: 'Fee reports', description: 'Collection and dues reporting' },
  exams: { label: 'Exams', description: 'Exam schedule and marks entry' },
  report_cards: { label: 'Report cards', description: 'Result sheets and report cards' },
  communication: { label: 'Communication', description: 'Messages and notices to parents' },
  ai_assistant: { label: 'AI assistant', description: 'Ask questions about school data' },
  users_roles: { label: 'Users & roles', description: 'Logins and what each role can do' },
  audit_log: { label: 'Audit log', description: 'Record of who changed what' },
}

export const scopeLabels: Record<Scope, string> = {
  all: 'Whole school',
  own_classes: 'Own classes',
  own_children: 'Own children',
  self: 'Self',
  none: 'None',
}

export const entityLabels: Record<AuditEntity, string> = {
  school: 'School',
  academic_year: 'Academic year',
  grade: 'Class',
  section: 'Section',
  subject: 'Subject',
  holiday: 'Holiday',
  student: 'Student',
  guardian: 'Guardian',
  enrollment: 'Enrolment',
  staff: 'Staff',
  user: 'User',
  role: 'Role',
  document: 'Document',
}
