import { Link } from '@tanstack/react-router'
import { ArrowUpRight, FileSpreadsheet, UserPlus, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { useSession } from '@/lib/session'

interface Action { label: string; to: string; icon: ReactNode; show: boolean }

/** Row of dashed-border shortcut buttons, filtered by what the role can do. */
export function QuickActions() {
  const { can } = useSession()
  const students = can('students', 'create')
  const staff = can('staff', 'create')
  const actions: Action[] = [
    { label: 'Admit student', to: '/students/new', icon: <UserPlus />, show: students },
    { label: 'Import from Excel', to: '/students/import', icon: <FileSpreadsheet />, show: students },
    { label: 'Add staff', to: '/staff/new', icon: <Users />, show: staff },
    { label: 'Promote students', to: '/students/promote', icon: <ArrowUpRight />, show: students },
  ].filter((a) => a.show)

  if (actions.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-2">
      {actions.map((a) => (
        <Link key={a.to} to={a.to} className="inline-flex h-9 items-center gap-2 rounded-lg border border-dashed bg-card px-3 text-[13.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&>svg]:size-4">
          {a.icon}{a.label}
        </Link>
      ))}
    </div>
  )
}
