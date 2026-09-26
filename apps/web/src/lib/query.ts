import { QueryClient } from '@tanstack/react-query'

/**
 * One client per context generation. `SessionProvider` builds a fresh one whenever the identity
 * or the active school changes, so no answer from the previous context can survive the switch.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        // Never retry: a 4xx will not change on its own, and a refused request must surface
        // straight away so the gate can send the person to sign in.
        retry: false,
        refetchOnWindowFocus: false,
      },
    },
  })
}

/**
 * Query keys for the protected school APIs.
 *
 * Every key starts with the school id, so switching school can never show another school's cached
 * answer, and each module nests under one prefix: invalidating `[schoolId, 'students']` after a
 * write clears the roster, the count, the search and every student's detail in one call.
 */
type Params = Record<string, unknown> | undefined

export const qk = {
  /** Everything cached for one school. Invalidate this when access itself changes. */
  all: (schoolId: string) => [schoolId] as const,

  school: (schoolId: string) => [schoolId, 'school'] as const,
  academicYears: (schoolId: string) => [schoolId, 'academicYears'] as const,
  currentAcademicYear: (schoolId: string) => [schoolId, 'academicYears', 'current'] as const,
  grades: (schoolId: string) => [schoolId, 'grades'] as const,
  sections: (schoolId: string, params?: Params) => [schoolId, 'sections', 'list', params ?? {}] as const,
  sectionStrengths: (schoolId: string, params: Params) => [schoolId, 'sections', 'strengths', params ?? {}] as const,
  section: (schoolId: string, sectionId: string) => [schoolId, 'sections', 'detail', sectionId] as const,
  subjects: (schoolId: string) => [schoolId, 'subjects', 'list'] as const,
  gradeSubjects: (schoolId: string, params: Params) => [schoolId, 'subjects', 'byGrade', params ?? {}] as const,
  holidays: (schoolId: string, params?: Params) => [schoolId, 'holidays', params ?? {}] as const,

  students: (schoolId: string, params?: Params) => [schoolId, 'students', 'list', params ?? {}] as const,
  studentCount: (schoolId: string, params?: Params) => [schoolId, 'students', 'count', params ?? {}] as const,
  studentSearch: (schoolId: string, q: string) => [schoolId, 'students', 'search', q] as const,
  student: (schoolId: string, studentId: string) => [schoolId, 'students', 'detail', studentId] as const,
  studentGuardians: (schoolId: string, studentId: string) => [schoolId, 'students', 'detail', studentId, 'guardians'] as const,
  studentSiblings: (schoolId: string, studentId: string) => [schoolId, 'students', 'detail', studentId, 'siblings'] as const,
  studentDocuments: (schoolId: string, studentId: string) => [schoolId, 'students', 'detail', studentId, 'documents'] as const,
  studentConsents: (schoolId: string, studentId: string) => [schoolId, 'students', 'detail', studentId, 'consents'] as const,
  studentEnrollments: (schoolId: string, studentId: string) => [schoolId, 'students', 'detail', studentId, 'enrollments'] as const,
  promotePreview: (schoolId: string, params: Params) => [schoolId, 'students', 'promotePreview', params ?? {}] as const,

  staff: (schoolId: string, params?: Params) => [schoolId, 'staff', 'list', params ?? {}] as const,
  staffCount: (schoolId: string) => [schoolId, 'staff', 'count'] as const,
  staffSearch: (schoolId: string, q: string) => [schoolId, 'staff', 'search', q] as const,
  staffMember: (schoolId: string, staffId: string) => [schoolId, 'staff', 'detail', staffId] as const,
  staffAssignments: (schoolId: string, staffId: string) => [schoolId, 'staff', 'detail', staffId, 'assignments'] as const,
  sectionAssignments: (schoolId: string, sectionId: string) => [schoolId, 'staff', 'sectionAssignments', sectionId] as const,
  departments: (schoolId: string) => [schoolId, 'staff', 'departments'] as const,

  bellSchedules: (schoolId: string, params?: Params) => [schoolId, 'timetable', 'bellSchedules', params ?? {}] as const,
  bellScheduleForGrade: (schoolId: string, gradeId: string, params?: Params) => [schoolId, 'timetable', 'bellSchedules', 'forGrade', gradeId, params ?? {}] as const,
  timetableSection: (schoolId: string, sectionId: string, params?: Params) => [schoolId, 'timetable', 'section', sectionId, params ?? {}] as const,
  timetableStaff: (schoolId: string, staffId: string, params?: Params) => [schoolId, 'timetable', 'staff', staffId, params ?? {}] as const,
  freeTeachers: (schoolId: string, params: Params) => [schoolId, 'timetable', 'freeTeachers', params ?? {}] as const,
  conflicts: (schoolId: string, params?: Params) => [schoolId, 'timetable', 'conflicts', params ?? {}] as const,
  teacherLoads: (schoolId: string, params?: Params) => [schoolId, 'timetable', 'teacherLoads', params ?? {}] as const,
  substitutions: (schoolId: string, date: string) => [schoolId, 'timetable', 'substitutions', date] as const,
  absentPeriods: (schoolId: string, params: Params) => [schoolId, 'timetable', 'absentPeriods', params ?? {}] as const,

  feeHeads: (schoolId: string) => [schoolId, 'fees', 'heads'] as const,
  feeStructures: (schoolId: string, params?: Params) => [schoolId, 'fees', 'structures', params ?? {}] as const,
  feeStatement: (schoolId: string, studentId: string, params?: Params) => [schoolId, 'fees', 'statement', studentId, params ?? {}] as const,
  feeDues: (schoolId: string, params?: Params) => [schoolId, 'fees', 'dues', params ?? {}] as const,
  feeReceipts: (schoolId: string, params?: Params) => [schoolId, 'fees', 'receipts', params ?? {}] as const,
  feeReceipt: (schoolId: string, receiptId: string) => [schoolId, 'fees', 'receipt', receiptId] as const,

  attendanceSections: (schoolId: string, params?: Params) => [schoolId, 'attendance', 'sections', params ?? {}] as const,
  attendanceDay: (schoolId: string, sectionId: string, date: string) => [schoolId, 'attendance', 'day', sectionId, date] as const,
  attendanceStudentMonth: (schoolId: string, studentId: string, month: string) => [schoolId, 'attendance', 'studentMonth', studentId, month] as const,
  attendanceSectionMonth: (schoolId: string, sectionId: string, month: string) => [schoolId, 'attendance', 'sectionMonth', sectionId, month] as const,
  staffAttendanceDay: (schoolId: string, date: string) => [schoolId, 'attendance', 'staffDay', date] as const,
  staffAttendanceMonth: (schoolId: string, month: string) => [schoolId, 'attendance', 'staffMonth', month] as const,
  staffAttendanceMember: (schoolId: string, staffId: string, month: string) => [schoolId, 'attendance', 'staffMember', staffId, month] as const,

  exams: (schoolId: string, params?: Params) => [schoolId, 'exams', 'list', params ?? {}] as const,
  examOverview: (schoolId: string, examId: string) => [schoolId, 'exams', 'overview', examId] as const,
  examPapers: (schoolId: string, params?: Params) => [schoolId, 'exams', 'papers', params ?? {}] as const,
  examSheet: (schoolId: string, paperId: string) => [schoolId, 'exams', 'sheet', paperId] as const,
  examMarkHistory: (schoolId: string, paperId: string, studentId: string, component: string) => [schoolId, 'exams', 'sheet', paperId, 'history', studentId, component] as const,
  examResults: (schoolId: string, studentId: string, params?: Params) => [schoolId, 'exams', 'results', studentId, params ?? {}] as const,

  /** A pupil's own login. Every write invalidates `[schoolId, 'studentLogins']` and the students prefix. */
  studentLogins: {
    detail: (schoolId: string, studentId: string) => [schoolId, 'studentLogins', 'detail', studentId] as const,
  },

  /** Messages. Every write invalidates `[schoolId, 'messages']`, which also refreshes the unread badge. */
  messages: {
    unread: (schoolId: string) => [schoolId, 'messages', 'unread'] as const,
    inbox: (schoolId: string, params?: Params) => [schoolId, 'messages', 'inbox', params ?? {}] as const,
    list: (schoolId: string, params?: Params) => [schoolId, 'messages', 'list', params ?? {}] as const,
    detail: (schoolId: string, messageId: string) => [schoolId, 'messages', 'detail', messageId] as const,
    recipients: (schoolId: string, messageId: string, params?: Params) => [schoolId, 'messages', 'detail', messageId, 'recipients', params ?? {}] as const,
    audiences: (schoolId: string) => [schoolId, 'messages', 'audiences'] as const,
    audiencePreview: (schoolId: string, audience: Params) => [schoolId, 'messages', 'audiencePreview', audience ?? {}] as const,
    templates: (schoolId: string, params?: Params) => [schoolId, 'messages', 'templates', params ?? {}] as const,
    settings: (schoolId: string) => [schoolId, 'messages', 'settings'] as const,
  },

  /** The assistant. A turn or a delete invalidates `[schoolId, 'assistant']`. */
  assistant: {
    status: (schoolId: string) => [schoolId, 'assistant', 'status'] as const,
    threads: (schoolId: string) => [schoolId, 'assistant', 'threads'] as const,
    thread: (schoolId: string, threadId: string) => [schoolId, 'assistant', 'thread', threadId] as const,
    proposals: (schoolId: string, threadId: string) => [schoolId, 'assistant', 'thread', threadId, 'proposals'] as const,
    settings: (schoolId: string) => [schoolId, 'assistant', 'settings'] as const,
    usage: (schoolId: string, month?: string) => [schoolId, 'assistant', 'usage', month ?? 'current'] as const,
  },

  examSettings: (schoolId: string) => [schoolId, 'reportCards', 'settings'] as const,
  reportCardEntries: (schoolId: string, sectionId: string, term: string) => [schoolId, 'reportCards', 'entries', sectionId, term] as const,
  reportCardSections: (schoolId: string, params?: Params) => [schoolId, 'reportCards', 'sections', params ?? {}] as const,
  reportCardSection: (schoolId: string, sectionId: string, card: string) => [schoolId, 'reportCards', 'section', sectionId, card] as const,
  studentReportCards: (schoolId: string, studentId: string, params?: Params) => [schoolId, 'reportCards', 'student', studentId, params ?? {}] as const,
  reportCardVersion: (schoolId: string, versionId: string) => [schoolId, 'reportCards', 'version', versionId] as const,

  dashboard: (schoolId: string, params?: unknown) => [schoolId, 'dashboard', params ?? {}] as const,
  search: (schoolId: string, q: string) => [schoolId, 'search', q] as const,
  auditEvents: (schoolId: string, params?: Params) => [schoolId, 'audit', 'events', params ?? {}] as const,

  members: (schoolId: string, params?: Params) => [schoolId, 'members', 'list', params ?? {}] as const,
  invitations: (schoolId: string, params?: Params) => [schoolId, 'members', 'invitations', params ?? {}] as const,
  accessExplanation: (schoolId: string, membershipId: string, params: Params) => [schoolId, 'members', 'accessExplanation', membershipId, params ?? {}] as const,
  memberRestrictions: (schoolId: string, membershipId: string) => [schoolId, 'members', 'restrictions', membershipId] as const,

  exportJob: (schoolId: string, jobId: string) => [schoolId, 'exports', jobId] as const,
} as const
