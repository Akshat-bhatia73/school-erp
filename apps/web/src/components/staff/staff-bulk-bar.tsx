import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { BulkBar } from '@/components/shared/bulk-bar'
import { useExportDownload } from '@/components/shared/export-download'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'

/** One export can carry this many staff; the server refuses a bigger list. */
const EXPORT_MAX = 100

/** Floating bar shown when staff rows are selected. Export is the only bulk action. */
export function StaffBulkBar({ ids, onClear }: { ids: string[]; onClear: () => void }) {
  const { schoolId } = useSchoolContext()
  const exportFile = useExportDownload({ className: 'px-2 pb-1' })
  const tooMany = ids.length > EXPORT_MAX

  const start = useMutation({
    mutationFn: () => api.staff.export(schoolId, { staffIds: ids }),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  return (
    <BulkBar
      count={ids.length}
      onClear={onClear}
      status={
        <>
          {tooMany && (
            <p className="px-2 pb-1 text-[12.5px] text-muted-foreground">
              You can export up to {EXPORT_MAX} staff at a time.
            </p>
          )}
          {exportFile.status}
        </>
      }
    >
      <Button variant="ghost" size="sm" disabled={tooMany || start.isPending} onClick={() => start.mutate()}>
        <Download />
        {start.isPending ? 'Starting…' : 'Export to Excel'}
      </Button>
    </BulkBar>
  )
}
