import { useQueries } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { BellScheduleRecord } from '@/lib/api/timetable'
import { Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { periodNameFor } from '@/components/timetable/timetable-grid'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export interface FreeTeachersTodayProps {
  academicYearId: string
  /** 1–6; 0 when the date is a Sunday, in which case nothing is taught. */
  dayOfWeek: number
  bell?: BellScheduleRecord
  /** The chosen day, written out, for the copy on the panel. */
  weekday: string
}

/**
 * Who is free, period by period, on the chosen day. It reuses the free-teacher
 * read of the arrangement picker (one call per period, no subject), so the
 * permission and the scoping are the same. A teacher's load for the day is what
 * is left once their free periods are taken off the day's periods, which keeps
 * this to the reads already made instead of asking for a new one.
 */
export function FreeTeachersToday({ academicYearId, dayOfWeek, bell, weekday }: FreeTeachersTodayProps) {
  const { schoolId } = useSchoolContext()
  const periods = bell?.periods ?? []
  const teaching = dayOfWeek >= 1 && dayOfWeek <= 6 && !!academicYearId

  const results = useQueries({
    queries: periods.map((period) => {
      const params = { academicYearId, dayOfWeek, periodIndex: period.index }
      return {
        queryKey: qk.freeTeachers(schoolId, params),
        queryFn: () => api.timetable.freeTeachers(schoolId, params),
        enabled: teaching,
      }
    }),
  })

  const isLoading = results.some((result) => result.isLoading)

  // How many of the day's periods each teacher is busy in.
  const loadById = new Map<string, number>()
  for (const result of results) {
    for (const row of result.data ?? []) loadById.set(row.teacher.id, (loadById.get(row.teacher.id) ?? 0) + 1)
  }
  const dayLoad = (staffId: string) => periods.length - (loadById.get(staffId) ?? 0)

  return (
    <Panel title="Free teachers today" className="mb-3">
      {!teaching ? (
        <p className="text-[13px] text-muted-foreground">Nothing is taught on {weekday}.</p>
      ) : periods.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Set up the school day first to see who is free.</p>
      ) : isLoading ? (
        <div className="grid gap-2">{Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-9 rounded-lg" />)}</div>
      ) : (
        <div className="grid gap-2">
          {periods.map((period, index) => {
            const rows = results[index]?.data ?? []
            return (
              <div key={period.index} className="flex flex-wrap items-start gap-2 border-b pb-2 last:border-b-0 last:pb-0">
                <span className="w-32 shrink-0 text-[13px]">
                  <span className="font-medium">{periodNameFor(bell, period.index)}</span>
                  <span className="block text-[12px] tabular-nums text-muted-foreground">{period.startTime}–{period.endTime}</span>
                </span>
                {rows.length === 0 ? (
                  <span className="text-[13px] text-muted-foreground">Nobody is free in this period.</span>
                ) : (
                  <span className="flex flex-wrap gap-1.5">
                    {rows.map((row) => (
                      <Tag key={row.teacher.id}>
                        {row.teacher.name}
                        <span className="ml-1.5 tabular-nums text-muted-foreground">{dayLoad(row.teacher.id)} periods today</span>
                      </Tag>
                    ))}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </Panel>
  )
}
