import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { BookOpen, Building2, CalendarDays, GraduationCap, LayoutDashboard, ListChecks, LogOut, Moon, ScrollText, School, ShieldCheck, Sun, UserPlus, UserRound, Users, ArrowUpRight, Upload, MailPlus, CalendarClock } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { api } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { Tag, colorFor } from '@/components/shared/tag'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { useTheme } from '@/lib/theme'
import { fullName } from '@/lib/utils'
import type { Module } from '@erp/shared'

interface Entry { label: string; icon: ReactNode; to: string; module?: Module; action?: 'edit' | 'create' }

const goTo: Entry[] = [
  { label: 'Dashboard', icon: <LayoutDashboard />, to: '/dashboard' },
  { label: 'Students', icon: <GraduationCap />, to: '/students', module: 'students' },
  { label: 'Staff', icon: <Users />, to: '/staff', module: 'staff' },
  { label: 'Timetable', icon: <CalendarClock />, to: '/timetable', module: 'timetable' },
  { label: 'School profile', icon: <School />, to: '/setup/school', module: 'school_setup' },
  { label: 'Academic years', icon: <CalendarDays />, to: '/setup/academic-years', module: 'school_setup' },
  { label: 'Classes & sections', icon: <Building2 />, to: '/setup/classes', module: 'school_setup' },
  { label: 'Subjects', icon: <BookOpen />, to: '/setup/subjects', module: 'school_setup' },
  { label: 'Holidays', icon: <ListChecks />, to: '/setup/holidays', module: 'school_setup' },
  { label: 'Users & logins', icon: <UserRound />, to: '/settings/users', module: 'users_roles' },
  { label: 'Roles & permissions', icon: <ShieldCheck />, to: '/settings/roles', module: 'users_roles' },
  { label: 'Audit log', icon: <ScrollText />, to: '/settings/audit-log', module: 'audit_log' },
]

const actions: Entry[] = [
  { label: 'Admit student', icon: <UserPlus />, to: '/students/new', module: 'students', action: 'create' },
  { label: 'Import students from Excel', icon: <Upload />, to: '/students/import', module: 'students', action: 'create' },
  { label: 'Promote students', icon: <ArrowUpRight />, to: '/students/promote', module: 'students', action: 'edit' },
  { label: 'Add staff', icon: <UserPlus />, to: '/staff/new', module: 'staff', action: 'create' },
  { label: 'Invite user', icon: <MailPlus />, to: '/settings/users', module: 'users_roles', action: 'create' },
]

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  const { can, activeMemberships, signOut } = useSession()
  const { theme, toggle } = useTheme()
  const [query, setQuery] = useState('')

  useEffect(() => { if (!open) setQuery('') }, [open])

  const search = query.trim()
  const searching = search.length >= 2
  const { data: students, isFetching: studentsFetching } = useQuery({
    queryKey: qk.students({ palette: search }),
    queryFn: () => api.students.list({ search, pageSize: 6, status: 'all' }),
    enabled: open && searching,
  })
  const { data: staff, isFetching: staffFetching } = useQuery({
    queryKey: qk.staff({ palette: search }),
    queryFn: () => api.staff.list({ search, pageSize: 5, status: 'all' }),
    enabled: open && searching,
  })

  const run = (fn: () => void) => { onOpenChange(false); fn() }
  const go = (to: string) => run(() => { void navigate({ to }) })

  const visibleGoTo = goTo.filter((e) => !e.module || can(e.module))
  const visibleActions = actions.filter((e) => !e.module || can(e.module, e.action ?? 'create'))

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Quick actions"
      description="Jump to a screen, start an action, or search people"
      className="top-[18%] translate-y-0 gap-0 rounded-xl p-0 sm:max-w-[560px]"
      showCloseButton={false}
    >
      <CommandInput placeholder="Search screens, actions, students, staff…" value={query} onValueChange={setQuery} />
      <CommandList className="max-h-[420px] py-1">
        <CommandEmpty className="py-10 text-[13px] text-muted-foreground">
          {searching && (studentsFetching || staffFetching) ? 'Searching…' : <>No matches for “{search}”.</>}
        </CommandEmpty>

        {visibleGoTo.length > 0 && (
          <CommandGroup heading="Go to">
            {visibleGoTo.map((e) => (
              <CommandItem key={e.to} value={`go ${e.label}`} onSelect={() => go(e.to)} className="gap-2.5 px-2 py-2 text-[13.5px]">
                <span className="flex size-5 items-center justify-center text-muted-foreground [&>svg]:size-4">{e.icon}</span>
                {e.label}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {visibleActions.length > 0 && (
          <>
            <CommandSeparator className="my-1" />
            <CommandGroup heading="Actions">
              {visibleActions.map((e) => (
                <CommandItem key={e.label} value={`action ${e.label}`} onSelect={() => go(e.to)} className="gap-2.5 px-2 py-2 text-[13.5px]">
                  <span className="flex size-5 items-center justify-center text-muted-foreground [&>svg]:size-4">{e.icon}</span>
                  {e.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searching && (students?.items.length ?? 0) > 0 && (
          <>
            <CommandSeparator className="my-1" />
            <CommandGroup heading="Students">
              {students!.items.map((s) => (
                <CommandItem key={s.id} value={`student ${fullName(s)} ${s.admissionNumber} ${search}`} onSelect={() => go(`/students/${s.id}`)} className="gap-2.5 px-2 py-1.5 text-[13.5px]">
                  <UserAvatar name={fullName(s)} src={s.photoUrl} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{fullName(s)}</span>
                  <span className="text-[11.5px] text-muted-foreground tabular-nums">{s.admissionNumber}</span>
                  {s.grade && <Tag color={colorFor(s.grade.name)}>{s.grade.name}{s.section ? `-${s.section.name}` : ''}</Tag>}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searching && (staff?.items.length ?? 0) > 0 && (
          <>
            <CommandSeparator className="my-1" />
            <CommandGroup heading="Staff">
              {staff!.items.map((s) => (
                <CommandItem key={s.id} value={`staff ${fullName(s)} ${s.employeeCode} ${search}`} onSelect={() => go(`/staff/${s.id}`)} className="gap-2.5 px-2 py-1.5 text-[13.5px]">
                  <UserAvatar name={fullName(s)} src={s.photoUrl} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{fullName(s)}</span>
                  <span className="text-[11.5px] text-muted-foreground">{s.designation}</span>
                  <Tag color={colorFor(s.staffType)}>{s.staffType === 'teaching' ? 'Teaching' : 'Support'}</Tag>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator className="my-1" />
        <CommandGroup heading="Account">
          {activeMemberships.length > 1 && (
            <CommandItem value="switch school" onSelect={() => go('/select-school')} className="gap-2.5 px-2 py-2 text-[13.5px]">
              <span className="flex size-5 items-center justify-center text-muted-foreground [&>svg]:size-4"><Building2 /></span>
              Switch school
            </CommandItem>
          )}
          <CommandItem value="account security password two factor" onSelect={() => go('/account/security')} className="gap-2.5 px-2 py-2 text-[13.5px]">
            <span className="flex size-5 items-center justify-center text-muted-foreground [&>svg]:size-4"><ShieldCheck /></span>
            Account security
          </CommandItem>
          <CommandItem value="sign out log out" onSelect={() => run(() => { void signOut().then(() => navigate({ to: '/login' })) })} className="gap-2.5 px-2 py-2 text-[13.5px]">
            <span className="flex size-5 items-center justify-center text-muted-foreground [&>svg]:size-4"><LogOut /></span>
            Sign out
          </CommandItem>
        </CommandGroup>

        <CommandSeparator className="my-1" />
        <CommandGroup heading="Theme">
          <CommandItem value="theme toggle dark mode" onSelect={() => run(toggle)} className="gap-2.5 px-2 py-2 text-[13.5px]">
            <span className="flex size-5 items-center justify-center text-muted-foreground [&>svg]:size-4">{theme === 'dark' ? <Sun /> : <Moon />}</span>
            {theme === 'dark' ? 'Switch to light mode' : 'Toggle dark mode'}
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="flex items-center gap-1.5 border-t px-3 py-2 text-[11.5px] text-muted-foreground">
        <span className="kbd">↑↓</span> to move <span className="text-border">·</span> <span className="kbd">↵</span> to open <span className="text-border">·</span> <span className="kbd">esc</span> to close
      </div>
    </CommandDialog>
  )
}
