import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { Subject } from '@erp/shared'
import { DAY_LABELS } from '@erp/shared'
import { api, type TimetableCell } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { Tag, colorFor } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { fullName } from '@/lib/utils'

export interface SetPeriodTarget { dayOfWeek: number; periodIndex: number; existing?: TimetableCell; periodName: string }

/** "Set period" dialog: pick the subject, then a free teacher for that slot. */
export function SetPeriodDialog({ target, onClose, sectionId, sectionLabel, subjects }: {
  target: SetPeriodTarget | null
  onClose: () => void
  sectionId: string
  sectionLabel: string
  subjects: Subject[]
}) {
  const qc = useQueryClient()
  const [subjectId, setSubjectId] = useState('')
  const [staffId, setStaffId] = useState('')

  useEffect(() => {
    if (target) { setSubjectId(target.existing?.subjectId ?? ''); setStaffId(target.existing?.staffId ?? '') }
  }, [target])

  const freeParams = { dayOfWeek: target?.dayOfWeek ?? 0, periodIndex: target?.periodIndex ?? 0, subjectId: subjectId || undefined }
  const { data: free = [], isLoading: freeLoading } = useQuery({
    queryKey: qk.freeTeachers(freeParams),
    queryFn: () => api.timetable.freeTeachers(freeParams),
    enabled: !!target,
  })

  const existingStaff = target?.existing?.staff
  const teaches = free.filter((t) => t.teachesSubject)
  const others = free.filter((t) => !t.teachesSubject)
  const keepsCurrent = useMemo(() => !!existingStaff && !free.some((t) => t.id === existingStaff.id), [existingStaff, free])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['timetable'] })
    qc.invalidateQueries({ queryKey: ['substitutions'] })
  }

  const save = useMutation({
    mutationFn: () => api.timetable.setEntry({ sectionId, dayOfWeek: target!.dayOfWeek, periodIndex: target!.periodIndex, subjectId, staffId: staffId || undefined }),
    onSuccess: () => { invalidate(); toast.success('Period saved'); onClose() },
    onError: (e: Error) => toast.error(e.message),
  })

  const clear = useMutation({
    mutationFn: () => api.timetable.clearEntry({ sectionId, dayOfWeek: target!.dayOfWeek, periodIndex: target!.periodIndex }),
    onSuccess: () => { invalidate(); toast.success('Period cleared'); onClose() },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <Dialog open={!!target} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set period</DialogTitle>
        </DialogHeader>
        {target && (
          <div className="grid gap-3">
            <p className="text-[12.5px] text-muted-foreground">{sectionLabel} · {DAY_LABELS[target.dayOfWeek]} · {target.periodName}</p>
            <div className="grid gap-1.5">
              <label className="text-[12px] text-muted-foreground">Subject</label>
              <Select value={subjectId} onValueChange={(v) => { setSubjectId(v); setStaffId('') }}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Pick a subject" /></SelectTrigger>
                <SelectContent>
                  {subjects.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2"><Tag color={colorFor(s.code)}>{s.code}</Tag>{s.name}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <label className="text-[12px] text-muted-foreground">Teacher</label>
              {freeLoading ? <Skeleton className="h-9 rounded-lg" /> : (
                <Select value={staffId} onValueChange={setStaffId} disabled={!subjectId}>
                  <SelectTrigger className="w-full"><SelectValue placeholder={subjectId ? 'Pick a teacher' : 'Pick a subject first'} /></SelectTrigger>
                  <SelectContent>
                    {keepsCurrent && existingStaff && (
                      <SelectGroup>
                        <SelectLabel>Currently assigned</SelectLabel>
                        <SelectItem value={existingStaff.id}>
                          <span className="flex items-center gap-2"><UserAvatar name={fullName(existingStaff)} size="xs" />{fullName(existingStaff)}</span>
                        </SelectItem>
                      </SelectGroup>
                    )}
                    {teaches.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Teaches this subject</SelectLabel>
                        {teaches.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            <span className="flex items-center gap-2"><UserAvatar name={fullName(t)} size="xs" />{fullName(t)}<span className="text-[11.5px] text-muted-foreground">{t.periodsPerWeek}/week</span></span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {others.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Other free teachers</SelectLabel>
                        {others.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            <span className="flex items-center gap-2"><UserAvatar name={fullName(t)} size="xs" />{fullName(t)}<span className="text-[11.5px] text-muted-foreground">{t.periodsPerWeek}/week</span></span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>
        )}
        <DialogFooter className="sm:justify-between">
          {target?.existing
            ? <Button variant="outline" size="sm" onClick={() => clear.mutate()} disabled={clear.isPending}>Clear</Button>
            : <span />}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={!subjectId || save.isPending}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
