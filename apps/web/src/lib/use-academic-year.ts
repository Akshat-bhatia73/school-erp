/**
 * The academic year a screen should work in.
 *
 * Office roles read the year list and take the one marked current. A teacher or a parent holds no
 * `academic_years.read` grant, so for them the year is inferred from the sections the server lets
 * them see: an assignment or a guardian link is only effective in the year it belongs to, so those
 * sections all sit in the current year in practice. When several years show up the first is used,
 * and `yearIds` carries the rest so a screen can offer a choice. A better answer is the server
 * naming the current year in the school context; until then this is the one place that guesses.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AcademicYearRecord } from '@/lib/api/setup'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export interface AcademicYearChoice {
  /** Every year this person may read. Empty for a teacher or a parent. */
  years: AcademicYearRecord[]
  /** The current year record, when this person may read years. */
  current: AcademicYearRecord | null
  /** The year id a screen should use, however it was found. Null while loading or when unknown. */
  currentYearId: string | null
  /** Distinct year ids visible through sections, for callers who cannot read years. */
  yearIds: string[]
  isLoading: boolean
}

export function useAcademicYear(): AcademicYearChoice {
  const { schoolId, hasPermission } = useSchoolContext()
  const canReadYears = hasPermission('academic_years.read')

  const yearsQuery = useQuery({
    queryKey: qk.academicYears(schoolId),
    queryFn: () => api.setup.academicYears(schoolId),
    enabled: canReadYears,
  })
  const sectionsQuery = useQuery({
    queryKey: qk.sections(schoolId),
    queryFn: () => api.setup.sections(schoolId),
    enabled: !canReadYears && hasPermission('sections.read'),
  })

  if (canReadYears) {
    const years = yearsQuery.data ?? []
    const current = years.find((year) => year.status === 'current') ?? years[years.length - 1] ?? null
    return { years, current, currentYearId: current?.id ?? null, yearIds: years.map((year) => year.id), isLoading: yearsQuery.isLoading }
  }

  const yearIds = [...new Set((sectionsQuery.data ?? []).map((section) => section.academicYearId))]
  return { years: [], current: null, currentYearId: yearIds[0] ?? null, yearIds, isLoading: sectionsQuery.isLoading }
}
