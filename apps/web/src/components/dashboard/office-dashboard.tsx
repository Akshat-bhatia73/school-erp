import { useQuery } from '@tanstack/react-query'
import { QuickActions } from './quick-actions'
import { RecentActivity } from './recent-activity'
import { SetupChecklist, type SetupStep } from './setup-checklist'
import { StatPanel } from './stat-panel'
import { StudentsByClass, type ClassStrengthRow } from './students-by-class'
import { api } from '@/lib/api'
import { qk } from '@/lib/query'
import { useAcademicYear } from '@/lib/use-academic-year'
import { useSchoolContext } from '@/lib/session'

export interface OfficeDashboardData { activeStudents: number; staffCount: number }

/** The front-office view: the two counts the server gives, plus what setup this person may read. */
export function OfficeDashboard({ data, isLoading }: { data?: OfficeDashboardData; isLoading?: boolean }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const { currentYearId, isLoading: yearLoading } = useAcademicYear()

  const canReadStrengths = hasPermission('sections.read_strengths')
  const canReadSections = hasPermission('sections.read')
  const canReadGrades = hasPermission('grades.read')
  const canReadAudit = hasPermission('audit.read')

  const strengthsQuery = useQuery({
    queryKey: qk.sectionStrengths(schoolId, { academicYearId: currentYearId }),
    queryFn: () => api.setup.sectionStrengths(schoolId, { academicYearId: currentYearId! }),
    enabled: canReadStrengths && currentYearId !== null,
  })
  const sectionsQuery = useQuery({
    queryKey: qk.sections(schoolId, { academicYearId: currentYearId }),
    queryFn: () => api.setup.sections(schoolId, { academicYearId: currentYearId! }),
    enabled: canReadSections && currentYearId !== null,
  })
  const gradesQuery = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: canReadGrades,
  })
  const subjectsQuery = useQuery({
    queryKey: qk.subjects(schoolId),
    queryFn: () => api.setup.subjects(schoolId),
    enabled: hasPermission('subjects.read'),
  })
  const schoolQuery = useQuery({
    queryKey: qk.school(schoolId),
    queryFn: () => api.setup.school(schoolId),
    enabled: hasPermission('school.read'),
  })
  const yearsQuery = useQuery({
    queryKey: qk.academicYears(schoolId),
    queryFn: () => api.setup.academicYears(schoolId),
    enabled: hasPermission('academic_years.read'),
  })
  const auditQuery = useQuery({
    queryKey: qk.auditEvents(schoolId, { pageSize: 8 }),
    queryFn: () => api.audit.list(schoolId, { pageSize: 8 }),
    enabled: canReadAudit,
  })

  const sections = sectionsQuery.data ?? []
  const grades = gradesQuery.data ?? []
  const gradeName = new Map(grades.map((grade) => [grade.id, grade.name]))
  const strengthRows: ClassStrengthRow[] = (strengthsQuery.data ?? []).map((row, index) => {
    const section = sections.find((item) => item.id === row.sectionId)
    const grade = section ? gradeName.get(section.gradeId) : undefined
    const label = section ? (grade ? `${grade} ${section.name}` : section.name) : `Section ${index + 1}`
    return { id: row.sectionId, label, count: row.count }
  }).sort((a, b) => a.label.localeCompare(b.label))

  // The year id arrives from useAcademicYear, so the panels are still loading while it is resolving.
  // Once that query settles the id may legitimately stay null (nobody may read years); then the
  // dependent queries stay disabled and the panels show their empty state rather than a spinner.
  const yearPending = yearLoading
  const strengthsLoading = yearPending || strengthsQuery.isLoading || sectionsQuery.isLoading || gradesQuery.isLoading
  const checklistLoading = yearPending || schoolQuery.isLoading || yearsQuery.isLoading || gradesQuery.isLoading || sectionsQuery.isLoading || subjectsQuery.isLoading

  const steps: SetupStep[] = [
    hasPermission('school.read') ? { key: 'school', label: 'Fill in the school profile', to: '/setup/school', done: !!schoolQuery.data } : null,
    hasPermission('academic_years.read') ? { key: 'years', label: 'Add an academic year', to: '/setup/academic-years', done: (yearsQuery.data?.length ?? 0) > 0 } : null,
    canReadGrades ? { key: 'grades', label: 'Add classes', to: '/setup/classes', done: grades.length > 0 } : null,
    canReadSections ? { key: 'sections', label: 'Add sections', to: '/setup/classes', done: sections.length > 0 } : null,
    hasPermission('subjects.read') ? { key: 'subjects', label: 'Add subjects', to: '/setup/subjects', done: (subjectsQuery.data?.length ?? 0) > 0 } : null,
  ].filter((step): step is SetupStep => step !== null)

  return (
    <>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <QuickActions />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <StatPanel label="Active students" isLoading={isLoading} value={data?.activeStudents ?? 0} />
        <StatPanel label="Staff" isLoading={isLoading} value={data?.staffCount ?? 0} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {canReadStrengths && (
          <div className="lg:col-span-2">
            <StudentsByClass rows={strengthRows} isLoading={strengthsLoading} error={strengthsQuery.error} />
          </div>
        )}
        {steps.length > 0 && <SetupChecklist steps={steps} isLoading={checklistLoading} />}
      </div>

      {canReadAudit && <RecentActivity items={auditQuery.data?.items} isLoading={auditQuery.isLoading} error={auditQuery.error} />}
    </>
  )
}
