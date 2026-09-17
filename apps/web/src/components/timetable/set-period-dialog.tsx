import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { TimetableEntryRequest } from '@erp/contracts'
import { api } from '@/lib/api'
import type { TimetableCellRecord } from '@/lib/api/timetable'
import { describeError } from '@/lib/api-errors'
import { UserAvatar } from '@/components/shared/avatar'
import { Tag, colorFor } from '@/components/shared/tag'
import { DAY_LABELS } from '@/components/timetable/day-selector'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export interface SetPeriodTarget { dayOfWeek: number; periodIndex: number; existing?: TimetableCellRecord; periodName: string }

export interface SubjectChoice { id: string; name: string }

/** "Set period" dialog: pick the subject, then a free teacher for that slot. */
export function SetPeriodDialog({ target, onClose, sectionId, sectionLabel, subjects, academicYearId }: {
  target: SetPeriodTarget | null
  onClose: () => void
  sectionId: string
  sectionLabel: string
  subjects: SubjectChoice[]
  academicYearId: string
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [subjectId, setSubjectId] = useState('')
  const [staffId, setStaffId] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)

  useEffect(() => {
    if (target) {
      setSubjectId(target.existing?.subject.id ?? '')
      setStaffId(target.existing?.teacher?.id ?? '')
      setFieldError(null)
    }
  }, [target])

  const freeParams = {
    academicYearId,
    dayOfWeek: target?.dayOfWeek ?? 1,
    periodIndex: target?.periodIndex ?? 0,
    subjectId: subjectId || undefined,
  }
  const { data: free = [], isLoading: freeLoading } = useQuery({
    queryKey: qk.freeTeachers(schoolId, freeParams),
    queryFn: () => api.timetable.freeTeachers(schoolId, freeParams),
    enabled: !!target && !!academicYearId,
  })

  const existingTeacher = target?.existing?.teacher ?? null
  const teaches = free.filter((t) => t.teachesSubject)
  const others = free.filter((t) => !t.teachesSubject)
  const keepsCurrent = useMemo(
    () => !!existingTeacher && !free.some((t) => t.teacher.id === existingTeacher.id),
    [existingTeacher, free],
  )

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'timetable'] })
  }

  const save = useMutation({
    mutationFn: () => {
      const parsed = TimetableEntryRequest.safeParse({
        academicYearId,
        sectionId,
        dayOfWeek: target?.dayOfWeek,
        periodIndex: target?.periodIndex,
        subjectId,
        ...(staffId ? { staffId } : {}),
      })
      if (!parsed.success) {
        setFieldError('Pick a subject for this period.')
        return Promise.reject(new Error('invalid'))
      }
      setFieldError(null)
      return api.timetable.setEntry(schoolId, parsed.data)
    },
    onSuccess: () => { invalidate(); toast.success('Saved this period'); onClose() },
    onError: (error) => { if (error instanceof Error && error.message === 'invalid') return; toast.error(describeError(error)) },
  })

  const clear = useMutation({
    mutationFn: () => api.timetable.clearEntry(schoolId, {
      academicYearId,
      sectionId,
      dayOfWeek: target!.dayOfWeek,
      periodIndex: target!.periodIndex,
    }),
    onSuccess: () => { invalidate(); toast.success('Cleared this period'); onClose() },
    onError: (error) => toast.error(describeError(error)),
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
              <Select value={subjectId} onValueChange={(v) => { setSubjectId(v); setStaffId(''); setFieldError(null) }}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Pick a subject" /></SelectTrigger>
                <SelectContent>
                  {subjects.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2"><Tag color={colorFor(s.id)}>{s.name}</Tag></span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldError && <p className="text-[11.5px] text-destructive">{fieldError}</p>}
            </div>
            <div className="grid gap-1.5">
              <label className="text-[12px] text-muted-foreground">Teacher</label>
              {freeLoading ? <Skeleton className="h-9 rounded-lg" /> : (
                <Select value={staffId} onValueChange={setStaffId} disabled={!subjectId}>
                  <SelectTrigger className="w-full"><SelectValue placeholder={subjectId ? 'Pick a teacher' : 'Pick a subject first'} /></SelectTrigger>
                  <SelectContent>
                    {keepsCurrent && existingTeacher && (
                      <SelectGroup>
                        <SelectLabel>Currently assigned</SelectLabel>
                        <SelectItem value={existingTeacher.id}>
                          <span className="flex items-center gap-2"><UserAvatar name={existingTeacher.name} size="xs" />{existingTeacher.name}</span>
                        </SelectItem>
                      </SelectGroup>
                    )}
                    {teaches.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Teaches this subject</SelectLabel>
                        {teaches.map((t) => (
                          <SelectItem key={t.teacher.id} value={t.teacher.id}>
                            <span className="flex items-center gap-2"><UserAvatar name={t.teacher.name} size="xs" />{t.teacher.name}<span className="text-[11.5px] text-muted-foreground">{t.periodsPerWeek}/week</span></span>
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {others.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Other free teachers</SelectLabel>
                        {others.map((t) => (
                          <SelectItem key={t.teacher.id} value={t.teacher.id}>
                            <span className="flex items-center gap-2"><UserAvatar name={t.teacher.name} size="xs" />{t.teacher.name}<span className="text-[11.5px] text-muted-foreground">{t.periodsPerWeek}/week</span></span>
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
