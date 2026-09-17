import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export interface SectionOption { value: string; label: string; gradeId: string }

/**
 * The sections of one academic year, labelled with their class when the person may read classes.
 * A teacher holds no `grades.read` grant outside their own sections, so a refused class list is
 * not an error here: the section name stands on its own.
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
  const options: SectionOption[] = (sectionsQuery.data ?? []).map((section) => {
    const grade = grades.find((candidate) => candidate.id === section.gradeId)
    return {
      value: section.id,
      label: grade ? `${grade.name} - ${section.name}` : section.name,
      gradeId: section.gradeId,
    }
  })

  return { options, isLoading: sectionsQuery.isLoading, isError: sectionsQuery.isError }
}
