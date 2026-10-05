import { Link, useRouterState } from '@tanstack/react-router'
import { CalendarClock, ClipboardCheck, Ellipsis, GraduationCap, IndianRupee, LayoutDashboard, Mail, Menu, NotebookText, Search, Sparkles, Users } from 'lucide-react'
import type { ReactNode } from 'react'
import { UserAvatar } from '@/components/shared/avatar'
import { PUPIL_PATHS } from '@/components/layout/sidebar'
import { useSchoolDashboardView } from '@/lib/dashboard-view'
import type { PermissionKey } from '@/lib/permissions'
import { useSchoolContext, useSession } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { cn } from '@/lib/utils'

/**
 * Mobile header: drawer trigger, school identity, search, current user.
 * Same height and hairline as the desktop PageHeader so the two read as one product.
 */
export function MobileTopBar({ onOpenNav, onOpenQuickActions }: { onOpenNav: () => void; onOpenQuickActions: () => void }) {
  const { school, hasPermission } = useSchoolContext()
  const { user } = useSession()
  const name = user?.displayName ?? 'Account'
  const view = useSchoolDashboardView().view
  const isParent = view === 'parent'
  const isPupil = view === 'student'
  const { current } = useAcademicYear()
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-card px-2 md:hidden">
      <button type="button" onClick={onOpenNav} aria-label="Open navigation menu" className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Menu className="size-5" />
      </button>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-semibold leading-tight">{school.name}</span>
        {!isParent && !isPupil && (
          <span className="block truncate text-[11px] leading-tight text-muted-foreground">{current?.name ?? ''}{school.code ? ` · ${school.code}` : ''}</span>
        )}
      </div>
      {/* The tab island is full for most people, so the assistant sits up here, one tap away. */}
      {hasPermission('ai_assistant.use') && (
        <Link to="/assistant" aria-label="Assistant" className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [&.active]:bg-accent [&.active]:text-foreground">
          <Sparkles className="size-5" />
        </Link>
      )}
      <button type="button" onClick={onOpenQuickActions} aria-label="Search and quick actions" className="flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <Search className="size-5" />
      </button>
      <button type="button" onClick={onOpenNav} aria-label={`Signed in as ${name}. Open navigation menu`} className="flex size-10 shrink-0 items-center justify-center rounded-lg hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <UserAvatar name={name} size="md" />
      </button>
    </header>
  )
}

/** `permissions` means any one of them is enough; `permission` stays the single-key form. */
interface Tab { label: string; to: string; icon: ReactNode; permission?: PermissionKey; permissions?: PermissionKey[]; exact?: boolean; parentOnly?: boolean }

// Ordered by how often each audience opens it: when the bar is full, the tail moves behind More.
const TABS: Tab[] = [
  { label: 'Home', to: '/dashboard', icon: <LayoutDashboard />, exact: true },
  { label: 'Students', to: '/students', icon: <GraduationCap />, permission: 'students.read_basic' },
  // Families and pupils open homework every day, so it sits in their short bar; staff reach it from the drawer.
  { label: 'Homework', to: '/homework', icon: <NotebookText />, permission: 'homework.read', parentOnly: true },
  { label: 'Attendance', to: '/attendance', icon: <ClipboardCheck />, permissions: ['attendance.read', 'staff_attendance.read', 'leave_applications.read'] },
  { label: 'Fees', to: '/fees', icon: <IndianRupee />, permission: 'fees.read' },
  // Staff reach Messages from the drawer; a parent's or pupil's bar is short, so it sits here for them.
  { label: 'Messages', to: '/messages', icon: <Mail />, permission: 'communication.read', parentOnly: true },
  { label: 'Timetable', to: '/timetable', icon: <CalendarClock />, permission: 'timetable.read' },
  { label: 'Staff', to: '/staff', icon: <Users />, permission: 'staff.read_directory' },
]

/** Five slots fit a 320px phone with the label under the icon; a sixth would crush the labels. */
const MAX_SLOTS = 5

const tabClass = (active: boolean) => cn(
  'flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[10.5px] leading-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
  active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground',
)

/**
 * Floating tab island for the primary modules. Mirrors what a native shell would use,
 * so mobile web and a future app behave the same. Everything else lives in the drawer;
 * when more tabs are allowed than fit, the last slot is More, which opens it.
 * It floats over the content, so `AppShell` reserves room for it under the `md` breakpoint.
 */
export function MobileTabBar({ onOpenMore }: { onOpenMore?: () => void }) {
  const { hasPermission } = useSchoolContext()
  const view = useSchoolDashboardView().view
  const isParent = view === 'parent'
  const isPupil = view === 'student'
  const path = useRouterState({ select: (s) => s.location.pathname })
  const allowed = TABS.filter((t) => (!t.parentOnly || isParent || isPupil) && (!isPupil || PUPIL_PATHS.has(t.to)) && (!t.permission || hasPermission(t.permission)) && (!t.permissions || t.permissions.some((key) => hasPermission(key))))
    .map((t) => (t.to === '/dashboard' && isParent ? { ...t, label: 'My children' } : t))
  if (allowed.length === 0) return null
  const isActive = (t: Tab) => (t.exact ? path === t.to : path === t.to || path.startsWith(t.to + '/'))
  const overflow = Boolean(onOpenMore) && allowed.length > MAX_SLOTS
  const tabs = overflow ? allowed.slice(0, MAX_SLOTS - 1) : allowed
  const moreActive = overflow && allowed.slice(MAX_SLOTS - 1).some(isActive)
  return (
    <nav
      aria-label="Primary"
      className="pointer-events-none fixed inset-x-0 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-40 flex justify-center px-3 md:hidden"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-stretch gap-0.5 rounded-full border bg-card/95 p-1 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-8px_rgba(0,0,0,0.28)] backdrop-blur-md">
        {tabs.map((t) => {
          const active = isActive(t)
          return (
            <Link key={t.to} to={t.to} aria-current={active ? 'page' : undefined} className={tabClass(active)}>
              <span className="flex size-5 shrink-0 items-center justify-center [&>svg]:size-[18px]">{t.icon}</span>
              <span className="max-w-full truncate">{t.label}</span>
            </Link>
          )
        })}
        {overflow && (
          <button type="button" onClick={onOpenMore} aria-label="More: open navigation menu" className={tabClass(moreActive)}>
            <span className="flex size-5 shrink-0 items-center justify-center [&>svg]:size-[18px]"><Ellipsis /></span>
            <span className="max-w-full truncate">More</span>
          </button>
        )}
      </div>
    </nav>
  )
}
