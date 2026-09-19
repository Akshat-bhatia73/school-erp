import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { RedactAuditNoteRequest } from '@erp/contracts'
import type { AuditEvent } from '@/lib/api/audit'
import { UserAvatar } from '@/components/shared/avatar'
import { Facts, SectionLabel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'

export function formatWhen(iso: string) {
  const at = new Date(iso)
  const time = Number.isNaN(at.getTime()) ? '' : at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return { date: formatDate(iso), time }
}

/** 'members.suspend' -> 'Members suspend'. The server sends the raw action name. */
export function actionLabel(action: string): string {
  const words = action.replace(/[._]/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * One audit entry, exactly as the server sends it. The summary carries no field-level changes in
 * this build, so nothing here is reconstructed or guessed. The note is free text somebody typed
 * when they made the change, which is why it can be redacted on its own.
 */
export function AuditDetailSheet({ entry, onOpenChange }: { entry: AuditEvent | null; onOpenChange: (open: boolean) => void }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const when = entry ? formatWhen(entry.at) : { date: '', time: '' }

  const redact = useMutation({
    mutationFn: (body: { reason: string }) => api.audit.redactNote(schoolId, entry!.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'audit'] })
      toast.success('Note redacted')
      setConfirming(false)
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submitRedaction = () => {
    const parsed = RedactAuditNoteRequest.safeParse({ reason: reason.trim() })
    if (!parsed.success) {
      setReasonError('Say why the note is being removed.')
      return
    }
    setReasonError(null)
    redact.mutate(parsed.data)
  }

  return (
    <Sheet open={!!entry} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Details</SheetTitle>
          <SheetDescription>{entry?.summary}</SheetDescription>
        </SheetHeader>
        {entry && (
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6">
            <Facts
              items={[
                { label: 'Who', value: <span className="flex items-center gap-2"><UserAvatar name={entry.actorDisplayName} size="xs" />{entry.actorDisplayName}</span> },
                { label: 'When', value: <span className="tabular-nums">{when.date} · {when.time}</span> },
                { label: 'Action', value: <Tag color="blue">{actionLabel(entry.action)}</Tag> },
                { label: 'Outcome', value: <Tag color={entry.outcome === 'allowed' ? 'green' : 'red'} dot>{entry.outcome === 'allowed' ? 'Allowed' : 'Refused'}</Tag> },
                { label: 'Entry id', value: <span className="font-mono text-[12.5px]">{entry.id}</span> },
              ]}
            />
            {entry.note && (
              <div>
                <SectionLabel
                  className="px-0"
                  action={hasPermission('audit.redact_notes')
                    ? <Button size="sm" variant="ghost" onClick={() => { setReason(''); setReasonError(null); setConfirming(true) }}>Redact</Button>
                    : undefined}
                >
                  Note
                </SectionLabel>
                <p className="whitespace-pre-wrap text-[13px]">{entry.note}</p>
              </div>
            )}
          </div>
        )}
        <AlertDialog open={confirming} onOpenChange={setConfirming}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this note?</AlertDialogTitle>
              <AlertDialogDescription>
                The entry itself stays in the log. Only the free text somebody typed is removed, and it cannot be brought back.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5 px-1">
              <Label>Reason</Label>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="The note names somebody who is not part of this change" />
              {reasonError && <p className="text-[12px] text-destructive">{reasonError}</p>}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep note</AlertDialogCancel>
              <Button variant="destructive" disabled={redact.isPending} onClick={submitRedaction}>
                {redact.isPending ? 'Removing…' : 'Redact note'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetContent>
    </Sheet>
  )
}
