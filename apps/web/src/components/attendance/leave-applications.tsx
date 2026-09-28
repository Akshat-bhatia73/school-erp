/**
 * Applying for leave, deciding it and withdrawing it.
 *
 * A parent applies for their own child and a staff member for themselves; the class teacher or the
 * office decides a pupil's application, the office a staff member's. The screen offers an action
 * only where the server's `allowedActions` carries it: `leave_applications.decide` on a waiting
 * application the caller may decide, `leave_applications.apply` on one the caller may withdraw.
 * The sheet checks itself against the same contract the server applies, so the date rules and the
 * required reason show inline before anything is sent.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  LEAVE_APPLICATION_STATUS_LABELS,
  LEAVE_APPLY_DAYS_BACK,
  LEAVE_TYPE_LABELS,
  LeaveApplicationDecideRequest,
  StaffLeaveApplyRequest,
  StudentLeaveApplyRequest,
  type LeaveApplicationStatus,
  type LeaveType,
  type PermissionKey,
} from '@erp/contracts'
import { describeAttendanceError, REASON_TEXT } from '@/components/attendance/labels'
import { leaveRange, useLeaveRefresh, type LeaveKind } from '@/components/attendance/leave'
import { shiftDate, todayIso } from '@/components/attendance/month-chip'
import { Field, FORM_ERROR, validate, type FieldErrors, type FieldLabels } from '@/components/setup/field'
import { Tag, type TagColor } from '@/components/shared/tag'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { isApiError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn, fullName } from '@/lib/utils'

/** One application in a list, whichever kind of person it is about. */
export interface ApplicationRow {
  id: string
  kind: LeaveKind
  version: number
  personId: string
  name: string
  /** The pupil's class or the staff member's designation. */
  sub?: string
  startsOn: string
  endsOn: string
  days: number
  /** Staff applications only. */
  leaveType?: LeaveType
  reason: string
  status: LeaveApplicationStatus
  appliedAt: string
  appliedBy?: string
  mine: boolean
  decidedAt?: string
  decidedBy?: string
  decisionNote?: string
  allowedActions: readonly PermissionKey[]
}

const STATUS_COLOR: Record<LeaveApplicationStatus, TagColor> = {
  pending: 'orange',
  approved: 'green',
  refused: 'red',
  withdrawn: 'grey',
}

export function ApplicationStatusTag({ status }: { status: LeaveApplicationStatus }) {
  return <Tag color={STATUS_COLOR[status]}>{LEAVE_APPLICATION_STATUS_LABELS[status]}</Tag>
}

export const STATUS_OPTIONS: Array<{ value: LeaveApplicationStatus; label: string }> = (
  ['pending', 'approved', 'refused', 'withdrawn'] as const
).map((value) => ({ value, label: LEAVE_APPLICATION_STATUS_LABELS[value] }))

export const canDecide = (row: ApplicationRow) => row.status === 'pending' && row.allowedActions.includes('leave_applications.decide')
export const canWithdraw = (row: ApplicationRow) => row.status === 'pending' && row.allowedActions.includes('leave_applications.apply')

const HELP_DAYS_BACK = `Leave can start up to ${LEAVE_APPLY_DAYS_BACK} days ago. For older days, ask the office.`

const LABELS: FieldLabels = {
  studentId: { label: 'child', kind: 'select' },
  leaveType: { label: 'type of leave', kind: 'select' },
  startsOn: { label: 'first day of leave', kind: 'date' },
  endsOn: { label: 'last day of leave', kind: 'date' },
  reason: 'reason',
}

/** The children this parent can read, for the picker; one child means no picker at all. */
function useChildren(enabled: boolean) {
  const { schoolId } = useSchoolContext()
  const params = { status: 'active' as const, pageSize: 50 }
  return useQuery({
    queryKey: qk.students(schoolId, params),
    queryFn: () => api.students.list(schoolId, params),
    enabled,
  })
}

/**
 * The apply sheet. `students` is a parent applying for one of their children; `staff` is a staff
 * member applying for themselves, so there is nobody to pick.
 */
export function ApplyLeaveSheet({ kind, open, onOpenChange }: { kind: LeaveKind; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { schoolId } = useSchoolContext()
  const refresh = useLeaveRefresh()
  const children = useChildren(open && kind === 'students')
  const childList = children.data?.items ?? []
  const [studentId, setStudentId] = useState('')
  const [leaveType, setLeaveType] = useState<LeaveType | ''>('')
  const [startsOn, setStartsOn] = useState(todayIso())
  const [endsOn, setEndsOn] = useState(todayIso())
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  // Opening the sheet starts a fresh form.
  useEffect(() => {
    if (!open) return
    setStudentId('')
    setLeaveType('')
    setStartsOn(todayIso())
    setEndsOn(todayIso())
    setReason('')
    setErrors({})
  }, [open])

  // With one child there is nothing to choose.
  const onlyChild = childList.length === 1 ? childList[0] : undefined
  const chosenStudent = onlyChild?.id ?? studentId

  const save = useMutation({
    mutationFn: async (body: { startsOn: string; endsOn: string; reason: string }): Promise<unknown> => (
      kind === 'students'
        ? api.leave.applications.pupils.apply(schoolId, { studentId: chosenStudent, ...body })
        : api.leave.applications.staff.apply(schoolId, { leaveType: leaveType as LeaveType, ...body })
    ),
    onSuccess: () => {
      refresh()
      toast.success('Leave applied for')
      onOpenChange(false)
    },
    onError: (failure) => {
      const message = describeAttendanceError(failure)
      // The day-limit refusal belongs to the first day; anything else to the whole form.
      const onStart = isApiError(failure) && failure.reason === 'leave_application_too_far_back'
      setErrors(onStart ? { startsOn: message } : { [FORM_ERROR]: message })
      toast.error(message)
    },
  })

  const submit = () => {
    const body = { startsOn, endsOn, reason: reason.trim() }
    const checked = kind === 'students'
      ? validate(StudentLeaveApplyRequest, { studentId: chosenStudent, ...body }, LABELS)
      : validate(StaffLeaveApplyRequest, { leaveType: leaveType || undefined, ...body }, LABELS)
    const found: FieldErrors = checked.ok ? {} : { ...checked.errors }
    // The server counts back from today in the school's timezone; this is the same rule, early.
    if (!found.startsOn && startsOn && startsOn < shiftDate(todayIso(), -LEAVE_APPLY_DAYS_BACK)) {
      found.startsOn = REASON_TEXT.leave_application_too_far_back ?? HELP_DAYS_BACK
    }
    if (Object.keys(found).length > 0) {
      setErrors(found)
      return
    }
    setErrors({})
    save.mutate(body)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Apply for leave</SheetTitle>
          <SheetDescription>
            {kind === 'students'
              ? 'The class teacher or the office decides, and you get a message with the answer.'
              : 'The office decides, and you get a message with the answer.'}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
          {kind === 'students' && (
            onlyChild ? (
              <Field label="Child">
                <div className="flex h-9 items-center rounded-lg border px-3 text-[13.5px]">{fullName(onlyChild)}</div>
              </Field>
            ) : (
              <Field label="Child" error={errors.studentId}>
                {children.isLoading ? (
                  <p className="text-[13px] text-muted-foreground">Loading your children…</p>
                ) : childList.length === 0 ? (
                  <p className="text-[13px] text-muted-foreground">No child of yours is enrolled right now.</p>
                ) : (
                  <div role="radiogroup" aria-label="Child" className="flex flex-wrap gap-2">
                    {childList.map((child) => (
                      <ChoiceButton key={child.id} checked={studentId === child.id} onClick={() => setStudentId(child.id)}>
                        {fullName(child)}
                      </ChoiceButton>
                    ))}
                  </div>
                )}
              </Field>
            )
          )}
          {kind === 'staff' && (
            <Field label="Type of leave" error={errors.leaveType}>
              <div role="radiogroup" aria-label="Type of leave" className="flex flex-wrap gap-2">
                {(Object.keys(LEAVE_TYPE_LABELS) as LeaveType[]).map((type) => (
                  <ChoiceButton key={type} checked={leaveType === type} onClick={() => setLeaveType(type)}>
                    {LEAVE_TYPE_LABELS[type]}
                  </ChoiceButton>
                ))}
              </div>
            </Field>
          )}
          <div className="space-y-1.5">
            <div className="grid grid-cols-2 gap-3">
              <Field label="From" error={errors.startsOn}>
                <Input type="date" aria-label="From" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
              </Field>
              <Field label="To" error={errors.endsOn}>
                <Input type="date" aria-label="To" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
              </Field>
            </div>
            <p className="text-[12px] text-muted-foreground">{HELP_DAYS_BACK}</p>
          </div>
          <Field label="Reason" error={errors.reason}>
            <Textarea aria-label="Reason" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {errors[FORM_ERROR] && <p role="alert" className="text-[12px] text-tag-red">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Sending…' : 'Apply for leave'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function ChoiceButton({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center rounded-lg border px-3 text-[13px] hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        checked && 'border-foreground bg-accent font-medium',
      )}
    >
      {children}
    </button>
  )
}

export type Decision = 'approve' | 'refuse'

/** Approve with an optional note, or say why not: the applicant reads the note. */
export function DecideLeaveDialog({ target, onOpenChange }: {
  target: { row: ApplicationRow; decision: Decision } | null
  onOpenChange: (open: boolean) => void
}) {
  const { schoolId } = useSchoolContext()
  const refresh = useLeaveRefresh()
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (target) {
      setNote('')
      setError(null)
    }
  }, [target])

  const decide = useMutation({
    mutationFn: async (body: { row: ApplicationRow; decision: Decision; note?: string }): Promise<unknown> => {
      const payload = { expectedVersion: body.row.version, decision: body.decision, ...(body.note ? { note: body.note } : {}) }
      return body.row.kind === 'students'
        ? api.leave.applications.pupils.decide(schoolId, body.row.id, payload)
        : api.leave.applications.staff.decide(schoolId, body.row.id, payload)
    },
    onSuccess: (_result, body) => {
      refresh()
      toast.success(body.decision === 'approve' ? 'Leave approved' : 'Leave not approved')
      onOpenChange(false)
    },
    onError: (failure) => {
      const message = describeAttendanceError(failure)
      setError(message)
      toast.error(message)
      // Somebody else decided first: the list shows the answer they gave.
      if (isApiError(failure) && failure.reason === 'leave_application_not_pending') refresh()
    },
  })

  const submit = () => {
    if (!target) return
    const text = note.trim()
    const checked = LeaveApplicationDecideRequest.safeParse({
      expectedVersion: target.row.version,
      decision: target.decision,
      ...(text ? { note: text } : {}),
    })
    if (!checked.success) {
      setError('Say why the leave is not approved')
      return
    }
    setError(null)
    decide.mutate({ row: target.row, decision: target.decision, ...(text ? { note: text } : {}) })
  }

  const approving = target?.decision === 'approve'
  return (
    <AlertDialog open={target !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{approving ? 'Approve this leave?' : 'Why is this leave not approved?'}</AlertDialogTitle>
          <AlertDialogDescription>
            {target ? `${target.row.name}, ${leaveRange(target.row.startsOn, target.row.endsOn)}. ` : ''}
            {approving
              ? 'The register shows these days as leave already chosen. Whoever applied gets a message.'
              : 'Whoever applied gets a message with your note.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <label htmlFor="leave-decision-note" className="text-[12px] text-muted-foreground">
            {approving ? 'Note (optional)' : 'Note'}
          </label>
          <Textarea
            id="leave-decision-note"
            rows={3}
            maxLength={500}
            value={note}
            aria-invalid={error ? true : undefined}
            onChange={(event) => setNote(event.target.value)}
          />
          {error && <p role="alert" className="text-[12px] text-tag-red">{error}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Go back</AlertDialogCancel>
          <Button
            variant={approving ? 'default' : 'destructive'}
            disabled={decide.isPending || !target}
            onClick={submit}
          >
            {approving ? 'Approve leave' : 'Save as not approved'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Only the person who applied withdraws, and only while it waits. */
export function WithdrawLeaveDialog({ row, onOpenChange }: { row: ApplicationRow | null; onOpenChange: (open: boolean) => void }) {
  const { schoolId } = useSchoolContext()
  const refresh = useLeaveRefresh()

  const withdraw = useMutation({
    mutationFn: async (target: ApplicationRow): Promise<unknown> => {
      const body = { expectedVersion: target.version }
      return target.kind === 'students'
        ? api.leave.applications.pupils.withdraw(schoolId, target.id, body)
        : api.leave.applications.staff.withdraw(schoolId, target.id, body)
    },
    onSuccess: () => {
      refresh()
      toast.success('Application withdrawn')
      onOpenChange(false)
    },
    onError: (failure) => toast.error(describeAttendanceError(failure)),
  })

  return (
    <AlertDialog open={row !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Withdraw this application?</AlertDialogTitle>
          <AlertDialogDescription>
            {row ? `${row.name}, ${leaveRange(row.startsOn, row.endsOn)}. ` : ''}
            Nobody will decide it. You can apply again later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <Button disabled={withdraw.isPending || !row} onClick={() => { if (row) withdraw.mutate(row) }}>Withdraw</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
