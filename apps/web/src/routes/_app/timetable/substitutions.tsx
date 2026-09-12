import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Info, Send, UserMinus } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import type { Staff } from '@erp/shared'
import { api } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable } from '@/components/shared/data-table'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { AbsentTeacherPanel } from '@/components/timetable/absent-teacher-panel'
import { TimetableTabs } from '@/components/timetable/timetable-tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { cn, fullName } from '@/lib/utils'

const DEFAULT_DATE = '2026-09-14'
const searchSchema = z.object({ date: z.string().default(DEFAULT_DATE) })

export const Route = createFileRoute('/_app/timetable/substitutions')({ component: Page, validateSearch: searchSchema })

type SubRow = Awaited<ReturnType<typeof api.timetable.substitutions>>[number]

function dowOf(date: string) {
  const d = new Date(date + 'T00:00:00').getDay()
  return d === 0 ? 7 : d
}

function weekdayName(date: string) {
  const d = new Date(date + 'T00:00:00')
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { weekday: 'long' })
}

function Page() {
  const { date } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const qc = useQueryClient()
  const { can } = useSession()
  const canEdit = can('timetable', 'edit')

  const [extraAbsent, setExtraAbsent] = useState<string[]>([])
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [dismissed, setDismissed] = useState<string[]>([])

  const { data: subs = [], isLoading } = useQuery({ queryKey: qk.substitutions(date), queryFn: () => api.timetable.substitutions(date) })
  const { data: staffPage } = useQuery({ queryKey: qk.staff({ staffType: 'teaching', pageSize: 500 }), queryFn: () => api.staff.list({ staffType: 'teaching', pageSize: 500 }) })
  const { data: bell } = useQuery({ queryKey: [...qk.bellSchedules, 'subs'], queryFn: () => api.timetable.bellFor(undefined) })

  const teachers = useMemo(() => staffPage?.items ?? [], [staffPage])
  const dayOfWeek = dowOf(date)
  const weekday = weekdayName(date)

  // Start each day fresh: yesterday's away list must not leak into today.
  useEffect(() => { setExtraAbsent([]); setDismissed([]); setReasons({}) }, [date])

  // Once a teacher has an arrangement they stay on the list for the session, so removing
  // their last arrangement does not make the panel disappear mid-edit.
  useEffect(() => {
    setExtraAbsent((prev) => {
      const add = subs.map((s) => s.absentStaffId).filter((id) => !prev.includes(id))
      return add.length ? [...prev, ...new Set(add)] : prev
    })
  }, [subs])

  const absentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const s of subs) ids.add(s.absentStaffId)
    for (const id of extraAbsent) ids.add(id)
    for (const id of dismissed) ids.delete(id)
    return [...ids]
  }, [subs, extraAbsent, dismissed])

  // Teachers who already have an arrangement may sit outside the staff page (e.g. a long tail),
  // so fall back to the staff joined onto the substitution row.
  const staffById = useMemo(() => {
    const m = new Map<string, Staff>()
    for (const t of teachers) m.set(t.id, t)
    for (const s of subs) if (s.absent && !m.has(s.absent.id)) m.set(s.absent.id, s.absent)
    return m
  }, [teachers, subs])

  const absentStaff = absentIds.map((id) => staffById.get(id)).filter((t): t is Staff => !!t)

  const pending = subs.filter((s) => !s.notified).length

  const notify = useMutation({
    mutationFn: () => api.timetable.markNotified(date),
    onSuccess: (n) => {
      qc.invalidateQueries({ queryKey: ['timetable'] })
      qc.invalidateQueries({ queryKey: qk.substitutions(date) })
      toast.success(`Sent ${n} notices`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const columns = useMemo<ColumnDef<SubRow, unknown>[]>(() => [
    {
      id: 'period', header: 'Period', size: 150,
      accessorFn: (r) => r.periodIndex,
      cell: ({ row }) => {
        const p = bell?.periods.find((x) => x.index === row.original.periodIndex)
        return <span>{p?.name ?? `Period ${row.original.periodIndex + 1}`}<span className="ml-2 text-[12px] tabular-nums text-muted-foreground">{p ? `${p.startTime}–${p.endTime}` : ''}</span></span>
      },
    },
    { id: 'class', header: 'Class', size: 120, accessorFn: (r) => r.sectionId, cell: ({ row }) => <Tag color={colorFor(row.original.sectionId)}>{row.original.grade?.name} - {row.original.section?.name}</Tag> },
    { id: 'subject', header: 'Subject', size: 160, accessorFn: (r) => r.subject?.name ?? '', cell: ({ row }) => <Tag color={colorFor(row.original.subject?.code ?? row.original.subjectId)}>{row.original.subject?.name ?? 'Subject'}</Tag> },
    { id: 'absent', header: 'Absent', accessorFn: (r) => (r.absent ? fullName(r.absent) : ''), cell: ({ row }) => row.original.absent ? <span className="flex items-center gap-2"><UserAvatar name={fullName(row.original.absent)} size="xs" />{fullName(row.original.absent)}</span> : '—' },
    { id: 'substitute', header: 'Substitute', accessorFn: (r) => (r.substitute ? fullName(r.substitute) : ''), cell: ({ row }) => row.original.substitute ? <span className="flex items-center gap-2"><UserAvatar name={fullName(row.original.substitute)} size="xs" />{fullName(row.original.substitute)}</span> : <Tag>Free period</Tag> },
    { id: 'status', header: 'Status', size: 110, accessorFn: (r) => (r.notified ? 'notified' : 'pending'), cell: ({ row }) => <Tag color={row.original.notified ? 'green' : 'orange'} dot>{row.original.notified ? 'Notified' : 'Pending'}</Tag> },
  ], [bell])

  return (
    <>
      <PageHeader crumbs={[{ label: 'Timetable' }, { label: 'Substitutions' }]} />
      <TimetableTabs />
      <Toolbar
        right={canEdit ? (
          <Button size="sm" disabled={pending === 0 || notify.isPending} onClick={() => notify.mutate()}>
            <Send /> Send to teachers{pending > 0 ? ` (${pending})` : ''}
          </Button>
        ) : undefined}
      >
        <Input type="date" value={date} onChange={(e) => navigate({ search: { date: e.target.value || DEFAULT_DATE }, replace: true })} className="h-8 w-40" />
        <Tag color="blue">{weekday}</Tag>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin p-4">
        <Alert className="mb-3">
          <Info />
          <AlertDescription>Arrangements are for one day only. The regular timetable is not changed.</AlertDescription>
        </Alert>

        <Panel title="Who is away today" className="mb-3" actions={canEdit ? (
          <Select
            value=""
            onValueChange={(v) => { setDismissed((d) => d.filter((x) => x !== v)); setExtraAbsent((a) => (a.includes(v) ? a : [...a, v])) }}
          >
            <SelectTrigger className="h-7 w-52 text-[12.5px]"><SelectValue placeholder="Add absent teacher" /></SelectTrigger>
            <SelectContent>
              {teachers.filter((t) => !absentIds.includes(t.id)).map((t) => (
                <SelectItem key={t.id} value={t.id}>{fullName(t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined}>
          {absentStaff.length === 0
            ? <p className="text-[13px] text-muted-foreground">Nobody marked away yet. Add a teacher to plan arrangements.</p>
            : <p className="text-[13px] text-muted-foreground">{absentStaff.length} {absentStaff.length === 1 ? 'teacher is' : 'teachers are'} away on {weekday}.</p>}
        </Panel>

        {absentStaff.length === 0 ? (
          <EmptyState icon={<UserMinus />} title="No one is away" description="Pick a teacher above to arrange cover for their periods." />
        ) : absentStaff.map((t) => (
          <AbsentTeacherPanel
            key={t.id}
            staff={t}
            date={date}
            dayOfWeek={dayOfWeek}
            bell={bell}
            canEdit={canEdit}
            reason={reasons[t.id] ?? 'On leave'}
            onReasonChange={(v) => setReasons((r) => ({ ...r, [t.id]: v }))}
            onRemove={() => { setExtraAbsent((a) => a.filter((x) => x !== t.id)); setDismissed((d) => (d.includes(t.id) ? d : [...d, t.id])) }}
          />
        ))}

        <Panel title="All arrangements for the day" bodyClassName={cn('px-0 pb-0')}>
          <DataTable
            columns={columns}
            data={subs}
            isLoading={isLoading}
            dense
            getRowId={(r) => r.id}
            emptyState={<EmptyState title="No arrangements yet" description="Arrange cover for an absent teacher above." />}
            footer={<span>{subs.length} {subs.length === 1 ? 'arrangement' : 'arrangements'} · {pending} pending</span>}
          />
        </Panel>
      </div>
    </>
  )
}
