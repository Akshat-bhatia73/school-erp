import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { TimetableSubstitutionRequest } from '@erp/contracts'
import { api } from '@/lib/api'
import type { BellScheduleRecord, SubstitutionRecord, TimetableCellRecord } from '@/lib/api/timetable'
import { describeError } from '@/lib/api-errors'
import { UserAvatar } from '@/components/shared/avatar'
import { Panel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { periodNameFor } from '@/components/timetable/timetable-grid'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn } from '@/lib/utils'

export interface AbsentTeacherPanelProps {
  staffId: string
  staffName: string
  date: string
  /** 1–6; 0 when the date is a Sunday, in which case nothing is taught. */
  dayOfWeek: number
  academicYearId: string
  bell?: BellScheduleRecord
  /** Today's arrangements for this teacher, from the day query. */
  substitutions: SubstitutionRecord[]
  reason: string
  onReasonChange: (v: string) => void
  onRemove: () => void
  canEdit: boolean
}

/** One absent teacher: their card row plus every period that needs an arrangement today. */
export function AbsentTeacherPanel({ staffId, staffName, date, dayOfWeek, academicYearId, bell, substitutions, reason, onReasonChange, onRemove, canEdit }: AbsentTeacherPanelProps) {
  const { schoolId } = useSchoolContext()
  const params = { staffId, date }
  const { data: periods = [], isLoading } = useQuery({
    queryKey: qk.absentPeriods(schoolId, params),
    queryFn: () => api.timetable.absentPeriods(schoolId, params),
    enabled: canEdit,
  })

  return (
    <Panel
      className="mb-3"
      title={
        <span className="flex items-center gap-2.5">
          <UserAvatar name={staffName} size="sm" />
          <span>{staffName}</span>
          <span className="text-[12.5px] font-normal text-muted-foreground">{periods.length} periods today</span>
        </span>
      }
      actions={
        <span className="flex items-center gap-2">
          <Input value={reason} onChange={(e) => onReasonChange(e.target.value)} placeholder="Reason" aria-label={`Reason for ${staffName}`} className="h-7 w-40 text-[12.5px]" />
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
              const existing = substitutions.find((s) => s.section.id === p.section.id && s.periodIndex === p.periodIndex)
              return (
                <tr key={`${p.section.id}|${p.periodIndex}`}>
                  <td className="h-12 border-b px-4">
                    <div className="font-medium">{periodNameFor(bell, p.periodIndex)}</div>
                    {period && <div className="text-[12px] tabular-nums text-muted-foreground">{period.startTime}–{period.endTime}</div>}
                  </td>
                  <td className="h-12 border-b border-l px-3"><Tag color={colorFor(p.section.id)}>{p.section.name}</Tag></td>
                  <td className="h-12 border-b border-l px-3"><Tag color={colorFor(p.subject.id)}>{p.subject.name}</Tag></td>
                  <td className="h-12 border-b border-l px-3">
                    <ArrangementCell
                      cell={p}
                      existing={existing}
                      date={date}
                      dayOfWeek={dayOfWeek}
                      academicYearId={academicYearId}
                      absentStaffId={staffId}
                      reason={reason}
                    />
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

function ArrangementCell({ cell, existing, date, dayOfWeek, academicYearId, absentStaffId, reason }: {
  cell: TimetableCellRecord
  existing?: SubstitutionRecord
  date: string
  dayOfWeek: number
  academicYearId: string
  absentStaffId: string
  reason: string
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'timetable'] })
  }

  const remove = useMutation({
    mutationFn: (id: string) => api.timetable.deleteSubstitution(schoolId, id),
    onSuccess: () => { invalidate(); toast.success('Removed the arrangement') },
    onError: (error) => toast.error(describeError(error)),
  })

  const add = useMutation({
    mutationFn: (substituteStaffId?: string) => {
      const parsed = TimetableSubstitutionRequest.safeParse({
        date,
        sectionId: cell.section.id,
        periodIndex: cell.periodIndex,
        subjectId: cell.subject.id,
        absentStaffId,
        ...(substituteStaffId ? { substituteStaffId } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      })
      if (!parsed.success) return Promise.reject(new Error('invalid'))
      // One arrangement per class and period on a day, so changing the substitute
      // means dropping the current one first; the server refuses a second insert.
      const create = () => api.timetable.createSubstitution(schoolId, parsed.data)
      return existing ? api.timetable.deleteSubstitution(schoolId, existing.id).then(create) : create()
    },
    onSuccess: () => { invalidate(); setOpen(false); toast.success('Saved the arrangement') },
    onError: (error) => toast.error(describeError(error)),
  })

  const picker = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {existing
          ? <Button variant="ghost" size="xs">Change</Button>
          : (
            <button type="button" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-dashed px-2 text-[12.5px] text-muted-foreground hover:bg-accent hover:text-foreground">
              <Plus className="size-3.5" /> Arrange
            </button>
          )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <FreeTeacherList
          academicYearId={academicYearId}
          dayOfWeek={dayOfWeek}
          periodIndex={cell.periodIndex}
          subjectId={cell.subject.id}
          subjectName={cell.subject.name}
          onPick={(id) => add.mutate(id)}
          pending={add.isPending}
        />
      </PopoverContent>
    </Popover>
  )

  if (!existing) return picker

  return (
    <span className="flex items-center gap-2">
      <span className={cn('size-1.5 shrink-0 rounded-full', existing.notified ? 'bg-tag-green' : 'bg-tag-orange')} title={existing.notified ? 'Notified' : 'Pending'} />
      {existing.substituteTeacher
        ? <span className="flex items-center gap-1.5 whitespace-nowrap"><UserAvatar name={existing.substituteTeacher.name} size="xs" />{existing.substituteTeacher.name}</span>
        : <Tag>Free period</Tag>}
      {picker}
      <Button variant="ghost" size="icon-xs" onClick={() => remove.mutate(existing.id)} aria-label="Remove arrangement"><X /></Button>
    </span>
  )
}

/** Free teachers for a slot, subject teachers first, plus "leave as free period". */
export function FreeTeacherList({ academicYearId, dayOfWeek, periodIndex, subjectId, subjectName, onPick, pending }: {
  academicYearId: string
  dayOfWeek: number
  periodIndex: number
  subjectId: string
  subjectName: string
  onPick: (staffId?: string) => void
  pending?: boolean
}) {
  const { schoolId } = useSchoolContext()
  const params = { academicYearId, dayOfWeek, periodIndex, subjectId }
  const { data = [], isLoading } = useQuery({
    queryKey: qk.freeTeachers(schoolId, params),
    queryFn: () => api.timetable.freeTeachers(schoolId, params),
    enabled: dayOfWeek >= 1 && dayOfWeek <= 6 && !!academicYearId,
  })
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

function Group({ label, rows, onPick, pending }: {
  label: string
  rows: Array<{ teacher: { id: string; name: string }; periodsPerWeek: number }>
  onPick: (id: string) => void
  pending?: boolean
}) {
  return (
    <div>
      <div className="px-3 py-1.5 text-[11.5px] font-medium tracking-wide text-muted-foreground">{label}</div>
      {rows.map((t) => (
        <button key={t.teacher.id} type="button" disabled={pending} onClick={() => onPick(t.teacher.id)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-accent disabled:opacity-50">
          <UserAvatar name={t.teacher.name} size="xs" />
          <span className="min-w-0 flex-1 truncate">{t.teacher.name}</span>
          <span className="text-[11.5px] tabular-nums text-muted-foreground">{t.periodsPerWeek}/week</span>
        </button>
      ))}
    </div>
  )
}
