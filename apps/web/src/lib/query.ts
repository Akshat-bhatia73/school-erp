import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 10_000, retry: 0, refetchOnWindowFocus: false },
  },
})

/** Central query keys so pages invalidate consistently */
export const qk = {
  schools: ['schools'] as const,
  academicYears: ['academicYears'] as const,
  grades: ['grades'] as const,
  sections: (p?: object) => ['sections', p ?? {}] as const,
  sectionStrengths: (yearId: string) => ['sectionStrengths', yearId] as const,
  subjects: ['subjects'] as const,
  gradeSubjects: (p: object) => ['gradeSubjects', p] as const,
  holidays: (yearId?: string) => ['holidays', yearId ?? 'all'] as const,
  students: (p?: object) => ['students', p ?? {}] as const,
  student: (id: string) => ['student', id] as const,
  studentGuardians: (id: string) => ['studentGuardians', id] as const,
  studentSiblings: (id: string) => ['studentSiblings', id] as const,
  studentDocuments: (id: string) => ['studentDocuments', id] as const,
  studentEnrollments: (id: string) => ['studentEnrollments', id] as const,
  staff: (p?: object) => ['staff', p ?? {}] as const,
  staffMember: (id: string) => ['staffMember', id] as const,
  staffAssignments: (id: string) => ['staffAssignments', id] as const,
  sectionAssignments: (id: string) => ['sectionAssignments', id] as const,
  departments: ['departments'] as const,
  users: ['users'] as const,
  user: (id: string) => ['user', id] as const,
  roles: ['roles'] as const,
  auditLogs: (p?: object) => ['auditLogs', p ?? {}] as const,
  dashboard: ['dashboard'] as const,
}
