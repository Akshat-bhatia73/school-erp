import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export interface SectionOption { value: string; label: string; gradeId: string }

/**
 * The sections of one academic year, labelled with their class when the person may read classes.
 * A teacher reads classes only for the sections they are assigned to, so the class list can be
 * shorter than the section list; a section without a matching class simply keeps its own name.
 * Options are ordered by class order, then by section name.
 */
export function useSectionOptions(academicYearId: string | null | undefined) {
  const { schoolId, hasPermission } = useSchoolContext()
  const canReadGrades = hasPermission('grades.read')

  const sectionsQuery = useQuery({
    queryKey: qk.sections(schoolId, { academicYearId: academicYearId ?? undefined }),
    queryFn: () => api.setup.sections(schoolId, { academicYearId: academicYearId ?? undefined }),
    enabled: Boolean(academicYearId) && hasPermission('sections.read'),
  })

  const gradesQuery = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: canReadGrades,
  })

  const grades = gradesQuery.data ?? []
  const options: SectionOption[] = (sectionsQuery.data ?? [])
    .map((section) => {
      const grade = grades.find((candidate) => candidate.id === section.gradeId)
      return {
        value: section.id,
        label: grade ? `${grade.name} - ${section.name}` : section.name,
        gradeId: section.gradeId,
        // A class this person cannot read sorts last, after every known class.
        order: grade?.order ?? Number.MAX_SAFE_INTEGER,
        name: section.name,
      }
    })
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ value, label, gradeId }) => ({ value, label, gradeId }))

  return { options, isLoading: sectionsQuery.isLoading, isError: sectionsQuery.isError }
}
