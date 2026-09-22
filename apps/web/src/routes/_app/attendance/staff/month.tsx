/** The staff register over a month: everybody, every day, and what it adds up to. */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ClipboardCheck } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { currentMonth, MonthChip } from '@/components/attendance/month-chip'
import { RegisterGrid, type RegisterGridRow } from '@/components/attendance/register-grid'
import { FeeExportMenu, type FeeFileFormat } from '@/components/fees/export-menu'
import { useExportDownload } from '@/components/shared/export-download'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const searchSchema = z.object({ month: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/attendance/staff/month')({ component: Page, validateSearch: searchSchema })

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { schoolId } = useSchoolContext()
  const month = search.month ?? currentMonth()
  const exportFile = useExportDownload({ className: 'px-4 pb-2' })

  const monthQuery = useQuery({
    queryKey: qk.staffAttendanceMonth(schoolId, month),
    queryFn: () => api.attendance.staffMonth(schoolId, month),
  })

  const startExport = useMutation({
    mutationFn: (format: FeeFileFormat) => api.attendance.exportStaffMonth(schoolId, month, { format }),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const data = monthQuery.data
  const header = (
    <PageHeader
      crumbs={[{ label: 'Attendance', to: '/attendance', icon: <ClipboardCheck /> }, { label: 'Staff register' }]}
      actions={data && allows(data.allowedActions, 'staff_attendance.export')
        ? <FeeExportMenu isPending={startExport.isPending} onPick={(format) => startExport.mutate(format)} />
        : undefined}
    />
  )

  if (monthQuery.isError) {
    return (
      <>
        {header}
        <EmptyState icon={<ClipboardCheck />} title="The staff register is not available" description={describeError(monthQuery.error)} />
      </>
    )
  }

  const rows: RegisterGridRow[] = (data?.rows ?? []).map((row) => ({
    id: row.staff.id,
    lead: row.staff.employeeCode,
    name: row.staff.name,
    cells: row.marks.map((mark) => ({ on: mark.onRegister, mark: mark.mark })),
    summary: row.summary,
  }))

  return (
    <>
      {header}
      <Toolbar>
        <MonthChip month={month} max={currentMonth()} onChange={(value) => void navigate({ to: '/attendance/staff/month', search: { month: value }, replace: true })} />
      </Toolbar>
      {exportFile.status}
      {!data ? (
        <div className="space-y-3 p-3 md:p-4"><Skeleton className="h-10 w-full" /><Skeleton className="h-64 w-full" /></div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<ClipboardCheck />} title="Nobody to show" description="No staff member was on the register in this month." />
      ) : (
        <RegisterGrid days={data.days} rows={rows} leadLabel="Code" />
      )}
      <div className="flex h-11 shrink-0 items-center gap-4 border-t bg-card px-3 text-[12.5px] text-muted-foreground md:px-4">
        <span>{rows.length} {rows.length === 1 ? 'staff member' : 'staff'}</span>
      </div>
    </>
  )
}
