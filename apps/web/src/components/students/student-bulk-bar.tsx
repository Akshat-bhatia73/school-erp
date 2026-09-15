import { useMutation, useQuery } from '@tanstack/react-query'
import { Download, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const STATUS_TEXT: Record<'queued' | 'ready' | 'failed' | 'expired', string> = {
  queued: 'Preparing your export…',
  ready: 'Export ready. Downloading a file is not built yet, so ask the office for it.',
  failed: 'The export could not be prepared. Try again.',
  expired: 'That export is no longer available. Ask for a new one.',
}

/**
 * Floating bar shown when roster rows are selected. Export is the only bulk action the server
 * offers: moving or ending enrolments is a per-student write, so those live on the record.
 */
export function StudentBulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const [jobId, setJobId] = useState<string | null>(null)
  const canExport = hasPermission('students.export')

  const job = useQuery({
    queryKey: qk.exportJob(schoolId, jobId ?? ''),
    queryFn: () => api.files.exportJob(schoolId, jobId!),
    enabled: jobId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'queued' ? 3000 : false),
  })

  const start = useMutation({
    mutationFn: () => api.students.export(schoolId, { studentIds: ids }),
    onSuccess: (created) => {
      setJobId(created.id)
      toast.success('Export started')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  if (ids.length === 0) return null

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center px-3">
      <div className="pointer-events-auto flex max-w-full flex-col gap-1 rounded-xl border bg-card p-1.5 shadow-lg">
        <div className="flex items-center gap-1">
          <span className="px-2 text-[13px] tabular-nums text-muted-foreground">{ids.length} selected</span>
          {canExport && (
            <Button variant="ghost" size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
              <Download />
              {start.isPending ? 'Starting…' : 'Export selected'}
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}><X /></Button>
        </div>
        {job.data && <p className="px-2 pb-1 text-[12.5px] text-muted-foreground">{STATUS_TEXT[job.data.status]}</p>}
      </div>
    </div>
  )
}
