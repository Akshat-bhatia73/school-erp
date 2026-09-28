import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type { StudentExportColumn } from '@erp/contracts'
import { BulkBar } from '@/components/shared/bulk-bar'
import { ExportColumnsDialog } from '@/components/shared/export-columns-dialog'
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
  const [choosing, setChoosing] = useState(false)

  const start = useMutation({
    // Columns travel only when the person chose something other than the default file.
    mutationFn: (columns: string[] | undefined) =>
      api.students.export(schoolId, { studentIds: ids, ...(columns ? { columns: columns as StudentExportColumn[] } : {}) }),
    onSuccess: (created) => {
      setChoosing(false)
      exportFile.start(created)
      toast.success('Export started')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  return (
    <>
      <BulkBar count={ids.length} onClear={onClear} status={exportFile.status}>
        <Button variant="ghost" size="sm" disabled={start.isPending} onClick={() => setChoosing(true)}>
          <Download />
          {start.isPending ? 'Starting…' : 'Export to Excel'}
        </Button>
      </BulkBar>
      <ExportColumnsDialog
        list="students"
        open={choosing}
        onOpenChange={setChoosing}
        count={ids.length}
        pending={start.isPending}
        onExport={(columns) => start.mutate(columns)}
      />
    </>
  )
}
