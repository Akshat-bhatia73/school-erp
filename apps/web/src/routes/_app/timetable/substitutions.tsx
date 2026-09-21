import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Info, Plus, Search, Send, UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { TimetableNotifyRequest } from '@erp/contracts'
import { api } from '@/lib/api'
import type { SubstitutionRecord } from '@/lib/api/timetable'
import { describeError, isApiError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable } from '@/components/shared/data-table'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { AbsentTeacherPanel } from '@/components/timetable/absent-teacher-panel'
import { FreeTeachersToday } from '@/components/timetable/free-teachers-today'
import { TimetableTabs } from '@/components/timetable/timetable-tabs'
import { dayOfWeekFor } from '@/components/timetable/day-selector'
import { NoAcademicYearState } from '@/components/timetable/states'
import { mergeBellSchedules, periodNameFor } from '@/components/timetable/timetable-grid'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { cn } from '@/lib/utils'

// Anything that is not a plain date falls back to today; the API answers 400 for the rest.
const searchSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/timetable/substitutions')({ component: Page, validateSearch: searchSchema })

function today() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function weekdayName(date: string) {
  const d = new Date(`${date}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { weekday: 'long' })
}

export function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const queryClient = useQueryClient()
  const { schoolId, hasPermission } = useSchoolContext()
  const { currentYearId, isLoading: yearLoading } = useAcademicYear()
  const yearId = currentYearId ?? ''

  const date = search.date ?? today()
  const [extraAbsent, setExtraAbsent] = useState<Array<{ id: string; name: string }>>([])
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [dismissed, setDismissed] = useState<string[]>([])

  const dayQuery = useQuery({
    queryKey: qk.substitutions(schoolId, date),
    queryFn: () => api.timetable.substitutions(schoolId, date),
  })
  const subs = useMemo(() => dayQuery.data?.substitutions ?? [], [dayQuery.data])
  const canManage = allows(dayQuery.data?.allowedActions, 'timetable.manage_substitutions')
  const canNotify = allows(dayQuery.data?.allowedActions, 'timetable.notify_substitutions')

  const bellParams = { academicYearId: yearId }
  const { data: schedules = [] } = useQuery({
    queryKey: qk.bellSchedules(schoolId, bellParams),
    queryFn: () => api.timetable.bellSchedules(schoolId, bellParams),
    enabled: !!yearId,
  })
  // Arrangements span wings, so period names come from every schedule of the year.
  const bell = useMemo(() => mergeBellSchedules(schedules), [schedules])

  const dayOfWeek = dayOfWeekFor(date)
  const weekday = weekdayName(date)

  // Start each day fresh: yesterday's away list must not leak into today.
  useEffect(() => { setExtraAbsent([]); setDismissed([]); setReasons({}) }, [date])

  const absentTeachers = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>()
    for (const s of subs) byId.set(s.absentTeacher.id, s.absentTeacher)
    for (const t of extraAbsent) if (!byId.has(t.id)) byId.set(t.id, t)
    for (const id of dismissed) byId.delete(id)
    return [...byId.values()]
  }, [subs, extraAbsent, dismissed])

  // The free-teacher read is gated on this permission, so people without it
  // are not shown a panel they cannot fill.
  const canSeeFreeTeachers = hasPermission('timetable.manage_entries')

  const pending = subs.filter((s) => !s.notified).length

  const notify = useMutation({
    mutationFn: () => {
      const parsed = TimetableNotifyRequest.safeParse({ date })
      if (!parsed.success) return Promise.reject(new Error('invalid'))
      return api.timetable.notifySubstitutions(schoolId, parsed.data)
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'timetable'] })
      toast.success(`Queued ${result.queued} ${result.queued === 1 ? 'notice' : 'notices'}`)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const columns = useMemo<ColumnDef<SubstitutionRecord, unknown>[]>(() => [
    {
      id: 'period', header: 'Period', size: 150,
      accessorFn: (r) => r.periodIndex,
      cell: ({ row }) => {
        const p = bell?.periods.find((x) => x.index === row.original.periodIndex)
        return <span>{periodNameFor(bell, row.original.periodIndex)}<span className="ml-2 text-[12px] tabular-nums text-muted-foreground">{p ? `${p.startTime}–${p.endTime}` : ''}</span></span>
      },
    },
    { id: 'class', header: 'Class', size: 140, accessorFn: (r) => r.section.name, cell: ({ row }) => <Tag color={colorFor(row.original.section.id)}>{row.original.section.name}</Tag> },
    { id: 'subject', header: 'Subject', size: 160, accessorFn: (r) => r.subject.name, cell: ({ row }) => <Tag color={colorFor(row.original.subject.id)}>{row.original.subject.name}</Tag> },
    { id: 'absent', header: 'Absent', accessorFn: (r) => r.absentTeacher.name, cell: ({ row }) => <span className="flex items-center gap-2"><UserAvatar name={row.original.absentTeacher.name} size="xs" />{row.original.absentTeacher.name}</span> },
    { id: 'substitute', header: 'Substitute', accessorFn: (r) => r.substituteTeacher?.name ?? '', cell: ({ row }) => row.original.substituteTeacher ? <span className="flex items-center gap-2"><UserAvatar name={row.original.substituteTeacher.name} size="xs" />{row.original.substituteTeacher.name}</span> : <Tag>Free period</Tag> },
    { id: 'status', header: 'Status', size: 110, accessorFn: (r) => (r.notified ? 'notified' : 'pending'), cell: ({ row }) => <Tag color={row.original.notified ? 'green' : 'orange'} dot>{row.original.notified ? 'Notified' : 'Pending'}</Tag> },
  ], [bell])

  if (isApiError(dayQuery.error)) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Timetable' }, { label: 'Substitutions' }]} hideOnMobile />
        <TimetableTabs />
        <EmptyState icon={<UserMinus />} title={describeError(dayQuery.error)} />
      </>
    )
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'Timetable' }, { label: 'Substitutions' }]} hideOnMobile />
      <TimetableTabs />
      <Toolbar
        right={canNotify ? (
          <Button size="sm" disabled={pending === 0 || notify.isPending} title={pending === 0 ? 'Nothing is waiting to be sent' : undefined} onClick={() => notify.mutate()}>
            <Send /> Notify teachers{pending > 0 ? ` (${pending})` : ''}
          </Button>
        ) : undefined}
      >
        <Input type="date" aria-label="Day" value={date} onChange={(e) => void navigate({ search: { date: e.target.value || today() }, replace: true })} className="h-8 w-40" />
        <Tag color="blue">{weekday}</Tag>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin p-4">
        <Alert className="mb-3">
          <Info />
          <AlertDescription>Arrangements are for one day only. The regular timetable is not changed.</AlertDescription>
        </Alert>

        {yearLoading ? null : !yearId && canManage ? (
          <NoAcademicYearState />
        ) : (
          <>
            <Panel title="Who is away today" className="mb-3" actions={canManage ? (
              <AddAbsentTeacher
                excluded={absentTeachers.map((t) => t.id)}
                onPick={(teacher) => {
                  setDismissed((d) => d.filter((x) => x !== teacher.id))
                  setExtraAbsent((a) => (a.some((t) => t.id === teacher.id) ? a : [...a, teacher]))
                }}
              />
            ) : undefined}>
              {absentTeachers.length === 0
                ? <p className="text-[13px] text-muted-foreground">Nobody marked away yet.{canManage ? ' Add a teacher to plan arrangements.' : ''}</p>
                : <p className="text-[13px] text-muted-foreground">{absentTeachers.length} {absentTeachers.length === 1 ? 'teacher is' : 'teachers are'} away on {weekday}.</p>}
            </Panel>

            {canSeeFreeTeachers && yearId ? (
              <FreeTeachersToday academicYearId={yearId} dayOfWeek={dayOfWeek} bell={bell} weekday={weekday} />
            ) : null}

            {absentTeachers.length === 0 ? (
              <EmptyState icon={<UserMinus />} title="No one is away" description={canManage ? 'Pick a teacher above to arrange cover for their periods.' : 'Nothing has been arranged for this day.'} />
            ) : canManage ? absentTeachers.map((t) => (
              <AbsentTeacherPanel
                key={t.id}
                staffId={t.id}
                staffName={t.name}
                date={date}
                dayOfWeek={dayOfWeek}
                academicYearId={yearId}
                bell={bell}
                substitutions={subs.filter((s) => s.absentTeacher.id === t.id)}
                canEdit={canManage}
                reason={reasons[t.id] ?? 'On leave'}
                onReasonChange={(v) => setReasons((r) => ({ ...r, [t.id]: v }))}
                onRemove={() => {
                  setExtraAbsent((a) => a.filter((x) => x.id !== t.id))
                  setDismissed((d) => (d.includes(t.id) ? d : [...d, t.id]))
                }}
              />
            )) : null}
          </>
        )}

        <Panel title="All arrangements for the day" bodyClassName={cn('px-0 pb-0')}>
          <DataTable
            columns={columns}
            data={subs}
            isLoading={dayQuery.isLoading}
            dense
            getRowId={(r) => r.id}
            emptyState={<EmptyState title="No arrangements yet" description={canManage ? 'Arrange cover for an absent teacher above.' : 'Nothing has been arranged for this day.'} />}
            footer={<span>{subs.length} {subs.length === 1 ? 'arrangement' : 'arrangements'} · {pending} pending</span>}
          />
        </Panel>
      </div>
    </>
  )
}

/** Search the staff directory for the teacher who is away today. */
function AddAbsentTeacher({ excluded, onPick }: { excluded: string[]; onPick: (teacher: { id: string; name: string }) => void }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const term = q.trim()

  const { data = [], isFetching } = useQuery({
    queryKey: qk.staffSearch(schoolId, term),
    queryFn: () => api.staff.search(schoolId, term),
    enabled: open && term.length >= 2,
  })

  if (!hasPermission('staff.read_directory')) return null

  const rows = data.filter((s) => !excluded.includes(s.id))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm"><Plus /> Add absent teacher</Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="relative border-b p-2">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search teachers" aria-label="Search teachers" className="h-8 pl-8" />
        </div>
        <div className="max-h-72 overflow-auto scrollbar-thin py-1">
          {term.length < 2 ? (
            <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">Type at least two letters.</p>
          ) : isFetching ? (
            <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">Searching…</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">No teachers found.</p>
          ) : rows.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => { onPick({ id: s.id, name: s.displayName }); setOpen(false); setQ('') }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent"
            >
              <UserAvatar name={s.displayName} size="xs" />
              <span className="min-w-0 flex-1 truncate">{s.displayName}</span>
              <span className="shrink-0 text-[11.5px] text-muted-foreground">{s.designation}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
