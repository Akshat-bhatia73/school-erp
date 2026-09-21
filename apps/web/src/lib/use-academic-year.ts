/**
 * The academic year a screen should work in.
 *
 * The school calendar is setup, not a person's record, so the server names the current year to
 * everybody who may read holidays: `GET /academic-years/current`. That answer is the year every
 * screen works in, for an office role and a teacher alike. Office roles also read the whole year
 * list, which the year chips need.
 *
 * Only when the current-year call is refused or answers null does this fall back to the old
 * behaviour: the list's current year for office roles, else the year of the first visible section.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AcademicYearRecord } from '@/lib/api/setup'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export interface AcademicYearChoice {
  /** Every year this person may read. Empty for a teacher or a parent. */
  years: AcademicYearRecord[]
  /** The current year record, when the server named one. */
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
  const canReadCurrent = hasPermission('holidays.read')

  const currentQuery = useQuery({
    queryKey: qk.currentAcademicYear(schoolId),
    queryFn: () => api.setup.currentAcademicYear(schoolId),
    enabled: canReadCurrent,
  })
  const yearsQuery = useQuery({
    queryKey: qk.academicYears(schoolId),
    queryFn: () => api.setup.academicYears(schoolId),
    enabled: canReadYears,
  })
  // Sections only matter as a fallback, so they are asked for only once the current-year call has
  // settled without an answer.
  const currentSettled = !canReadCurrent || currentQuery.isError || (currentQuery.isSuccess && currentQuery.data === null)
  const sectionsQuery = useQuery({
    queryKey: qk.sections(schoolId),
    queryFn: () => api.setup.sections(schoolId),
    enabled: currentSettled && !canReadYears && hasPermission('sections.read'),
  })

  const years = canReadYears ? yearsQuery.data ?? [] : []
  const yearIds = canReadYears
    ? years.map((year) => year.id)
    : [...new Set((sectionsQuery.data ?? []).map((section) => section.academicYearId))]

  const served = canReadCurrent ? currentQuery.data ?? null : null
  if (served) {
    return { years, current: served, currentYearId: served.id, yearIds, isLoading: canReadYears && yearsQuery.isLoading }
  }

  // Fallback: no current year came back.
  if (canReadYears) {
    const current = years.find((year) => year.status === 'current') ?? years[years.length - 1] ?? null
    const isLoading = yearsQuery.isLoading || (canReadCurrent && currentQuery.isLoading)
    return { years, current, currentYearId: current?.id ?? null, yearIds, isLoading }
  }

  const isLoading = (canReadCurrent && currentQuery.isLoading) || sectionsQuery.isLoading
  return { years: [], current: null, currentYearId: yearIds[0] ?? null, yearIds, isLoading }
}
