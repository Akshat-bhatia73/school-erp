import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AUDIT_EXPORT_MAX_DAYS, AuditExportRequest } from '@erp/contracts'
import { api } from '@/lib/api'
import { useSchoolContext } from '@/lib/session'
import { describeError } from '@/lib/api-errors'
import { Tag } from '@/components/shared/tag'
import { useExportDownload } from '@/components/shared/export-download'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const DAY_MS = 24 * 60 * 60 * 1000

/** A calendar date from the input, as the start (or end) of that day with this browser's offset. */
function isoFrom(date: string, endOfDay: boolean): string | null {
  if (!date) return null
  const at = new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00'}`)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

const STATUS_LABEL = { queued: 'Queued', ready: 'Ready', failed: 'Failed', expired: 'Expired' } as const
const STATUS_COLOR = { queued: 'orange', ready: 'green', failed: 'red', expired: 'grey' } as const

export function AuditExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { schoolId } = useSchoolContext()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const exportFile = useExportDownload()

  const start = useMutation({
    mutationFn: (body: { from: string; to: string }) => api.audit.export(schoolId, body),
    onSuccess: (job) => { exportFile.start(job); toast.success('We are preparing the export') },
    onError: (caught) => toast.error(describeError(caught)),
  })

  const job = exportFile.job

  const submit = () => {
    const fromIso = isoFrom(from, false)
    const toIso = isoFrom(to, true)
    if (!fromIso || !toIso) { setError('Pick both a start and an end date.'); return }
    if (new Date(toIso).getTime() < new Date(fromIso).getTime()) { setError('The end date is before the start date.'); return }
    if (new Date(toIso).getTime() - new Date(fromIso).getTime() > AUDIT_EXPORT_MAX_DAYS * DAY_MS) {
      setError(`One export can cover at most ${AUDIT_EXPORT_MAX_DAYS} days.`)
      return
    }
    const parsed = AuditExportRequest.safeParse({ from: fromIso, to: toIso })
    if (!parsed.success) { setError('Those dates were not right. Check them and try again.'); return }
    setError(null)
    start.mutate({ from: fromIso, to: toIso })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export the audit log</DialogTitle>
          <DialogDescription>Choose the window to export. One export covers at most {AUDIT_EXPORT_MAX_DAYS} days.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 px-6">
          <div className="grid gap-1.5">
            <Label htmlFor="export-from">From</Label>
            <Input id="export-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="export-to">To</Label>
            <Input id="export-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {error && <p className="text-[12.5px] text-tag-red">{error}</p>}
          {job && (
            <div className="grid gap-1.5 rounded-xl border p-3">
              <Tag color={STATUS_COLOR[job.status]} dot>{STATUS_LABEL[job.status]}</Tag>
              {exportFile.status}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          <Button disabled={start.isPending} onClick={submit}>Export to Excel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
