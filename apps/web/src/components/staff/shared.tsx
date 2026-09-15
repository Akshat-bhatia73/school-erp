/** Labels and small tags for the staff screens, keyed by the contract enums. */
import type { z } from 'zod'
import { StaffEmploymentType, StaffStatus, StaffType } from '@erp/contracts'
import { Tag, type TagColor } from '@/components/shared/tag'

export type StaffStatusValue = z.infer<typeof StaffStatus>
export type StaffTypeValue = z.infer<typeof StaffType>
export type EmploymentTypeValue = z.infer<typeof StaffEmploymentType>

export const staffTypeLabel: Record<StaffTypeValue, string> = {
  teaching: 'Teaching',
  non_teaching: 'Non-teaching',
  admin: 'Admin',
  support: 'Support',
}

export const staffTypeColor: Record<StaffTypeValue, TagColor> = {
  teaching: 'blue',
  admin: 'purple',
  non_teaching: 'teal',
  support: 'grey',
}

export const statusLabel: Record<StaffStatusValue, string> = {
  active: 'Active',
  on_leave: 'On leave',
  resigned: 'Resigned',
  retired: 'Retired',
}

export const statusColor: Record<StaffStatusValue, TagColor> = {
  active: 'green',
  on_leave: 'orange',
  resigned: 'grey',
  retired: 'grey',
}

export const employmentLabel: Record<EmploymentTypeValue, string> = {
  permanent: 'Permanent',
  contract: 'Contract',
  part_time: 'Part time',
  probation: 'Probation',
}

export const staffTypeOptions = (Object.keys(staffTypeLabel) as StaffTypeValue[]).map((value) => ({ value, label: staffTypeLabel[value] }))
export const statusOptions = (Object.keys(statusLabel) as StaffStatusValue[]).map((value) => ({ value, label: statusLabel[value] }))
export const employmentOptions = (Object.keys(employmentLabel) as EmploymentTypeValue[]).map((value) => ({ value, label: employmentLabel[value] }))

/** "6 - A" from a grade + section pair. The grade is optional because some lists carry only a section. */
export function sectionLabel(gradeName: string | undefined, sectionName: string) {
  const grade = (gradeName ?? '').replace(/^Class\s*/i, '').trim()
  return grade ? `${grade} - ${sectionName}` : sectionName
}

export function StaffTypeTag({ type }: { type: StaffTypeValue }) {
  return <Tag color={staffTypeColor[type]}>{staffTypeLabel[type]}</Tag>
}

export function StaffStatusTag({ status }: { status: StaffStatusValue }) {
  return <Tag color={statusColor[status]} dot>{statusLabel[status]}</Tag>
}
