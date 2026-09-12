import type { Staff, StaffStatus, StaffType, EmploymentType } from '@erp/shared'
import { Tag, type TagColor } from '@/components/shared/tag'
import { humanize } from '@/lib/utils'

export const staffTypeLabel: Record<StaffType, string> = {
  teaching: 'Teaching',
  non_teaching: 'Non-teaching',
  admin: 'Admin',
  support: 'Support',
}

export const staffTypeColor: Record<StaffType, TagColor> = {
  teaching: 'blue',
  admin: 'purple',
  non_teaching: 'teal',
  support: 'grey',
}

export const statusLabel: Record<StaffStatus, string> = {
  active: 'Active',
  on_leave: 'On leave',
  resigned: 'Resigned',
  retired: 'Retired',
}

export const statusColor: Record<StaffStatus, TagColor> = {
  active: 'green',
  on_leave: 'orange',
  resigned: 'grey',
  retired: 'grey',
}

export const employmentLabel: Record<EmploymentType, string> = {
  permanent: 'Permanent',
  contract: 'Contract',
  part_time: 'Part time',
  probation: 'Probation',
}

export const staffTypeOptions = (Object.keys(staffTypeLabel) as StaffType[]).map((value) => ({ value, label: staffTypeLabel[value] }))
export const statusOptions = (Object.keys(statusLabel) as StaffStatus[]).map((value) => ({ value, label: statusLabel[value] }))
export const employmentOptions = (Object.keys(employmentLabel) as EmploymentType[]).map((value) => ({ value, label: employmentLabel[value] }))

export function statusState(status: StaffStatus) {
  return status === 'active' ? 'done' : status === 'on_leave' ? 'partial' : 'empty'
}

/** "6 - A" from a grade + section pair */
export function sectionLabel(gradeName: string | undefined, sectionName: string) {
  const grade = (gradeName ?? '').replace(/^Class\s*/i, '').trim()
  return grade ? `${grade} - ${sectionName}` : sectionName
}

export function StaffTypeTag({ type }: { type: StaffType }) {
  return <Tag color={staffTypeColor[type]}>{staffTypeLabel[type]}</Tag>
}

export function StaffStatusTag({ status }: { status: Staff['status'] }) {
  return <Tag color={statusColor[status]} dot>{statusLabel[status] ?? humanize(status)}</Tag>
}

/** Salary and bank details are only for the owner and the accountant */
export function canSeePay(roles: Array<{ key: string }>) {
  return roles.some((r) => r.key === 'owner' || r.key === 'accountant')
}
