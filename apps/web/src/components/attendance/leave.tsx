/**
 * Recording leave ahead of time, and cancelling it.
 *
 * Leave is a plan, not a mark: the register pre-selects "leave" for the days it covers and a mark
 * somebody saves still wins. The sheet checks itself against the same contract the server applies,
 * so the date rules show inline before anything is sent; the server still decides who may record
 * leave for whom, and whether it overlaps leave already on record.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { toast } from 'sonner'
import { StaffLeaveCreateRequest, StudentLeaveCreateRequest, type LeaveStatus, type PermissionKey } from '@erp/contracts'
import { describeAttendanceError } from '@/components/attendance/labels'
import { todayIso } from '@/components/attendance/month-chip'
import { Field, FORM_ERROR, validate, type FieldErrors, type FieldLabels } from '@/components/setup/field'
import { Tag } from '@/components/shared/tag'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'

export type LeaveKind = 'students' | 'staff'

/** One row of the leave list, whichever kind of person it is about. */
export interface LeaveRow {
  id: string
  version: number
  personId: string
  name: string
  /** The pupil's class or the staff member's designation. */
  sub?: string
  startsOn: string
  endsOn: string
  days: number
  reason?: string
  status: LeaveStatus
  recordedBy?: string
  allowedActions: readonly PermissionKey[]
}

export function LeaveStatusTag({ status }: { status: LeaveStatus }) {
  return status === 'active' ? <Tag color="blue">Active</Tag> : <Tag color="grey">Cancelled</Tag>
}

/** '2 Oct' or '2 Oct to 5 Oct'. */
export function leaveRange(startsOn: string, endsOn: string): string {
  return startsOn === endsOn ? formatDate(startsOn) : `${formatDate(startsOn)} to ${formatDate(endsOn)}`
}

/** A leave write changes the registers and the dashboard figures, so all three prefixes go. */
function useLeaveRefresh() {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'leave'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'attendance'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
  }
}

const LABELS: FieldLabels = {
  studentId: { label: 'pupil', kind: 'select' },
  staffId: { label: 'staff member', kind: 'select' },
  startsOn: { label: 'first day of leave', kind: 'date' },
  endsOn: { label: 'last day of leave', kind: 'date' },
  reason: 'reason',
}

interface PickedPerson { id: string; name: string; sub?: string }

/** Find one pupil or one staff member by name, through the same search the rest of the app uses. */
function PersonPicker({ kind, picked, onPick, onClear, error }: {
  kind: LeaveKind
  picked: PickedPerson | null
  onPick: (person: PickedPerson) => void
  onClear: () => void
  error?: string
}) {
  const { schoolId } = useSchoolContext()
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(timer)
  }, [text])

  const pupils = useQuery({
    queryKey: qk.studentSearch(schoolId, q),
    queryFn: () => api.students.search(schoolId, q),
    enabled: kind === 'students' && q.length >= 2,
  })
  const staff = useQuery({
    queryKey: qk.staffSearch(schoolId, q),
    queryFn: () => api.staff.search(schoolId, q),
    enabled: kind === 'staff' && q.length >= 2,
  })

  const results = useMemo<PickedPerson[]>(() => {
    if (kind === 'students') {
      return (pupils.data ?? [])
        .filter((pupil) => pupil.status === 'active')
        .slice(0, 8)
        .map((pupil) => ({
          id: pupil.id,
          name: [pupil.firstName, pupil.lastName].filter(Boolean).join(' '),
          sub: pupil.enrollment ? `${pupil.enrollment.grade.name} - ${pupil.enrollment.section.name}` : pupil.admissionNumber,
        }))
    }
    return (staff.data ?? []).slice(0, 8).map((person) => ({ id: person.id, name: person.displayName, sub: person.designation }))
  }, [kind, pupils.data, staff.data])
  const searching = kind === 'students' ? pupils.isLoading : staff.isLoading
  const noun = kind === 'students' ? 'pupil' : 'staff member'

  return (
    <Field label={kind === 'students' ? 'Pupil' : 'Staff member'} error={error}>
      {picked ? (
        <div className="flex h-9 w-full items-center gap-2 rounded-lg border px-3 text-[13.5px]">
          <span className="min-w-0 flex-1 truncate">{picked.name}</span>
          {picked.sub && <span className="shrink-0 text-[12px] text-muted-foreground">{picked.sub}</span>}
          <button type="button" aria-label={`Choose another ${noun}`} onClick={onClear} className="rounded p-0.5 text-muted-foreground hover:bg-muted"><X className="size-3.5" /></button>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={kind === 'students' ? 'Search pupils by name or admission number' : 'Search staff by name'}
              aria-label={kind === 'students' ? 'Search pupils' : 'Search staff'}
              aria-invalid={error ? true : undefined}
              className="pl-8"
              maxLength={100}
            />
          </div>
          {q.length >= 2 && (
            <div className="rounded-lg border bg-card">
              {searching ? <p className="px-3 py-2 text-[13px] text-muted-foreground">Searching…</p>
                : results.length === 0 ? <p className="px-3 py-2 text-[13px] text-muted-foreground">Nobody found.</p>
                  : results.map((person) => (
                    <button
                      key={person.id}
                      type="button"
                      onClick={() => { onPick(person); setText('') }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13.5px] hover:bg-accent"
                    >
                      <span className="truncate">{person.name}</span>
                      {person.sub && <span className="shrink-0 text-[12px] text-muted-foreground">{person.sub}</span>}
                    </button>
                  ))}
            </div>
          )}
        </div>
      )}
    </Field>
  )
}

export function RecordLeaveSheet({ kind, open, onOpenChange }: { kind: LeaveKind; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { schoolId } = useSchoolContext()
  const refresh = useLeaveRefresh()
  const [person, setPerson] = useState<PickedPerson | null>(null)
  const [startsOn, setStartsOn] = useState(todayIso())
  const [endsOn, setEndsOn] = useState(todayIso())
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  // Opening the sheet starts a fresh form.
  useEffect(() => {
    if (!open) return
    setPerson(null)
    setStartsOn(todayIso())
    setEndsOn(todayIso())
    setReason('')
    setErrors({})
  }, [open])

  const save = useMutation({
    mutationFn: async (body: { personId: string; startsOn: string; endsOn: string; reason?: string }): Promise<unknown> => {
      const { personId, ...dates } = body
      return kind === 'students'
        ? api.leave.createStudent(schoolId, { studentId: personId, ...dates })
        : api.leave.createStaff(schoolId, { staffId: personId, ...dates })
    },
    onSuccess: () => {
      refresh()
      toast.success('Leave recorded')
      onOpenChange(false)
    },
    onError: (failure) => {
      const message = describeAttendanceError(failure)
      setErrors({ [FORM_ERROR]: message })
      toast.error(message)
    },
  })

  const submit = () => {
    const text = reason.trim()
    const dates = { startsOn, endsOn, ...(text ? { reason: text } : {}) }
    const checked = kind === 'students'
      ? validate(StudentLeaveCreateRequest, { studentId: person?.id ?? '', ...dates }, LABELS)
      : validate(StaffLeaveCreateRequest, { staffId: person?.id ?? '', ...dates }, LABELS)
    if (!checked.ok || !person) {
      setErrors(checked.ok ? {} : checked.errors)
      return
    }
    setErrors({})
    save.mutate({ personId: person.id, ...dates })
  }

  const personError = kind === 'students' ? errors.studentId : errors.staffId

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Record leave</SheetTitle>
          <SheetDescription>
            {kind === 'students'
              ? "The class register shows these days as leave already chosen. A mark the teacher saves still counts."
              : 'The staff register shows these days as leave already chosen. A mark the office saves still counts.'}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
          <PersonPicker kind={kind} picked={person} onPick={setPerson} onClear={() => setPerson(null)} error={personError} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="From" error={errors.startsOn}>
              <Input type="date" aria-label="From" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
            </Field>
            <Field label="To" error={errors.endsOn}>
              <Input type="date" aria-label="To" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
            </Field>
          </div>
          <Field label="Reason (optional)" error={errors.reason}>
            <Textarea aria-label="Reason" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {errors[FORM_ERROR] && <p role="alert" className="text-[12px] text-tag-red">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Record leave'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** Cancelling keeps the record on file; the reason, when given, goes to the audit note. */
export function CancelLeaveDialog({ kind, row, onOpenChange }: { kind: LeaveKind; row: LeaveRow | null; onOpenChange: (open: boolean) => void }) {
  const { schoolId } = useSchoolContext()
  const refresh = useLeaveRefresh()
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (row) setReason('')
  }, [row])

  const cancel = useMutation({
    mutationFn: async (target: LeaveRow): Promise<unknown> => {
      const text = reason.trim()
      const body = { expectedVersion: target.version, ...(text ? { reason: text } : {}) }
      return kind === 'students' ? api.leave.cancelStudent(schoolId, target.id, body) : api.leave.cancelStaff(schoolId, target.id, body)
    },
    onSuccess: () => {
      refresh()
      toast.success('Leave cancelled')
      onOpenChange(false)
    },
    onError: (failure) => toast.error(describeAttendanceError(failure)),
  })

  return (
    <AlertDialog open={row !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this leave?</AlertDialogTitle>
          <AlertDialogDescription>
            {row ? `${row.name}, ${leaveRange(row.startsOn, row.endsOn)}. ` : ''}
            The register stops choosing leave for these days. The record stays on file as cancelled.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <label htmlFor="leave-cancel-reason" className="text-[12px] text-muted-foreground">Reason (optional)</label>
          <Textarea id="leave-cancel-reason" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep leave</AlertDialogCancel>
          <Button disabled={cancel.isPending || !row} onClick={() => { if (row) cancel.mutate(row) }}>Cancel leave</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
