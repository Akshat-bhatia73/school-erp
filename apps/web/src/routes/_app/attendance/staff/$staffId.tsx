/** One staff member's month: the same figures and calendar a pupil's month shows. */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ClipboardCheck } from 'lucide-react'
import { z } from 'zod'
import { currentMonth, MonthChip, shiftMonth } from '@/components/attendance/month-chip'
import { MonthCalendar, MonthFacts, type MonthCalendarDay } from '@/components/attendance/person-month'
import { useMonthRange } from '@/components/attendance/use-month-range'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, PageHeader, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const searchSchema = z.object({ month: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/attendance/staff/$staffId')({ component: Page, validateSearch: searchSchema })

function Page() {
  const { staffId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const { schoolId } = useSchoolContext()
  const month = search.month ?? currentMonth()
  const range = useMonthRange()
  // Without a year list to read, the last twelve months are as far back as this goes.
  const min = range.min ?? shiftMonth(currentMonth(), -11)

  const monthQuery = useQuery({
    queryKey: qk.staffAttendanceMember(schoolId, staffId, month),
    queryFn: () => api.attendance.staffMemberMonth(schoolId, staffId, month),
  })

  const data = monthQuery.data
  const header = (
    <PageHeader crumbs={[
      { label: 'Attendance', to: '/attendance', icon: <ClipboardCheck /> },
      { label: 'Staff register', to: '/attendance/staff' },
      { label: data?.staff.name ?? 'Loading…' },
    ]} />
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

  const days: MonthCalendarDay[] = data.days.map((day) => ({
    date: day.date,
    kind: day.kind,
    holidayName: day.holidayName,
    on: day.onRegister,
    mark: day.mark,
  }))

  return (
    <>
      {header}
      <div className="flex items-start gap-3 border-b p-3 md:gap-4 md:p-5">
        <UserAvatar name={data.staff.name} size="xl" className="size-12 md:size-16" />
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold md:text-xl">{data.staff.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {data.staff.designation && <Tag>{data.staff.designation}</Tag>}
            <MonthChip
              month={month}
              min={min}
              max={range.max}
              onChange={(value) => void navigate({ to: '/attendance/staff/$staffId', params: { staffId }, search: { month: value }, replace: true })}
            />
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground"><span className="font-mono">{data.staff.employeeCode}</span></p>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <Panel title="This month"><MonthFacts summary={data.summary} /></Panel>
        <Panel title="Calendar"><MonthCalendar days={days} /></Panel>
      </div>
    </>
  )
}
