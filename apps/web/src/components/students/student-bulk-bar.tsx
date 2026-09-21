import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { BulkBar } from '@/components/shared/bulk-bar'
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
  const { schoolId } = useSchoolContext()
  const exportFile = useExportDownload({ className: 'px-2 pb-1' })

  const start = useMutation({
    mutationFn: () => api.students.export(schoolId, { studentIds: ids }),
    onSuccess: (created) => {
      exportFile.start(created)
      toast.success('Export started')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  return (
    <BulkBar count={ids.length} onClear={onClear} status={exportFile.status}>
      <Button variant="ghost" size="sm" disabled={start.isPending} onClick={() => start.mutate()}>
        <Download />
        {start.isPending ? 'Starting…' : 'Export to Excel'}
      </Button>
    </BulkBar>
  )
}
