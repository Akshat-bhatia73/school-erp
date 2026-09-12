import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Building2, CalendarDays, ChevronsUpDown, GraduationCap, LayoutDashboard, ListChecks, Moon, PanelLeft, School, ScrollText, Search, Settings2, ShieldCheck, Sun, Users, UserRound, BookOpen, Check, Sparkles } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { api } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { SectionLabel } from '@/components/shared/page'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import type { Module } from '@erp/shared'

interface NavItem { label: string; to: string; icon: ReactNode; count?: number | string; module?: Module; exact?: boolean }

function NavLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const path = useRouterState({ select: (s) => s.location.pathname })
  const active = item.exact ? path === item.to : path === item.to || path.startsWith(item.to + '/')
  return (
    <Link
      to={item.to}
      title={collapsed ? item.label : undefined}
      className={cn('group flex h-9 items-center gap-2.5 rounded-lg px-2 text-[13.5px] text-sidebar-foreground transition-colors hover:bg-sidebar-accent', active && 'bg-sidebar-accent font-medium', collapsed && 'justify-center px-0')}
    >
      <span className={cn('flex size-5 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-[17px]', active && 'text-foreground')}>{item.icon}</span>
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && item.count !== undefined && <span className="text-[12px] tabular-nums text-muted-foreground">{item.count}</span>}
    </Link>
  )
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { school, schools, setSchoolId, user, users, setUserId, roles, can } = useSession()
  const { theme, toggle } = useTheme()
  const { data: dash } = useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard.summary })
  const [cmdOpen, setCmdOpen] = useState(false)
  void cmdOpen; void setCmdOpen

  const primary: NavItem[] = [
    { label: 'Dashboard', to: '/dashboard', icon: <LayoutDashboard />, exact: true },
    { label: 'Students', to: '/students', icon: <GraduationCap />, count: dash?.students.active, module: 'students' },
    { label: 'Staff', to: '/staff', icon: <Users />, count: dash?.staff.total, module: 'staff' },
  ]
  const setup: NavItem[] = [
    { label: 'School profile', to: '/setup/school', icon: <School />, module: 'school_setup' },
    { label: 'Academic years', to: '/setup/academic-years', icon: <CalendarDays />, module: 'school_setup' },
    { label: 'Classes & sections', to: '/setup/classes', icon: <Building2 />, module: 'school_setup' },
    { label: 'Subjects', to: '/setup/subjects', icon: <BookOpen />, module: 'school_setup' },
    { label: 'Holidays', to: '/setup/holidays', icon: <ListChecks />, module: 'school_setup' },
  ]
  const settings: NavItem[] = [
    { label: 'Users & logins', to: '/settings/users', icon: <UserRound />, module: 'users_roles' },
    { label: 'Roles & permissions', to: '/settings/roles', icon: <ShieldCheck />, module: 'users_roles' },
    { label: 'Audit log', to: '/settings/audit-log', icon: <ScrollText />, module: 'audit_log' },
  ]
  const visible = (items: NavItem[]) => items.filter((i) => !i.module || can(i.module))

  return (
    <aside className={cn('flex h-full shrink-0 flex-col border-r bg-sidebar transition-[width] duration-200', collapsed ? 'w-14' : 'w-64')}>
      {/* School switcher */}
      <div className={cn('flex h-14 items-center gap-2 border-b px-3', collapsed && 'justify-center px-0')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn('flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left hover:bg-sidebar-accent', collapsed && 'flex-none px-0')}>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-4" /></span>
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-semibold leading-tight">{school.shortName}</span>
                    <span className="block truncate text-[11px] leading-tight text-muted-foreground">{dash?.academicYearName ?? ''} · {school.board.toUpperCase()}</span>
                  </span>
                  <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
                </>
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel className="text-[11.5px] font-medium tracking-wide text-muted-foreground">Schools on this platform</DropdownMenuLabel>
            {schools.map((s) => (
              <DropdownMenuItem key={s.id} onClick={() => setSchoolId(s.id)} className="gap-2">
                <span className="flex size-7 items-center justify-center rounded-md border bg-card text-[11px] font-semibold">{s.shortName.slice(0, 3)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.name}</span>
                  <span className="block text-[11.5px] text-muted-foreground">{s.address.city} · {s.status}</span>
                </span>
                {s.id === school.id && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {!collapsed && (
          <button type="button" onClick={onToggle} className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" title="Collapse sidebar"><PanelLeft className="size-4" /></button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-2 scrollbar-thin">
        {/* Quick actions */}
        <button type="button" className={cn('mt-3 flex h-9 items-center gap-2 rounded-lg border bg-card px-2.5 text-[13.5px] text-muted-foreground shadow-xs hover:bg-accent', collapsed && 'justify-center px-0')} title="Quick actions">
          <Search className="size-4" />
          {!collapsed && (<><span className="flex-1 text-left">Quick actions</span><span className="kbd">⌘K</span></>)}
        </button>

        <nav className="mt-3 flex flex-col gap-0.5">{visible(primary).map((i) => <NavLink key={i.to} item={i} collapsed={collapsed} />)}</nav>

        {visible(setup).length > 0 && (
          <>
            {!collapsed && <SectionLabel>School setup</SectionLabel>}
            {collapsed && <div className="my-2 border-t" />}
            <nav className="flex flex-col gap-0.5">{visible(setup).map((i) => <NavLink key={i.to} item={i} collapsed={collapsed} />)}</nav>
          </>
        )}
        {visible(settings).length > 0 && (
          <>
            {!collapsed && <SectionLabel>Settings</SectionLabel>}
            {collapsed && <div className="my-2 border-t" />}
            <nav className="flex flex-col gap-0.5">{visible(settings).map((i) => <NavLink key={i.to} item={i} collapsed={collapsed} />)}</nav>
          </>
        )}

        {!collapsed && (
          <>
            <SectionLabel>Coming next</SectionLabel>
            <div className="flex flex-col gap-0.5 opacity-60">
              {[['Attendance', 'Phase 2'], ['Fees', 'Phase 2'], ['Exams & marks', 'Phase 3'], ['Messages', 'Phase 2'], ['AI assistant', 'Phase 4']].map(([l, p]) => (
                <div key={l} className="flex h-8 items-center justify-between px-2 text-[13px] text-muted-foreground"><span>{l}</span><span className="text-[11px]">{p}</span></div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Viewing as */}
      <div className={cn('border-t p-2', collapsed && 'flex flex-col items-center gap-1')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={cn('flex w-full items-center gap-2 rounded-lg p-1.5 text-left hover:bg-sidebar-accent', collapsed && 'w-auto justify-center')}>
              <UserAvatar name={user.name} src={user.avatarUrl} size="md" />
              {!collapsed && (
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-tight">{user.name}</span>
                  <span className="block truncate text-[11.5px] leading-tight text-muted-foreground">Viewing as {roles.map((r) => r.name.split(' /')[0]).join(', ')}</span>
                </span>
              )}
              {!collapsed && <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-72">
            <DropdownMenuLabel className="text-[11.5px] font-medium tracking-wide text-muted-foreground">Switch user (auth is off in this build)</DropdownMenuLabel>
            <div className="max-h-72 overflow-y-auto">
              {groupUsers(users, roles.length ? [] : []).map((u) => (
                <DropdownMenuItem key={u.id} onClick={() => setUserId(u.id)} className="gap-2">
                  <UserAvatar name={u.name} src={u.avatarUrl} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{u.name}</span>
                    <span className="block text-[11.5px] text-muted-foreground">{u.roleLabel}</span>
                  </span>
                  {u.id === user.id && <Check className="size-4" />}
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={toggle} className="gap-2">{theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}{theme === 'dark' ? 'Light mode' : 'Dark mode'}</DropdownMenuItem>
            <DropdownMenuItem asChild><Link to="/settings/users" className="gap-2"><Settings2 className="size-4" />Manage users</Link></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {collapsed && (
          <button type="button" onClick={onToggle} className="rounded-md p-1.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" title="Expand sidebar"><PanelLeft className="size-4" /></button>
        )}
      </div>
    </aside>
  )
}

/** One representative user per role first, so the switcher is useful without scrolling through 40 teachers */
function groupUsers(users: ReturnType<typeof useSession>['users'], _unused: unknown[]) {
  const { roles } = getRolesIndex()
  const seen = new Set<string>()
  const out: Array<(typeof users)[number] & { roleLabel: string }> = []
  const withLabel = users.map((u) => ({ ...u, roleLabel: u.roleIds.map((id) => roles.get(id) ?? '').filter(Boolean).join(', ') }))
  for (const u of withLabel) { const k = u.roleLabel; if (!seen.has(k)) { seen.add(k); out.push(u) } }
  for (const u of withLabel) if (!out.includes(u)) out.push(u)
  return out.slice(0, 14)
}
import { getStore } from '@/api/store'
function getRolesIndex() {
  const roles = new Map(getStore().roles.map((r) => [r.id, r.name]))
  return { roles }
}
