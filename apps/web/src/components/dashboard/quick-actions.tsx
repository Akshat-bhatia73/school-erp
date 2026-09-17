import { Link } from '@tanstack/react-router'
import { ArrowUpRight, FileSpreadsheet, MailPlus, UserPlus, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PermissionKey } from '@/lib/permissions'
import { useSchoolContext } from '@/lib/session'

interface Action { label: string; to: string; icon: ReactNode; permission: PermissionKey }

const ACTIONS: Action[] = [
  { label: 'Admit student', to: '/students/new', icon: <UserPlus />, permission: 'students.create' },
  { label: 'Import from Excel', to: '/students/import', icon: <FileSpreadsheet />, permission: 'students.import' },
  { label: 'Promote students', to: '/students/promote', icon: <ArrowUpRight />, permission: 'students.promote' },
  { label: 'Add staff', to: '/staff/new', icon: <Users />, permission: 'staff.create' },
  { label: 'Invite user', to: '/settings/users', icon: <MailPlus />, permission: 'members.invite' },
]

/** Row of dashed-border shortcuts. An action the person cannot take is not rendered. */
export function QuickActions() {
  const { hasPermission } = useSchoolContext()
  const actions = ACTIONS.filter((a) => hasPermission(a.permission))
  if (actions.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((a) => (
        <Link key={a.label} to={a.to} className="inline-flex h-9 items-center gap-2 rounded-lg border border-dashed bg-card px-3 text-[13.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&>svg]:size-4">
          {a.icon}{a.label}
        </Link>
      ))}
    </div>
  )
}
