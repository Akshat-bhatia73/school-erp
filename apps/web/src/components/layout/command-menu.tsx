import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { BookOpen, Building2, CalendarDays, GraduationCap, LayoutDashboard, ListChecks, LogOut, Moon, ScrollText, School, ShieldCheck, Sun, UserPlus, UserRound, Users, ArrowUpRight, Upload, MailPlus, CalendarClock } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { UserAvatar } from '@/components/shared/avatar'
import { Tag, colorFor } from '@/components/shared/tag'
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { type PermissionKey } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext, useSession } from '@/lib/session'
import { useTheme } from '@/lib/theme'
import { fullName } from '@/lib/utils'

interface Entry { label: string; icon: ReactNode; to: string; permission?: PermissionKey }

const goTo: Entry[] = [
  { label: 'Dashboard', icon: <LayoutDashboard />, to: '/dashboard' },
  { label: 'Students', icon: <GraduationCap />, to: '/students', permission: 'students.read_basic' },
  { label: 'Staff', icon: <Users />, to: '/staff', permission: 'staff.read_directory' },
  { label: 'Timetable', icon: <CalendarClock />, to: '/timetable', permission: 'timetable.read' },
  { label: 'School profile', icon: <School />, to: '/setup/school', permission: 'school.read' },
  { label: 'Academic years', icon: <CalendarDays />, to: '/setup/academic-years', permission: 'academic_years.read' },
  { label: 'Classes & sections', icon: <Building2 />, to: '/setup/classes', permission: 'sections.read' },
  { label: 'Subjects', icon: <BookOpen />, to: '/setup/subjects', permission: 'subjects.read' },
  { label: 'Holidays', icon: <ListChecks />, to: '/setup/holidays', permission: 'holidays.read' },
  { label: 'Users & logins', icon: <UserRound />, to: '/settings/users', permission: 'members.read' },
  { label: 'Roles & permissions', icon: <ShieldCheck />, to: '/settings/roles', permission: 'roles.read' },
  { label: 'Audit log', icon: <ScrollText />, to: '/settings/audit-log', permission: 'audit.read' },
]

const actions: Entry[] = [
  { label: 'Admit student', icon: <UserPlus />, to: '/students/new', permission: 'students.create' },
  { label: 'Import students from Excel', icon: <Upload />, to: '/students/import', permission: 'students.import' },
  { label: 'Promote students', icon: <ArrowUpRight />, to: '/students/promote', permission: 'students.promote' },
  { label: 'Add staff', icon: <UserPlus />, to: '/staff/new', permission: 'staff.create' },
  { label: 'Invite user', icon: <MailPlus />, to: '/settings/users', permission: 'members.invite' },
]

export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate()
  const { activeMemberships, signOut } = useSession()
  const { schoolId, hasPermission } = useSchoolContext()
  const { theme, toggle } = useTheme()
  const [query, setQuery] = useState('')
  // Debounced so a name typed quickly is one request, not one per keystroke.
  const [term, setTerm] = useState('')
  const search = query.trim()

  useEffect(() => { if (!open) { setQuery(''); setTerm('') } }, [open])
  useEffect(() => {
    const id = setTimeout(() => setTerm(search), 200)
    return () => clearTimeout(id)
  }, [search])

  const searching = search.length >= 2
  // The search route itself requires students.read_basic, so gate on exactly that.
  const maySearch = hasPermission('students.read_basic')
  const { data: results, isFetching, error } = useQuery({
    queryKey: qk.search(schoolId, term),
    queryFn: () => api.search.run(schoolId, term),
    enabled: open && maySearch && term.length >= 2,
  })
  const students = results?.students ?? []
  const staff = results?.staff ?? []

  const run = (fn: () => void) => { onOpenChange(false); fn() }
  const go = (to: string) => run(() => { void navigate({ to }) })

  const visibleGoTo = goTo.filter((e) => !e.permission || hasPermission(e.permission))
  const visibleActions = actions.filter((e) => !e.permission || hasPermission(e.permission))

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
          {searching && error ? describeError(error) : searching && (isFetching || term !== search) ? 'Searching…' : <>No matches for “{search}”.</>}
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

        {searching && students.length > 0 && (
          <>
            <CommandSeparator className="my-1" />
            <CommandGroup heading="Students">
              {students.map((s) => (
                <CommandItem key={s.id} value={`student ${fullName(s)} ${s.admissionNumber} ${search}`} onSelect={() => go(`/students/${s.id}`)} className="gap-2.5 px-2 py-1.5 text-[13.5px]">
                  <UserAvatar name={fullName(s)} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{fullName(s)}</span>
                  <span className="text-[11.5px] text-muted-foreground tabular-nums">{s.admissionNumber}</span>
                  {s.enrollment && <Tag color={colorFor(s.enrollment.grade.name)}>{s.enrollment.grade.name}-{s.enrollment.section.name}</Tag>}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {searching && staff.length > 0 && (
          <>
            <CommandSeparator className="my-1" />
            <CommandGroup heading="Staff">
              {staff.map((s) => (
                <CommandItem key={s.id} value={`staff ${s.displayName} ${search}`} onSelect={() => go(`/staff/${s.id}`)} className="gap-2.5 px-2 py-1.5 text-[13.5px]">
                  <UserAvatar name={s.displayName} size="sm" />
                  <span className="min-w-0 flex-1 truncate">{s.displayName}</span>
                  <span className="text-[11.5px] text-muted-foreground">{s.designation}</span>
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
