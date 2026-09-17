import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { EndEnrollmentRequest, MoveStudentRequest } from '@erp/contracts'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { useSectionOptions } from './use-section-options'

type FieldErrors = Record<string, string>

function issuesOf(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): FieldErrors {
  const found: FieldErrors = {}
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'form'
    if (!found[key]) found[key] = issue.message
  }
  return found
}

/** Move one student into another section of the year they are enrolled in. */
export function MoveSectionDialog({ open, onOpenChange, studentId, expectedVersion, academicYearId }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  studentId: string
  expectedVersion: number
  academicYearId: string | null
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const { options, isLoading: sectionsLoading } = useSectionOptions(academicYearId)
  const [sectionId, setSectionId] = useState('')
  const [rollNumber, setRollNumber] = useState('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  const move = useMutation({
    mutationFn: (body: Parameters<typeof api.students.move>[2]) => api.students.move(schoolId, studentId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      toast.success('Moved to the new section')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const parsed = MoveStudentRequest.safeParse({
      expectedVersion,
      sectionId,
      rollNumber: rollNumber.trim() === '' ? undefined : Number(rollNumber),
      reason: reason.trim(),
    })
    if (!parsed.success) {
      setErrors(issuesOf(parsed.error))
      return
    }
    setErrors({})
    move.mutate(parsed.data)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move to another section</DialogTitle>
          <DialogDescription>Pick the section this student joins. The old enrolment is kept for history.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Section</Label>
            <Select value={sectionId} onValueChange={setSectionId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Pick a section" /></SelectTrigger>
              <SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
            {!sectionsLoading && options.length === 0 && (
              <p className="text-[12px] text-muted-foreground">No other section is set up for this year, so there is nowhere to move this student yet.</p>
            )}
            {errors.sectionId && <p className="text-[12px] text-destructive">{errors.sectionId}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label>Roll number</Label>
            <Input value={rollNumber} inputMode="numeric" placeholder="Optional" onChange={(e) => setRollNumber(e.target.value)} />
            {errors.rollNumber && <p className="text-[12px] text-destructive">{errors.rollNumber}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label>Reason</Label>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this student moving?" />
            {errors.reason && <p className="text-[12px] text-destructive">{errors.reason}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={move.isPending} onClick={submit}>{move.isPending ? 'Moving…' : 'Move student'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** End the current enrolment: the student stops showing in the active roster. */
export function MarkLeftDialog({ open, onOpenChange, studentId, expectedVersion }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  studentId: string
  expectedVersion: number
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [leftOn, setLeftOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})

  const markLeft = useMutation({
    mutationFn: (body: Parameters<typeof api.students.leave>[2]) => api.students.leave(schoolId, studentId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      toast.success('Marked as left')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const parsed = EndEnrollmentRequest.safeParse({ expectedVersion, leftOn, reason: reason.trim() })
    if (!parsed.success) {
      setErrors(issuesOf(parsed.error))
      return
    }
    setErrors({})
    markLeft.mutate(parsed.data)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark as left</DialogTitle>
          <DialogDescription>The student stops showing in the active list. The record stays for history.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Last day</Label>
            <Input type="date" value={leftOn} onChange={(e) => setLeftOn(e.target.value)} />
            {errors.leftOn && <p className="text-[12px] text-destructive">{errors.leftOn}</p>}
          </div>
          <div className="grid gap-1.5">
            <Label>Reason</Label>
            <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Transferred to another school" />
            {errors.reason && <p className="text-[12px] text-destructive">{errors.reason}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={markLeft.isPending} onClick={submit}>{markLeft.isPending ? 'Saving…' : 'Mark as left'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
