/** One pupil's month: the figures, the calendar behind them, and the same month as a document. */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ClipboardCheck, Download } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'
import { currentMonth, MonthChip } from '@/components/attendance/month-chip'
import { MonthCalendar, MonthFacts, type MonthCalendarDay } from '@/components/attendance/person-month'
import { useMonthRange } from '@/components/attendance/use-month-range'
import { UserAvatar } from '@/components/shared/avatar'
import { useExportDownload } from '@/components/shared/export-download'
import { EmptyState, PageHeader, Panel } from '@/components/shared/page'
import { colorFor, Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const searchSchema = z.object({ month: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/attendance/students/$studentId')({ component: Page, validateSearch: searchSchema })

function Page() {
  const { studentId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { schoolId } = useSchoolContext()
  const month = search.month ?? currentMonth()
  const range = useMonthRange(studentId)
  const exportFile = useExportDownload({ className: 'px-4 pb-2' })

  const monthQuery = useQuery({
    queryKey: qk.attendanceStudentMonth(schoolId, studentId, month),
    queryFn: () => api.attendance.studentMonth(schoolId, studentId, month),
  })

  const startExport = useMutation({
    mutationFn: () => api.attendance.exportStudentMonth(schoolId, studentId, month),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const data = monthQuery.data
  const header = (
    <PageHeader
      crumbs={[{ label: 'Attendance', to: '/attendance', icon: <ClipboardCheck /> }, { label: data?.student.name ?? 'Loading…' }]}
      actions={<Button size="sm" variant="outline" disabled={startExport.isPending} onClick={() => startExport.mutate()}><Download />Download PDF</Button>}
    />
  )

  if (monthQuery.isError) {
    return (
      <>
        {header}
        <EmptyState icon={<ClipboardCheck />} title="This month is not available" description={describeError(monthQuery.error)} />
      </>
    )
  }

  if (!data) {
    return (
      <>
        {header}
        <div className="space-y-3 p-3 md:p-4"><Skeleton className="h-20 w-full" /><Skeleton className="h-64 w-full" /></div>
      </>
    )
  }

  const classLabel = data.grade ? (data.section ? `${data.grade.name} - ${data.section.name}` : data.grade.name) : undefined
  const days: MonthCalendarDay[] = data.days.map((day) => ({
    date: day.date,
    kind: day.kind,
    holidayName: day.holidayName,
    on: day.enrolled,
    mark: day.mark,
  }))

  return (
    <>
      {header}
      <div className="flex items-start gap-3 border-b p-3 md:gap-4 md:p-5">
        <UserAvatar name={data.student.name} size="xl" className="size-12 md:size-16" />
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold md:text-xl">{data.student.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {classLabel && <Tag color={colorFor(classLabel)}>{classLabel}</Tag>}
            <MonthChip
              month={month}
              min={range.min}
              max={range.max}
              onChange={(value) => void navigate({ to: '/attendance/students/$studentId', params: { studentId }, search: { month: value }, replace: true })}
            />
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground"><span className="font-mono">{data.student.admissionNumber}</span></p>
        </div>
      </div>
      {exportFile.status}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <Panel title="This month"><MonthFacts summary={data.summary} /></Panel>
        <Panel title="Calendar"><MonthCalendar days={days} /></Panel>
      </div>
    </>
  )
}
