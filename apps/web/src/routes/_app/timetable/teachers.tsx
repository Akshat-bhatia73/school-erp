import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CalendarDays, Search, UserRound } from 'lucide-react'
import { z } from 'zod'
import { api } from '@/lib/api'
import { describeError, isApiError } from '@/lib/api-errors'
import { useIsMobile } from '@/lib/use-media'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { TimetableTabs } from '@/components/timetable/timetable-tabs'
import { TimetableExportMenu } from '@/components/timetable/export-menu'
import { TimetableGrid, mergeBellSchedules } from '@/components/timetable/timetable-grid'
import { DAY_LABELS, DaySelector, defaultDay } from '@/components/timetable/day-selector'
import { NoAcademicYearState, RefusedState } from '@/components/timetable/states'
import { MobilePicker } from '@/components/shared/mobile-picker'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { cn } from '@/lib/utils'

const searchSchema = z.object({ staffId: z.string().optional() })

export const Route = createFileRoute('/_app/timetable/teachers')({ component: Page, validateSearch: searchSchema })

export function Page() {
  const { staffId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [q, setQ] = useState('')
  const { schoolId, hasPermission } = useSchoolContext()
  const { currentYearId, isLoading: yearLoading } = useAcademicYear()
  const yearId = currentYearId ?? ''
  const canReadLoads = hasPermission('timetable.read_teacher_loads')

  const loadParams = { academicYearId: yearId }
  const loadsQuery = useQuery({
    queryKey: qk.teacherLoads(schoolId, loadParams),
    queryFn: () => api.timetable.teacherLoads(schoolId, loadParams),
    enabled: !!yearId && canReadLoads,
  })
  const loads = useMemo(() => loadsQuery.data ?? [], [loadsQuery.data])

  const bellParams = { academicYearId: yearId }
  const { data: schedules = [], isLoading: bellLoading } = useQuery({
    queryKey: qk.bellSchedules(schoolId, bellParams),
    queryFn: () => api.timetable.bellSchedules(schoolId, bellParams),
    enabled: !!yearId && canReadLoads,
  })

  const gridQuery = useQuery({
    queryKey: qk.timetableStaff(schoolId, staffId ?? '', { academicYearId: yearId }),
    queryFn: () => api.timetable.forStaff(schoolId, staffId!, { academicYearId: yearId }),
    enabled: !!staffId && !!yearId,
  })
  const cells = useMemo(() => gridQuery.data?.cells ?? [], [gridQuery.data])
  // A teacher's week can span wings, so the rows are every schedule's periods, not the first's.
  const bell = useMemo(() => mergeBellSchedules(schedules, cells), [schedules, cells])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return loads
    return loads.filter((l) => l.teacher.name.toLowerCase().includes(needle))
  }, [loads, q])

  const load = loads.find((l) => l.teacher.id === staffId)
  const busiest = useMemo(() => loads.reduce((max, l) => Math.max(max, l.periodsPerWeek), 0), [loads])

  const [day, setDay] = useState<number | undefined>()
  const isMobile = useIsMobile()
  const workingDays = useMemo(() => [...(bell?.workingDays ?? [])].sort((a, b) => a - b), [bell])
  const shownDay = day !== undefined && workingDays.includes(day) ? day : defaultDay(workingDays)

  const perDay = useMemo(() => {
    const counts: Record<number, number> = {}
    for (const c of cells) counts[c.dayOfWeek] = (counts[c.dayOfWeek] ?? 0) + 1
    return counts
  }, [cells])

  const teacherList = (onPick?: () => void) => loadsQuery.isLoading ? (
    <div className="grid gap-2 p-3">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-11 rounded-lg" />)}</div>
  ) : filtered.length === 0 ? (
    <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">No teachers found.</p>
  ) : filtered.map((l) => {
    const ratio = busiest > 0 ? l.periodsPerWeek / busiest : 0
    return (
      <button
        key={l.teacher.id}
        type="button"
        onClick={() => { void navigate({ search: { staffId: l.teacher.id }, replace: true }); onPick?.() }}
        className={cn('flex w-full items-center gap-2.5 border-l-2 border-transparent px-3 py-2.5 text-left hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-2 md:py-2', l.teacher.id === staffId && 'border-l-foreground bg-accent')}
      >
        <UserAvatar name={l.teacher.name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{l.teacher.name}</span>
          <span className="block truncate text-[12px] text-muted-foreground">{l.sectionsCount} sections · {l.subjectsCount} subjects</span>
        </span>
        <span className="w-10 shrink-0 text-right">
          <span className="block text-[13px] tabular-nums">{l.periodsPerWeek}</span>
          <span className="mt-1 block h-1 w-full overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-tag-blue" style={{ width: `${Math.round(ratio * 100)}%` }} />
          </span>
        </span>
      </button>
    )
  })

  if (!canReadLoads) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Timetable' }, { label: 'Teachers' }]} hideOnMobile />
        <TimetableTabs />
        <RefusedState sentence="You can only see your own week, which is on your dashboard." />
      </>
    )
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'Timetable' }, { label: 'Teachers' }]} hideOnMobile />
      <TimetableTabs />
      {yearLoading ? (
        <div className="grid gap-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
      ) : !yearId ? (
        <NoAcademicYearState />
      ) : isApiError(loadsQuery.error) ? (
        <EmptyState icon={<UserRound />} title={describeError(loadsQuery.error)} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <MobilePicker label="Teacher" value={load ? load.teacher.name : undefined} title="Pick a teacher">
            {(close) => (
              <>
                <div className="relative sticky top-0 z-10 shrink-0 border-b bg-card p-2">
                  <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search teachers" aria-label="Search teachers" className="h-9 pl-8" />
                </div>
                {teacherList(close)}
              </>
            )}
          </MobilePicker>
          <aside className="hidden w-72 shrink-0 flex-col border-r bg-card md:flex">
            <div className="relative shrink-0 border-b p-2">
              <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search teachers" aria-label="Search teachers" className="h-8 pl-8" />
            </div>
            <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">{teacherList()}</div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!load ? (
              <EmptyState icon={<UserRound />} title="Pick a teacher" description="Choose a teacher to see their week." />
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-card px-4 py-3">
                  <UserAvatar name={load.teacher.name} size="lg" />
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold">{load.teacher.name}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
                    <Tag color="blue">{load.periodsPerWeek} periods / week</Tag>
                    <Tag>{load.sectionsCount} sections</Tag>
                    <Tag>{load.subjectsCount} subjects</Tag>
                    <TimetableExportMenu academicYearId={yearId} view={{ kind: 'teacher', staffId: load.teacher.id }} />
                  </div>
                </div>
                {bellLoading || gridQuery.isLoading ? (
                  <div className="grid gap-2 p-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
                ) : isApiError(gridQuery.error) ? (
                  <EmptyState icon={<CalendarDays />} title={describeError(gridQuery.error)} />
                ) : !bell ? (
                  <EmptyState icon={<CalendarDays />} title="No periods set up yet" description="Set up periods on the Bell schedule tab to see the week." />
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col overflow-auto scrollbar-thin">
                    <DaySelector days={workingDays} value={shownDay} onChange={setDay} />
                    <TimetableGrid bell={bell} cells={cells} mode="staff" highlightFree dayFilter={isMobile ? shownDay : undefined} />
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-card px-4 py-2.5 text-[13px] text-muted-foreground">
                      <span className="text-[12px] font-medium tracking-wide">Per day</span>
                      {workingDays.map((d) => (
                        <span key={d}>{DAY_LABELS[d]} <span className="tabular-nums text-foreground">{perDay[d] ?? 0}</span></span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
