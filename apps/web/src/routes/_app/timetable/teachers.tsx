import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CalendarDays, Search, UserRound } from 'lucide-react'
import { z } from 'zod'
import { DAY_LABELS } from '@erp/shared'
import { api } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { useAcademicYears } from '@/components/setup/use-current-year'
import { TimetableTabs } from '@/components/timetable/timetable-tabs'
import { TimetableGrid } from '@/components/timetable/timetable-grid'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { cn, fullName } from '@/lib/utils'

const searchSchema = z.object({ staffId: z.string().optional() })

export const Route = createFileRoute('/_app/timetable/teachers')({ component: Page, validateSearch: searchSchema })

function Page() {
  const { staffId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [q, setQ] = useState('')
  const { current } = useAcademicYears()
  const yearId = current?.id ?? ''

  const { data: loads = [], isLoading } = useQuery({ queryKey: qk.teacherLoads, queryFn: () => api.timetable.teacherLoads() })
  const { data: sections = [] } = useQuery({ queryKey: qk.sections({ academicYearId: yearId }), queryFn: () => api.sections.list({ academicYearId: yearId }), enabled: !!yearId })
  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return loads
    return loads.filter((l) => fullName(l.staff).toLowerCase().includes(needle) || l.staff.designation.toLowerCase().includes(needle))
  }, [loads, q])

  const load = loads.find((l) => l.staffId === staffId)

  const { data: bell, isLoading: bellLoading } = useQuery({ queryKey: [...qk.bellSchedules, 'staff'], queryFn: () => api.timetable.bellFor(undefined) })
  const { data: cells = [], isLoading: cellsLoading } = useQuery({ queryKey: qk.timetableStaff(staffId ?? ''), queryFn: () => api.timetable.forStaff(staffId!), enabled: !!staffId })

  const classTeacherOf = useMemo(() => {
    const s = sections.find((x) => x.classTeacherId === staffId)
    if (!s) return undefined
    const g = grades.find((x) => x.id === s.gradeId)
    return `${g?.name ?? ''} - ${s.name}`
  }, [sections, grades, staffId])

  return (
    <>
      <PageHeader crumbs={[{ label: 'Timetable' }, { label: 'Teachers' }]} />
      <TimetableTabs />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r bg-card">
          <div className="relative shrink-0 border-b p-2">
            <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search teachers" className="h-8 pl-8" />
          </div>
          <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
            {isLoading ? (
              <div className="grid gap-2 p-3">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-11 rounded-lg" />)}</div>
            ) : filtered.length === 0 ? (
              <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No teachers found.</p>
            ) : filtered.map((l) => {
              const ratio = l.maxPerWeek ? Math.min(1, l.periodsPerWeek / l.maxPerWeek) : 0
              const over = l.periodsPerWeek > l.maxPerWeek
              const near = !over && l.periodsPerWeek / l.maxPerWeek >= 0.9
              return (
                <button
                  key={l.staffId}
                  type="button"
                  onClick={() => navigate({ search: { staffId: l.staffId }, replace: true })}
                  className={cn('flex w-full items-center gap-2.5 border-l-2 border-transparent px-3 py-2 text-left hover:bg-accent/60', l.staffId === staffId && 'border-l-foreground bg-accent')}
                >
                  <UserAvatar name={fullName(l.staff)} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium">{fullName(l.staff)}</span>
                    <span className="block truncate text-[12px] text-muted-foreground">{l.staff.designation}</span>
                  </span>
                  <span className="w-10 shrink-0 text-right">
                    <span className="block text-[13px] tabular-nums">{l.periodsPerWeek}</span>
                    <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-muted">
                      <span className={cn('block h-full rounded-full', over ? 'bg-tag-red' : near ? 'bg-tag-orange' : 'bg-tag-blue')} style={{ width: `${Math.round(ratio * 100)}%` }} />
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!load ? (
            <EmptyState icon={<UserRound />} title="Pick a teacher" description="Choose a teacher on the left to see their week." />
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-4 py-3">
                <UserAvatar name={fullName(load.staff)} size="lg" />
                <div className="min-w-0">
                  <div className="text-[15px] font-semibold">{fullName(load.staff)}</div>
                  <div className="text-[12.5px] text-muted-foreground">{load.staff.designation}</div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
                  <Tag color={load.periodsPerWeek > load.maxPerWeek ? 'red' : 'blue'}>{load.periodsPerWeek} periods / week</Tag>
                  <Tag>{load.sectionsCount} sections</Tag>
                  <Tag>{load.subjectsCount} subjects</Tag>
                  {classTeacherOf && <Tag color="green">Class teacher of {classTeacherOf}</Tag>}
                </div>
              </div>
              {bellLoading || cellsLoading ? (
                <div className="grid gap-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
              ) : !bell ? (
                <EmptyState icon={<CalendarDays />} title="No bell schedule yet" description="Set up periods on the Bell schedule tab to see the week." />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col overflow-auto scrollbar-thin">
                  <TimetableGrid bell={bell} cells={cells} mode="staff" highlightFree />
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-card px-4 py-2.5 text-[13px] text-muted-foreground">
                    <span className="text-[12px] font-medium tracking-wide">Per day</span>
                    {Object.keys(DAY_LABELS).map(Number).filter((d) => bell.workingDays.includes(d)).map((d) => (
                      <span key={d}>{DAY_LABELS[d]} <span className="tabular-nums text-foreground">{load.perDay[d] ?? 0}</span></span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
