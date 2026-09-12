import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import type { BellSchedule, Staff } from '@erp/shared'
import { api, type TimetableCell } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { Panel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { cn, fullName } from '@/lib/utils'

/** One absent teacher: their card row plus every period that needs an arrangement today. */
export function AbsentTeacherPanel({ staff, date, dayOfWeek, bell, reason, onReasonChange, onRemove, canEdit }: {
  staff: Staff
  date: string
  dayOfWeek: number
  bell?: BellSchedule
  reason: string
  onReasonChange: (v: string) => void
  onRemove: () => void
  canEdit: boolean
}) {
  const params = { staffId: staff.id, date }
  const { data: periods = [], isLoading } = useQuery({
    queryKey: qk.absentTeacherPeriods(params),
    queryFn: () => api.timetable.absentTeacherPeriods(params),
  })

  return (
    <Panel
      className="mb-3"
      title={
        <span className="flex items-center gap-2.5">
          <UserAvatar name={fullName(staff)} size="sm" />
          <span>{fullName(staff)}</span>
          <span className="text-[12.5px] font-normal text-muted-foreground">{periods.length} periods today</span>
        </span>
      }
      actions={
        <span className="flex items-center gap-2">
          <Input value={reason} onChange={(e) => onReasonChange(e.target.value)} placeholder="Reason" className="h-7 w-40 text-[12.5px]" disabled={!canEdit} />
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Remove teacher"><X /></Button>
        </span>
      }
      bodyClassName="px-0 pb-0"
    >
      {isLoading ? (
        <div className="grid gap-2 px-4 pb-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 rounded-lg" />)}</div>
      ) : periods.length === 0 ? (
        <p className="px-4 pb-4 text-[13px] text-muted-foreground">No periods on this day.</p>
      ) : (
        <table className="w-full border-separate border-spacing-0 text-[13.5px]">
          <thead>
            <tr className="text-left text-[12.5px] text-muted-foreground">
              <th className="h-8 border-y px-4 font-medium">Period</th>
              <th className="h-8 border-y border-l px-3 font-medium">Class</th>
              <th className="h-8 border-y border-l px-3 font-medium">Subject</th>
              <th className="h-8 border-y border-l px-3 font-medium">Arrangement</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => {
              const period = bell?.periods.find((x) => x.index === p.periodIndex)
              return (
                <tr key={p.id}>
                  <td className="h-12 border-b px-4">
                    <div className="font-medium">{period?.name ?? `Period ${p.periodIndex + 1}`}</div>
                    {period && <div className="text-[12px] tabular-nums text-muted-foreground">{period.startTime}–{period.endTime}</div>}
                  </td>
                  <td className="h-12 border-b border-l px-3"><Tag color={colorFor(p.sectionId)}>{p.grade?.name} - {p.section?.name}</Tag></td>
                  <td className="h-12 border-b border-l px-3"><Tag color={colorFor(p.subject?.code ?? p.subjectId)}>{p.subject?.name ?? 'Subject'}</Tag></td>
                  <td className="h-12 border-b border-l px-3">
                    <ArrangementCell row={p} date={date} dayOfWeek={dayOfWeek} absentStaffId={staff.id} reason={reason} canEdit={canEdit} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

function ArrangementCell({ row, date, dayOfWeek, absentStaffId, reason, canEdit }: {
  row: TimetableCell & { substitution?: { id: string; substituteStaffId?: string; notified: boolean } }
  date: string
  dayOfWeek: number
  absentStaffId: string
  reason: string
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const sub = row.substitution

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['timetable'] })
    qc.invalidateQueries({ queryKey: qk.substitutions(date) })
  }

  const remove = useMutation({
    mutationFn: (id: string) => api.timetable.removeSubstitution(id),
    onSuccess: () => { invalidate(); toast.success('Arrangement removed') },
    onError: (e: Error) => toast.error(e.message),
  })

  const add = useMutation({
    mutationFn: (substituteStaffId?: string) => api.timetable.addSubstitution({
      date, sectionId: row.sectionId, periodIndex: row.periodIndex, subjectId: row.subjectId,
      absentStaffId, substituteStaffId, reason: reason || undefined, notified: false,
    }),
    onSuccess: () => { invalidate(); setOpen(false); toast.success('Arrangement saved') },
    onError: (e: Error) => toast.error(e.message),
  })

  const picker = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {sub
          ? <Button variant="ghost" size="xs" disabled={!canEdit}>Change</Button>
          : (
            <button type="button" disabled={!canEdit} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
              <Plus className="size-3.5" /> Arrange
            </button>
          )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <FreeTeacherList
          dayOfWeek={dayOfWeek}
          periodIndex={row.periodIndex}
          subjectId={row.subjectId}
          subjectName={row.subject?.name ?? 'this subject'}
          date={date}
          onPick={(id) => add.mutate(id)}
          pending={add.isPending}
        />
      </PopoverContent>
    </Popover>
  )

  if (!sub) return picker

  return (
    <span className="flex items-center gap-2">
      <span className={cn('size-1.5 shrink-0 rounded-full', sub.notified ? 'bg-tag-green' : 'bg-tag-orange')} title={sub.notified ? 'Notified' : 'Pending'} />
      {sub.substituteStaffId
        ? <SubstituteName staffId={sub.substituteStaffId} />
        : <Tag>Free period</Tag>}
      {picker}
      {canEdit && <Button variant="ghost" size="icon-xs" onClick={() => remove.mutate(sub.id)} aria-label="Remove arrangement"><X /></Button>}
    </span>
  )
}

function SubstituteName({ staffId }: { staffId: string }) {
  const { data } = useQuery({ queryKey: qk.staffMember(staffId), queryFn: () => api.staff.get(staffId) })
  if (!data) return <span className="text-muted-foreground">…</span>
  return <span className="flex items-center gap-1.5 whitespace-nowrap"><UserAvatar name={fullName(data)} size="xs" />{fullName(data)}</span>
}

/** Free teachers for a slot, subject teachers first, plus "leave as free period". */
export function FreeTeacherList({ dayOfWeek, periodIndex, subjectId, subjectName, date, onPick, pending }: {
  dayOfWeek: number
  periodIndex: number
  subjectId: string
  subjectName: string
  date: string
  onPick: (staffId?: string) => void
  pending?: boolean
}) {
  const params = { dayOfWeek, periodIndex, subjectId, date }
  const { data = [], isLoading } = useQuery({ queryKey: qk.freeTeachers(params), queryFn: () => api.timetable.freeTeachers(params) })
  const teaches = data.filter((t) => t.teachesSubject)
  const others = data.filter((t) => !t.teachesSubject)

  return (
    <div className="max-h-80 overflow-auto scrollbar-thin py-1">
      {isLoading ? (
        <div className="grid gap-1.5 p-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-8 rounded-md" />)}</div>
      ) : (
        <>
          {teaches.length > 0 && <Group label={`Teaches ${subjectName}`} rows={teaches} onPick={onPick} pending={pending} />}
          {others.length > 0 && <Group label="Other free teachers" rows={others} onPick={onPick} pending={pending} />}
          {data.length === 0 && <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">Nobody is free in this period.</p>}
          <div className="mt-1 border-t pt-1">
            <button type="button" disabled={pending} onClick={() => onPick(undefined)} className="flex w-full items-center px-3 py-2 text-left text-[13px] text-muted-foreground hover:bg-accent disabled:opacity-50">
              Leave as free period
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Group({ label, rows, onPick, pending }: { label: string; rows: Array<Staff & { periodsPerWeek: number }>; onPick: (id: string) => void; pending?: boolean }) {
  return (
    <div>
      <div className="px-3 py-1.5 text-[11.5px] font-medium tracking-wide text-muted-foreground">{label}</div>
      {rows.map((t) => (
        <button key={t.id} type="button" disabled={pending} onClick={() => onPick(t.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent disabled:opacity-50">
          <UserAvatar name={fullName(t)} size="xs" />
          <span className="min-w-0 flex-1 truncate">{fullName(t)}</span>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">{t.periodsPerWeek}/week</span>
        </button>
      ))}
    </div>
  )
}
