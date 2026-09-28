import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { StaffExportColumn } from '@erp/contracts'
import { BulkBar } from '@/components/shared/bulk-bar'
import { ExportColumnsDialog } from '@/components/shared/export-columns-dialog'
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
  const [choosing, setChoosing] = useState(false)

  const start = useMutation({
    // Columns travel only when the person chose something other than the default file.
    mutationFn: (columns: string[] | undefined) =>
      api.staff.export(schoolId, { staffIds: ids, ...(columns ? { columns: columns as StaffExportColumn[] } : {}) }),
    onSuccess: (job) => {
      setChoosing(false)
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  return (
    <>
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
        <Button variant="ghost" size="sm" disabled={tooMany || start.isPending} onClick={() => setChoosing(true)}>
          <Download />
          {start.isPending ? 'Starting…' : 'Export to Excel'}
        </Button>
      </BulkBar>
      <ExportColumnsDialog
        list="staff"
        open={choosing}
        onOpenChange={setChoosing}
        count={ids.length}
        pending={start.isPending}
        onExport={(columns) => start.mutate(columns)}
      />
    </>
  )
}
