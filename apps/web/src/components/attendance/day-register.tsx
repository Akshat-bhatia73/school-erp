/**
 * One day of a register, for pupils or for staff.
 *
 * The server decides what may happen today and says so in `window`: `record` while the register
 * is still the day's own, `correct` afterwards for the office. This draws whichever of the two
 * applies, and nothing at all when neither does, with the server's own sentence for why.
 */
import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { AttendanceDayWindow, AttendanceMark } from '@erp/contracts'
import { MarkPicker } from '@/components/attendance/mark-picker'
import { MARK_LABEL, windowReason } from '@/components/attendance/labels'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

export interface DayRegisterPerson {
  id: string
  /** Roll number or employee code. */
  lead: string
  name: string
  sub?: string
  /** The current mark the server sent, when there is one. */
  mark?: AttendanceMark
  /** False for a row nobody may mark here, such as the caller's own staff row. */
  editable: boolean
  /** Said instead of a picker on a row that is not editable. */
  note?: string
  /** Where this person's own month lives, when there is one to open. */
  to?: string
}

export interface DayRegisterLine { id: string; mark: AttendanceMark }

export function DayRegister({ people, window: day, canRecord, canCorrect, isSaving, onSave, onCorrect, noun, leadLabel, nameLabel }: {
  people: DayRegisterPerson[]
  window: AttendanceDayWindow
  canRecord: boolean
  canCorrect: boolean
  isSaving: boolean
  onSave: (lines: DayRegisterLine[]) => void
  onCorrect: (lines: DayRegisterLine[], reason: string) => void
  noun: { one: string; many: string }
  leadLabel: string
  nameLabel: string
}) {
  const recording = day.record && canRecord
  const correcting = !recording && day.correct && canCorrect
  const editable = recording || correcting

  // An unmarked day starts with everybody present, which is what most days are; a marked day
  // starts from what the server already holds.
  const initial = useMemo(() => {
    const draft: Record<string, AttendanceMark> = {}
    for (const person of people) {
      if (!person.editable) continue
      draft[person.id] = person.mark ?? 'present'
    }
    return draft
  }, [people])

  const [draft, setDraft] = useState(initial)
  // A fresh answer from the server replaces the draft: the register on screen is the stored one
  // until somebody changes it again. Adjusting during render keeps that off an effect.
  const signature = people.map((person) => `${person.id}:${person.mark ?? ''}`).join('|')
  const [seen, setSeen] = useState(signature)
  if (seen !== signature) {
    setSeen(signature)
    setDraft(initial)
  }

  const lines = people
    .filter((person) => person.editable)
    .map((person) => ({ id: person.id, mark: draft[person.id] ?? person.mark ?? 'present' }))
  const changed = lines.filter((line) => {
    const person = people.find((row) => row.id === line.id)
    return person?.mark !== line.mark
  })

  const [reasonOpen, setReasonOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)

  const submitCorrection = () => {
    const text = reason.trim()
    if (text.length < 3) {
      setReasonError('Say why these marks are being changed.')
      return
    }
    setReasonError(null)
    onCorrect(changed, text)
    setReasonOpen(false)
    setReason('')
  }

  const present = lines.filter((line) => line.mark === 'present' || line.mark === 'late').length
  const absent = lines.filter((line) => line.mark === 'absent').length
  const blocked = editable ? undefined : windowReason(day)

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-card px-3 py-2 md:px-4">
        <div className="flex items-center gap-2">
          {editable && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDraft(Object.fromEntries(people.filter((person) => person.editable).map((person) => [person.id, 'present' as AttendanceMark])))}
            >
              Everyone present
            </Button>
          )}
          {blocked && <p className="text-[12.5px] text-muted-foreground">{blocked}</p>}
        </div>
        <div className="flex items-center gap-2">
          {recording && (
            <Button size="sm" disabled={isSaving} onClick={() => onSave(lines)}>Save attendance</Button>
          )}
          {correcting && changed.length > 0 && (
            <Button size="sm" disabled={isSaving} onClick={() => setReasonOpen(true)}>Save corrections</Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-[13.5px]">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className="h-11 w-20 border-b bg-card px-3 text-left text-[13px] font-medium text-muted-foreground">{leadLabel}</th>
              <th className="h-11 border-b border-l bg-card px-3 text-left text-[13px] font-medium text-muted-foreground">{nameLabel}</th>
              <th className="h-11 border-b border-l bg-card px-3 text-left text-[13px] font-medium text-muted-foreground">Mark</th>
            </tr>
          </thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.id} className="hover:bg-accent/40">
                <td className="h-12 border-b px-3 tabular-nums text-muted-foreground">{person.lead}</td>
                <td className="h-12 border-b border-l px-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      {person.to ? <Link to={person.to} className="link-dotted">{person.name}</Link> : person.name}
                    </div>
                    {person.sub && <div className="truncate text-[12px] text-muted-foreground">{person.sub}</div>}
                  </div>
                </td>
                <td className="h-12 border-b border-l px-3">
                  {person.editable ? (
                    <MarkPicker
                      name={person.name}
                      value={draft[person.id] ?? person.mark}
                      onChange={(mark) => setDraft((old) => ({ ...old, [person.id]: mark }))}
                      readOnly={!editable}
                    />
                  ) : (
                    <span className="text-[13px] text-muted-foreground">{person.note ?? (person.mark ? MARK_LABEL[person.mark] : 'Not marked')}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-4 border-t bg-card px-3 text-[12.5px] text-muted-foreground md:px-4">
        <span>{people.length} {people.length === 1 ? noun.one : noun.many}</span>
        <span>{present} present</span>
        <span>{absent} absent</span>
      </div>

      <AlertDialog open={reasonOpen} onOpenChange={(open) => { if (!open) setReasonOpen(false) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Correct this register?</AlertDialogTitle>
            <AlertDialogDescription>
              {changed.length} {changed.length === 1 ? 'mark' : 'marks'} will change. The old marks stay on record with the reason you give.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <label htmlFor="correction-reason" className="text-[12px] text-muted-foreground">Reason</label>
            <Textarea id="correction-reason" rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
            {reasonError && <p className="text-[12.5px] text-destructive">{reasonError}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button disabled={isSaving} onClick={submitCorrection}>Save corrections</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
