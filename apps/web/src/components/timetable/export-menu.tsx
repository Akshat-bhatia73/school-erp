/**
 * "Export" for the week currently on screen, as a spreadsheet or a PDF.
 *
 * Exporting a timetable is reading it in another format, so the control is here for anyone who
 * can already see the grid: a teacher exports their own week, the office exports any section or
 * teacher it may open.
 */
import { useMutation } from '@tanstack/react-query'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import type { TimetableExportView } from '@erp/contracts'
import { useExportDownload } from '@/components/shared/export-download'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'

export function TimetableExportMenu({ academicYearId, view }: { academicYearId: string; view: TimetableExportView }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const exportFile = useExportDownload()

  const start = useMutation({
    mutationFn: (format: 'xlsx' | 'pdf') => api.timetable.export(schoolId, { academicYearId, format, view }),
    onSuccess: (job) => exportFile.start(job),
    onError: (error) => toast.error(describeError(error)),
  })

  if (!hasPermission('timetable.read')) return null

  return (
    <div className="flex items-center gap-2">
      {exportFile.status}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={start.isPending}>
            <Download />{start.isPending ? 'Preparing…' : 'Export'}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem onClick={() => start.mutate('xlsx')}>Excel</DropdownMenuItem>
          <DropdownMenuItem onClick={() => start.mutate('pdf')}>PDF</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
