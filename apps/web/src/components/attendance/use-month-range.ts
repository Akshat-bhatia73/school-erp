/**
 * The months a month chip may walk over.
 *
 * An office role reads the school's own year list, so the range starts at the first year. A
 * parent holds no year list and is offered the years their child was actually enrolled in. Either
 * way it ends at this month: there is nothing to show for a month that has not happened.
 */
import { useQuery } from '@tanstack/react-query'
import { currentMonth, monthOf, monthsOfYearName } from '@/components/attendance/month-chip'
import { api } from '@/lib/api'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'

export interface MonthRange { min?: string; max: string }

/** Pass a student id to fall back to that child's own enrolments. */
export function useMonthRange(studentId?: string): MonthRange {
  const { schoolId, hasPermission } = useSchoolContext()
  const { years } = useAcademicYear()
  const enrolments = useQuery({
    queryKey: qk.studentEnrollments(schoolId, studentId ?? 'none'),
    queryFn: () => api.students.enrollments(schoolId, studentId as string),
    enabled: studentId !== undefined && years.length === 0 && hasPermission('students.read_enrollments'),
  })

  const months: string[] = []
  for (const year of years) months.push(monthOf(year.startDate))
  for (const row of enrolments.data ?? []) {
    const own = monthsOfYearName(row.academicYear.name)
    if (own[0]) months.push(own[0])
  }
  months.sort()
  return { min: months[0], max: currentMonth() }
}
