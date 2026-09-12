import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Bell, Info, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import type { BellSchedule, Period, PeriodType } from '@erp/shared'
import { DAY_LABELS } from '@erp/shared'
import { api } from '@/api/client'
import { EmptyState, PageHeader, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { TimetableTabs } from '@/components/timetable/timetable-tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/timetable/periods')({ component: Page })

const TYPES: PeriodType[] = ['period', 'break', 'lunch', 'assembly']
const DAYS = [1, 2, 3, 4, 5, 6]

function toMinutes(t: string) {
  const [h, m] = t.split(':')
  const hh = Number(h), mm = Number(m)
  return Number.isFinite(hh) && Number.isFinite(mm) ? hh * 60 + mm : NaN
}
function duration(p: { startTime: string; endTime: string }) {
  const d = toMinutes(p.endTime) - toMinutes(p.startTime)
  return Number.isFinite(d) ? d : 0
}

interface Draft {
  name: string
  workingDays: number[]
  saturdayPeriodCount?: number
  periods: Period[]
}

function Page() {
  const qc = useQueryClient()
  const { can } = useSession()
  const canEdit = can('timetable', 'edit')

  const { data: schedules = [], isLoading } = useQuery({ queryKey: qk.bellSchedules, queryFn: () => api.timetable.bellSchedules() })
  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })

  const [selectedId, setSelectedId] = useState<string>('')
  const bell: BellSchedule | undefined = schedules.find((b) => b.id === selectedId) ?? schedules[0]

  useEffect(() => { if (!selectedId && schedules.length) setSelectedId(schedules[0]!.id) }, [schedules, selectedId])

  const [draft, setDraft] = useState<Draft | null>(null)
  useEffect(() => {
    if (!bell) return
    setDraft({ name: bell.name, workingDays: [...bell.workingDays], saturdayPeriodCount: bell.saturdayPeriodCount, periods: bell.periods.map((p) => ({ ...p })) })
  }, [bell?.id, bell?.updatedAt]) // reset the draft only when a different (or freshly saved) schedule arrives

  const dirty = useMemo(() => {
    if (!bell || !draft) return false
    return JSON.stringify(draft) !== JSON.stringify({ name: bell.name, workingDays: [...bell.workingDays], saturdayPeriodCount: bell.saturdayPeriodCount, periods: bell.periods.map((p) => ({ ...p })) })
  }, [bell, draft])

  const errors = useMemo(() => {
    const out: Record<number, string> = {}
    if (!draft) return out
    draft.periods.forEach((p, i) => {
      const s = toMinutes(p.startTime), e = toMinutes(p.endTime)
      if (!Number.isFinite(s) || !Number.isFinite(e)) { out[i] = 'Enter a valid time'; return }
      if (e <= s) { out[i] = 'End must be after start'; return }
      const prev = draft.periods[i - 1]
      if (prev && toMinutes(prev.endTime) > s) out[i] = `Overlaps ${prev.name}`
    })
    return out
  }, [draft])

  const save = useMutation({
    mutationFn: () => api.timetable.saveBellSchedule(bell!.id, {
      academicYearId: bell!.academicYearId,
      name: draft!.name,
      gradeIds: bell!.gradeIds,
      workingDays: [...draft!.workingDays].sort((a, b) => a - b),
      periods: draft!.periods.map((p, i) => ({ ...p, index: i })),
      saturdayPeriodCount: draft!.saturdayPeriodCount,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.bellSchedules })
      qc.invalidateQueries({ queryKey: ['timetable'] })
      toast.success('Bell schedule saved')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const update = (fn: (d: Draft) => Draft) => setDraft((d) => (d ? fn(d) : d))
  const setPeriod = (i: number, patch: Partial<Period>) => update((d) => ({ ...d, periods: d.periods.map((p, j) => (j === i ? { ...p, ...patch } : p)) }))
  const move = (i: number, dir: -1 | 1) => update((d) => {
    const j = i + dir
    if (j < 0 || j >= d.periods.length) return d
    const arr = [...d.periods]
    const a = arr[i]!, b = arr[j]!
    arr[i] = b; arr[j] = a
    return { ...d, periods: arr.map((p, k) => ({ ...p, index: k })) }
  })
  const removeAt = (i: number) => update((d) => ({ ...d, periods: d.periods.filter((_, j) => j !== i).map((p, k) => ({ ...p, index: k })) }))
  const addPeriod = () => update((d) => {
    const last = d.periods[d.periods.length - 1]
    const start = last ? last.endTime : '08:00'
    const end = last ? minutesToTime(toMinutes(last.endTime) + (duration(last) || 40)) : '08:40'
    const n = d.periods.filter((p) => p.type === 'period').length + 1
    return { ...d, periods: [...d.periods, { index: d.periods.length, name: `Period ${n}`, startTime: start, endTime: end, type: 'period' }] }
  })

  const totals = useMemo(() => {
    if (!draft) return { teaching: 0, minutes: 0, length: 0 }
    const teaching = draft.periods.filter((p) => p.type === 'period')
    const first = draft.periods[0], last = draft.periods[draft.periods.length - 1]
    return {
      teaching: teaching.length,
      minutes: teaching.reduce((a, p) => a + duration(p), 0),
      length: first && last ? toMinutes(last.endTime) - toMinutes(first.startTime) : 0,
    }
  }, [draft])

  const gradeNames = bell?.gradeIds.length ? grades.filter((g) => bell.gradeIds.includes(g.id)).map((g) => g.name) : []

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Timetable' }, { label: 'Bell schedule' }]}
        actions={canEdit && bell ? <Button size="sm" disabled={!dirty || Object.keys(errors).length > 0 || save.isPending} onClick={() => save.mutate()}>Save changes</Button> : undefined}
      />
      <TimetableTabs />
      <div className="flex min-h-0 flex-1">
        {schedules.length > 1 && (
          <aside className="w-56 shrink-0 overflow-auto border-r bg-card scrollbar-thin">
            <div className="px-4 pt-4 pb-2 text-[12px] font-medium tracking-wide text-muted-foreground">Schedules</div>
            {schedules.map((s) => (
              <button key={s.id} type="button" onClick={() => setSelectedId(s.id)} className={cn('flex h-10 w-full items-center border-l-2 border-transparent px-4 text-left text-[13.5px] hover:bg-accent/60', s.id === bell?.id && 'border-l-foreground bg-accent font-medium')}>
                <span className="truncate">{s.name}</span>
              </button>
            ))}
          </aside>
        )}

        <div className="min-h-0 min-w-0 flex-1 overflow-auto scrollbar-thin p-4">
          {isLoading || !draft ? (
            isLoading
              ? <div className="grid gap-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-lg" />)}</div>
              : <EmptyState icon={<Bell />} title="No bell schedule yet" description="A bell schedule decides which periods exist in the school day." />
          ) : (
            <div className="flex gap-4">
              <div className="min-w-0 flex-1">
                <Alert className="mb-3">
                  <Info />
                  <AlertDescription>Changing periods after the timetable is filled may leave some slots outside the day. Check the Class timetable afterwards.</AlertDescription>
                </Alert>

                <Panel className="mb-3">
                  <div className="grid gap-3">
                    <div className="grid gap-1.5">
                      <label className="text-[12px] text-muted-foreground">Name</label>
                      <Input value={draft.name} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} className="h-8 max-w-sm" disabled={!canEdit} />
                    </div>
                    <div className="grid gap-1.5">
                      <span className="text-[12px] text-muted-foreground">Applies to</span>
                      <span className="flex flex-wrap gap-1.5">
                        {gradeNames.length ? gradeNames.map((n) => <Tag key={n}>{n}</Tag>) : <Tag color="blue">All classes</Tag>}
                      </span>
                    </div>
                    <div className="grid gap-1.5">
                      <span className="text-[12px] text-muted-foreground">Working days</span>
                      <span className="flex flex-wrap gap-1.5">
                        {DAYS.map((d) => {
                          const on = draft.workingDays.includes(d)
                          return (
                            <button
                              key={d}
                              type="button"
                              disabled={!canEdit}
                              onClick={() => update((x) => ({ ...x, workingDays: on ? x.workingDays.filter((y) => y !== d) : [...x.workingDays, d] }))}
                              className={cn('h-7 rounded-full border px-3 text-[12.5px] hover:bg-accent disabled:opacity-50', on && 'border-foreground/20 bg-accent font-medium')}
                            >
                              {DAY_LABELS[d]}
                            </button>
                          )
                        })}
                      </span>
                    </div>
                    <div className="grid gap-1.5">
                      <label className="text-[12px] text-muted-foreground">Saturday periods</label>
                      <Input
                        type="number"
                        min={0}
                        value={draft.saturdayPeriodCount ?? ''}
                        onChange={(e) => update((d) => ({ ...d, saturdayPeriodCount: e.target.value === '' ? undefined : Number(e.target.value) }))}
                        className="h-8 w-28"
                        disabled={!canEdit}
                      />
                    </div>
                  </div>
                </Panel>

                <Panel title="Periods" bodyClassName="px-0 pb-0" actions={canEdit ? <Button variant="outline" size="sm" onClick={addPeriod}><Plus /> Add period</Button> : undefined}>
                  <table className="w-full border-separate border-spacing-0 text-[13.5px]">
                    <thead>
                      <tr className="text-left text-[12.5px] text-muted-foreground">
                        <th className="h-8 w-10 border-y px-3 font-medium">#</th>
                        <th className="h-8 border-y border-l px-3 font-medium">Name</th>
                        <th className="h-8 w-32 border-y border-l px-3 font-medium">Type</th>
                        <th className="h-8 w-28 border-y border-l px-3 font-medium">Start</th>
                        <th className="h-8 w-28 border-y border-l px-3 font-medium">End</th>
                        <th className="h-8 w-24 border-y border-l px-3 font-medium">Duration</th>
                        <th className="h-8 w-24 border-y border-l px-3 font-medium" />
                      </tr>
                    </thead>
                    <tbody>
                      {draft.periods.map((p, i) => (
                        <tr key={i}>
                          <td className="h-11 border-b px-3 tabular-nums text-muted-foreground">{i + 1}</td>
                          <td className="h-11 border-b border-l px-2">
                            <Input value={p.name} onChange={(e) => setPeriod(i, { name: e.target.value })} className="h-7" disabled={!canEdit} />
                          </td>
                          <td className="h-11 border-b border-l px-2">
                            <Select value={p.type} onValueChange={(v) => setPeriod(i, { type: v as PeriodType })} disabled={!canEdit}>
                              <SelectTrigger className="h-7 w-full text-[12.5px]"><SelectValue /></SelectTrigger>
                              <SelectContent>{TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>)}</SelectContent>
                            </Select>
                          </td>
                          <td className="h-11 border-b border-l px-2">
                            <Input type="time" value={p.startTime} onChange={(e) => setPeriod(i, { startTime: e.target.value })} className="h-7" disabled={!canEdit} />
                          </td>
                          <td className="h-11 border-b border-l px-2">
                            <Input type="time" value={p.endTime} onChange={(e) => setPeriod(i, { endTime: e.target.value })} className="h-7" disabled={!canEdit} />
                            {errors[i] && <div className="mt-0.5 text-[11.5px] text-destructive">{errors[i]}</div>}
                          </td>
                          <td className="h-11 border-b border-l px-3 tabular-nums text-muted-foreground">{duration(p)} min</td>
                          <td className="h-11 border-b border-l px-2">
                            {canEdit && (
                              <span className="flex items-center gap-0.5">
                                <Button variant="ghost" size="icon-xs" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp /></Button>
                                <Button variant="ghost" size="icon-xs" onClick={() => move(i, 1)} disabled={i === draft.periods.length - 1} aria-label="Move down"><ArrowDown /></Button>
                                <Button variant="ghost" size="icon-xs" onClick={() => removeAt(i)} aria-label="Remove period"><X /></Button>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              </div>

              <div className="hidden w-80 shrink-0 flex-col gap-3 lg:flex">
                <Panel title="Day at a glance">
                  <div className="flex flex-col gap-1">
                    {draft.periods.map((p, i) => (
                      <div
                        key={i}
                        style={{ minHeight: `${Math.max(26, duration(p) * 0.9)}px` }}
                        className={cn(
                          'flex items-center justify-between rounded-lg border px-2.5 text-[12.5px]',
                          p.type === 'period' && 'bg-tag-blue/10',
                          p.type === 'break' && 'bg-tag-orange/10',
                          p.type === 'lunch' && 'bg-tag-green/10',
                          p.type === 'assembly' && 'bg-muted',
                        )}
                      >
                        <span className="truncate">{p.name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{p.startTime}–{p.endTime}</span>
                      </div>
                    ))}
                  </div>
                </Panel>
                <Panel title="Totals">
                  <dl className="grid gap-2 text-[13px]">
                    <div className="flex justify-between"><dt className="text-muted-foreground">Teaching periods per day</dt><dd className="tabular-nums">{totals.teaching}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">Teaching minutes per day</dt><dd className="tabular-nums">{totals.minutes}</dd></div>
                    <div className="flex justify-between"><dt className="text-muted-foreground">School day length</dt><dd className="tabular-nums">{Math.floor(totals.length / 60)}h {totals.length % 60}m</dd></div>
                  </dl>
                </Panel>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function minutesToTime(m: number) {
  const h = Math.floor(m / 60) % 24
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
