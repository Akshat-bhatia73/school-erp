import type { ReactNode } from 'react'
import type { MembershipStatus, RoleKey } from '@erp/contracts'
import { PageTabs } from '@/components/shared/page'
import type { TagColor } from '@/components/shared/tag'

/** Tabs shared by the three settings screens. */
export function SettingsTabs({ actions }: { actions?: ReactNode }) {
  return (
    <PageTabs
      actions={actions}
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
  principal: 'indigo',
  admin: 'purple',
  accountant: 'orange',
  teacher: 'blue',
  parent: 'teal',
  student: 'grey',
}

export const memberStatusColor: Record<MembershipStatus, TagColor> = {
  active: 'green',
  suspended: 'orange',
  removed: 'grey',
}

export const memberStatusLabel: Record<MembershipStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  removed: 'Removed',
}

/** 'members.invite' -> 'Members', for grouping permissions by what they are about. */
export function resourceGroupLabel(key: string): string {
  const resource = key.split('.')[0] ?? key
  const words = resource.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}
