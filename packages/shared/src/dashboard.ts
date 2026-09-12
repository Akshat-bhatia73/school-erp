/** Read model for the dashboard. Computed on the server, never stored. */
export interface DashboardSummary {
  schoolId: string
  academicYearName: string
  students: {
    total: number
    active: number
    newThisYear: number
    byGender: { male: number; female: number; other: number }
    byGrade: { gradeId: string; gradeName: string; count: number }[]
    rte: number
  }
  staff: {
    total: number
    teaching: number
    nonTeaching: number
    onLeave: number
  }
  setup: {
    /** Onboarding checklist */
    steps: { key: string; label: string; done: boolean; href: string }[]
  }
  recentActivity: {
    id: string
    actorName: string
    summary: string
    at: string
  }[]
  /** Phase 2 placeholders so the layout is designed now */
  attendance?: { todayPercent: number; unmarkedSections: number }
  fees?: { collectedThisMonth: number; pendingTotal: number; defaulters: number }
}
