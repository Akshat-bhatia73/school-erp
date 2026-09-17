import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CalendarClock } from 'lucide-react'
import { dayName, todayDayOfWeek } from './day'
import { EmptyState, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { api } from '@/lib/api'
import type { TimetableCellRecord } from '@/lib/api/timetable'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'

export interface TeacherDashboardData {
  assignedSections: { id: string; name: string }[]
  ownTimetable: TimetableCellRecord[]
}

function byPeriod(a: TimetableCellRecord, b: TimetableCellRecord) {
  return a.periodIndex - b.periodIndex
}

/** A teacher sees the classes they teach and the periods they are standing in front of today. */
export function TeacherDashboard({ data }: { data?: TeacherDashboardData }) {
  const { schoolId } = useSchoolContext()
  const { currentYearId } = useAcademicYear()
  const today = todayDayOfWeek()

  const bellQuery = useQuery({
    queryKey: qk.bellSchedules(schoolId, { academicYearId: currentYearId }),
    queryFn: () => api.timetable.bellSchedules(schoolId, { academicYearId: currentYearId! }),
    enabled: currentYearId !== null,
  })

  const periodLabel = (index: number) => {
    for (const schedule of bellQuery.data ?? []) {
      const period = schedule.periods.find((item) => item.index === index)
      if (period) return period.name
    }
    return `Period ${index}`
  }

  const cells = data?.ownTimetable ?? []
  const todayCells = today === null ? [] : cells.filter((cell) => cell.dayOfWeek === today).sort(byPeriod)
  const week = [1, 2, 3, 4, 5, 6]
    .map((day) => ({ day, cells: cells.filter((cell) => cell.dayOfWeek === day).sort(byPeriod) }))
    .filter((group) => group.cells.length > 0)

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title="Your classes" description="Sections you teach this year">
        {(data?.assignedSections.length ?? 0) === 0 ? (
          <p className="text-[13px] text-muted-foreground">No sections are assigned to you yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {data!.assignedSections.map((section) => (
              <li key={section.id}>
                <Link to="/timetable" search={{ sectionId: section.id }} className="-mx-2 flex h-9 items-center rounded-lg px-2 text-[13.5px] hover:bg-accent">
                  {section.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Today" description={today === null ? 'Sunday' : dayName(today)}>
        {today === null ? (
          <p className="text-[13px] text-muted-foreground">No classes today.</p>
        ) : todayCells.length === 0 ? (
          <EmptyState icon={<CalendarClock />} title="No classes today" description="Nothing is on your timetable for today." className="py-8" />
        ) : (
          <ul className="flex flex-col divide-y">
            {todayCells.map((cell) => (
              <li key={`${cell.dayOfWeek}-${cell.periodIndex}-${cell.section.id}`} className="flex items-center gap-3 py-2">
                <span className="w-24 shrink-0 truncate text-[12.5px] text-muted-foreground">{periodLabel(cell.periodIndex)}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{cell.subject.name}</span>
                <Tag color="blue">{cell.section.name}</Tag>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="This week" description="Every period on your timetable">
        {week.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Your timetable is empty.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {week.map((group) => (
              <div key={group.day}>
                <p className="text-[12px] font-medium tracking-wide text-muted-foreground">{dayName(group.day)}</p>
                <ul className="mt-1 flex flex-col gap-1">
                  {group.cells.map((cell) => (
                    <li key={`${cell.periodIndex}-${cell.section.id}`} className="flex items-center gap-2 text-[13px]">
                      <span className="w-24 shrink-0 truncate text-muted-foreground">{periodLabel(cell.periodIndex)}</span>
                      <span className="min-w-0 flex-1 truncate">{cell.subject.name}</span>
                      <span className="shrink-0 text-[12px] text-muted-foreground">{cell.section.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  )
}
