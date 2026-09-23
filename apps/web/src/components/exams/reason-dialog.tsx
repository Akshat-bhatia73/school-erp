/** Why saved marks are changing: a kind from a short list, and the words, which go to the audit note. */
import type { ExamReasonKind } from '@erp/contracts'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'

export const REASON_KIND_LABELS: Record<ExamReasonKind, string> = {
  recheck: 'Re-check',
  entry_error: 'Entry error',
  other: 'Other',
}

export function ReasonDialog({ open, onOpenChange, title, description, submitLabel, busy, onSubmit }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  submitLabel: string
  busy?: boolean
  onSubmit: (change: { reasonKind: ExamReasonKind; reason: string }) => void
}) {
  const [reasonKind, setReasonKind] = useState<ExamReasonKind>('recheck')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = () => {
    const text = reason.trim()
    if (text.length < 3) {
      setError('Say in a few words why these marks are changing.')
      return
    }
    setError(null)
    onSubmit({ reasonKind, reason: text })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <RadioGroup value={reasonKind} onValueChange={(value) => setReasonKind(value as ExamReasonKind)} className="flex flex-wrap gap-4">
            {(Object.keys(REASON_KIND_LABELS) as ExamReasonKind[]).map((kind) => (
              <Label key={kind} className="flex items-center gap-2 text-[13.5px] font-normal"><RadioGroupItem value={kind} />{REASON_KIND_LABELS[kind]}</Label>
            ))}
          </RadioGroup>
          <div className="grid gap-1.5">
            <Label htmlFor="marks-change-reason" className="text-[12.5px] text-muted-foreground">Reason</Label>
            <Textarea id="marks-change-reason" rows={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />
            {error && <p role="alert" className="text-[12.5px] text-tag-red">{error}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" disabled={busy} onClick={submit}>{submitLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
