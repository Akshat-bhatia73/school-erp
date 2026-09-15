import { useQuery } from '@tanstack/react-query'
import { CalendarClock } from 'lucide-react'
import { dayName, todayDayOfWeek } from './day'
import { EmptyState, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { Dashboard } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { fullName } from '@/lib/utils'

export type ParentChild = Extract<Dashboard, { audience: 'parent' }>['children'][number]

const STATUS_LABEL: Record<string, string> = { active: 'Active', left: 'Left', alumni: 'Alumni', suspended: 'Suspended' }

function ChildTimetable({ sectionId, academicYearId }: { sectionId: string; academicYearId: string }) {
  const { schoolId } = useSchoolContext()
  const today = todayDayOfWeek()
  const { data, isLoading, error } = useQuery({
    queryKey: qk.timetableSection(schoolId, sectionId, { academicYearId }),
    queryFn: () => api.timetable.forSection(schoolId, sectionId, { academicYearId }),
  })

  if (today === null) return <p className="text-[13px] text-muted-foreground">No classes today.</p>
  if (isLoading) return <div className="flex flex-col gap-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}</div>
  if (error) return <p className="text-[13px] text-muted-foreground">{describeError(error)}</p>

  const cells = (data?.cells ?? []).filter((cell) => cell.dayOfWeek === today).sort((a, b) => a.periodIndex - b.periodIndex)
  if (cells.length === 0) {
    return <EmptyState icon={<CalendarClock />} title="No classes today" description={`Nothing on the timetable for ${dayName(today)}.`} className="py-8" />
  }
  return (
    <ul className="flex flex-col divide-y">
      {cells.map((cell) => (
        <li key={`${cell.periodIndex}-${cell.subject.id}`} className="flex items-center gap-3 py-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px]">{cell.subject.name}</span>
          <span className="shrink-0 text-[12.5px] text-muted-foreground">{cell.teacher?.name ?? 'Teacher not set'}</span>
        </li>
      ))}
    </ul>
  )
}

function ChildCard({ child }: { child: ParentChild }) {
  const { hasPermission } = useSchoolContext()
  const enrollment = child.enrollment
  return (
    <Panel
      title={fullName(child)}
      description={enrollment ? `${enrollment.grade.name} ${enrollment.section.name} · ${child.admissionNumber}` : child.admissionNumber}
      actions={<Tag color={child.status === 'active' ? 'green' : 'grey'}>{STATUS_LABEL[child.status] ?? child.status}</Tag>}
    >
      {enrollment ? (
        <>
          <p className="mb-1 text-[12px] font-medium tracking-wide text-muted-foreground">Today</p>
          <ChildTimetable sectionId={enrollment.section.id} academicYearId={enrollment.academicYear.id} />
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          {hasPermission('students.read_enrollments') ? 'Not in a class this year.' : 'Class not shown.'}
        </p>
      )}
    </Panel>
  )
}

/** The parent home: one card per child and what that child is studying today. */
export function ParentDashboard({ students }: { students?: ParentChild[] }) {
  const list = students ?? []
  if (list.length === 0) {
    return <EmptyState icon={<CalendarClock />} title="No children linked yet" description="Ask the school office to link your children to your account." />
  }
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {list.map((child) => <ChildCard key={child.id} child={child} />)}
    </div>
  )
}
