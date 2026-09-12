import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { qk } from '@/lib/query'

function useCurrentYear() {
  return useQuery({ queryKey: [...qk.academicYears, 'current'], queryFn: () => api.academicYears.current() })
}

/** Move one or many students into another section */
export function MoveSectionDialog({ open, onOpenChange, studentIds, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; studentIds: string[]; onDone?: () => void }) {
  const qc = useQueryClient()
  const { data: year } = useCurrentYear()
  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const [gradeId, setGradeId] = useState<string>('')
  const [sectionId, setSectionId] = useState<string>('')
  const [rollNumber, setRollNumber] = useState('')
  const [error, setError] = useState<string>()
  const { data: sections = [] } = useQuery({
    queryKey: qk.sections({ academicYearId: year?.id, gradeId }),
    queryFn: () => api.sections.list({ academicYearId: year?.id, gradeId }),
    enabled: !!gradeId,
  })

  const move = useMutation({
    mutationFn: async () => {
      for (const id of studentIds) await api.students.move(id, { sectionId, rollNumber: studentIds.length === 1 && rollNumber ? Number(rollNumber) : undefined })
    },
    onSuccess: () => {
      toast.success(studentIds.length === 1 ? 'Student moved' : `${studentIds.length} students moved`)
      qc.invalidateQueries()
      onOpenChange(false)
      onDone?.()
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move section</DialogTitle>
          <DialogDescription>{studentIds.length === 1 ? 'Pick the class and section to move this student into.' : `Moving ${studentIds.length} students into one section.`}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Class</Label>
            <Select value={gradeId} onValueChange={(v) => { setGradeId(v); setSectionId('') }}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Pick a class" /></SelectTrigger>
              <SelectContent>{grades.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Section</Label>
            <Select value={sectionId} onValueChange={setSectionId} disabled={!gradeId}>
              <SelectTrigger className="w-full"><SelectValue placeholder={gradeId ? 'Pick a section' : 'Pick a class first'} /></SelectTrigger>
              <SelectContent>{sections.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {studentIds.length === 1 && (
            <div className="grid gap-1.5">
              <Label>Roll number</Label>
              <Input value={rollNumber} onChange={(e) => setRollNumber(e.target.value)} inputMode="numeric" placeholder="Optional" />
            </div>
          )}
          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!sectionId || move.isPending} onClick={() => { setError(undefined); move.mutate() }}>Move</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const REASONS = ['Transferred to another school', 'Shifted city', 'Completed schooling', 'Long absence', 'Other']

/** Mark one or many students as left, with a date and a reason */
export function MarkLeftDialog({ open, onOpenChange, studentIds, onDone }: { open: boolean; onOpenChange: (v: boolean) => void; studentIds: string[]; onDone?: () => void }) {
  const qc = useQueryClient()
  const [leftOn, setLeftOn] = useState(() => new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState(REASONS[0]!)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string>()

  const markLeft = useMutation({
    mutationFn: async () => {
      const text = reason === 'Other' ? notes.trim() : notes.trim() ? `${reason} — ${notes.trim()}` : reason
      if (!text) throw new Error('Write a reason')
      for (const id of studentIds) await api.students.markLeft(id, { leftOn, reason: text })
    },
    onSuccess: () => {
      toast.success(studentIds.length === 1 ? 'Marked as left' : `${studentIds.length} students marked as left`)
      qc.invalidateQueries()
      onOpenChange(false)
      onDone?.()
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Mark as left</DialogTitle>
          <DialogDescription>{studentIds.length === 1 ? 'The student stops showing in the active list.' : `${studentIds.length} students will stop showing in the active list.`}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Last day</Label>
            <Input type="date" value={leftOn} onChange={(e) => setLeftOn(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label>Reason</Label>
            <Select value={reason} onValueChange={setReason}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Notes</Label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={reason === 'Other' ? 'Write the reason' : 'Optional'} />
          </div>
          {error && <p className="text-[12.5px] text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={markLeft.isPending} onClick={() => { setError(undefined); markLeft.mutate() }}>Mark as left</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
