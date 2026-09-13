import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CalendarClock, GraduationCap, LayoutDashboard, Menu, Search, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { api } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import type { Module } from '@erp/shared'

/**
 * Mobile header: drawer trigger, school identity, search, current user.
 * Same height and hairline as the desktop PageHeader so the two read as one product.
 */
export function MobileTopBar({ onOpenNav, onOpenQuickActions }: { onOpenNav: () => void; onOpenQuickActions: () => void }) {
  const { school, user } = useSession()
  const { data: dash } = useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard.summary })
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-2 md:hidden">
      <button type="button" onClick={onOpenNav} aria-label="Open navigation menu" className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Menu className="size-5" />
      </button>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold leading-tight">{school.shortName}</span>
        <span className="block truncate text-[11px] leading-tight text-muted-foreground">{dash?.academicYearName ?? ''} · {school.board.toUpperCase()}</span>
      </div>
      <button type="button" onClick={onOpenQuickActions} aria-label="Search and quick actions" className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Search className="size-5" />
      </button>
      <button type="button" onClick={onOpenNav} aria-label={`Viewing as ${user.name}. Open navigation menu`} className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <UserAvatar name={user.name} src={user.avatarUrl} size="md" />
      </button>
    </header>
  )
}

interface Tab { label: string; to: string; icon: ReactNode; module?: Module; exact?: boolean }

const TABS: Tab[] = [
  { label: 'Home', to: '/dashboard', icon: <LayoutDashboard />, exact: true },
  { label: 'Students', to: '/students', icon: <GraduationCap />, module: 'students' },
  { label: 'Staff', to: '/staff', icon: <Users />, module: 'staff' },
  { label: 'Timetable', to: '/timetable', icon: <CalendarClock />, module: 'timetable' },
]

/**
 * Floating tab island for the four primary modules. Mirrors what a native shell would use,
 * so mobile web and a future app behave the same. Everything else lives in the drawer.
 * It floats over the content, so `AppShell` reserves room for it under the `md` breakpoint.
 */
export function MobileTabBar() {
  const { can } = useSession()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const tabs = TABS.filter((t) => !t.module || can(t.module))
  if (tabs.length === 0) return null
  return (
    <nav
      aria-label="Primary"
      className="pointer-events-none fixed inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex justify-center px-3 md:hidden"
    >
      <div className="pointer-events-auto flex w-full items-stretch gap-0.5 rounded-full border bg-card/95 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-8px_rgba(0,0,0,0.28)] backdrop-blur-md">
        {tabs.map((t) => {
          const active = t.exact ? path === t.to : path === t.to || path.startsWith(t.to + '/')
          return (
            <Link
              key={t.to}
              to={t.to}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full px-2 text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center [&>svg]:size-[18px]">{t.icon}</span>
              <span className="truncate">{t.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
