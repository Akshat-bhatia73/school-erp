import { useMutation } from '@tanstack/react-query'
import { Download, X } from 'lucide-react'
import { toast } from 'sonner'
import { useExportDownload } from '@/components/shared/export-download'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'

/**
 * Floating bar shown when roster rows are selected. Export is the only bulk action the server
 * offers: moving or ending enrolments is a per-student write, so those live on the record.
 */
export function StudentBulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const exportFile = useExportDownload({ className: 'px-2 pb-1' })
  const canExport = hasPermission('students.export')

  const start = useMutation({
    mutationFn: () => api.students.export(schoolId, { studentIds: ids }),
    onSuccess: (created) => {
      exportFile.start(created)
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
              {start.isPending ? 'Starting…' : 'Export to Excel'}
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label="Clear selection" onClick={onClear}><X /></Button>
        </div>
        {exportFile.status}
      </div>
    </div>
  )
}
