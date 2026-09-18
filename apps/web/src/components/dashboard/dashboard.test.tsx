import type { ReactNode } from 'react'
import { screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/lib/http'
import { renderWithSession } from '@/test/session'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => options,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    useNavigate: () => vi.fn(),
    useRouterState: () => '/dashboard',
  }
})

const dashboardGet = vi.fn()
const sectionStrengths = vi.fn()
const sections = vi.fn()
const grades = vi.fn()
const subjects = vi.fn()
const school = vi.fn()
const academicYears = vi.fn()
const auditList = vi.fn()
const forSection = vi.fn()
const studentConsents = vi.fn()
const recordConsent = vi.fn()
const studentGet = vi.fn()
const bellSchedules = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    dashboard: { get: (...args: unknown[]) => dashboardGet(...args) },
    setup: {
      sectionStrengths: (...args: unknown[]) => sectionStrengths(...args),
      sections: (...args: unknown[]) => sections(...args),
      grades: (...args: unknown[]) => grades(...args),
      subjects: (...args: unknown[]) => subjects(...args),
      school: (...args: unknown[]) => school(...args),
      academicYears: (...args: unknown[]) => academicYears(...args),
    },
    audit: { list: (...args: unknown[]) => auditList(...args) },
    students: {
      consents: (...args: unknown[]) => studentConsents(...args),
      recordConsent: (...args: unknown[]) => recordConsent(...args),
      get: (...args: unknown[]) => studentGet(...args),
    },
    timetable: {
      forSection: (...args: unknown[]) => forSection(...args),
      bellSchedules: (...args: unknown[]) => bellSchedules(...args),
    },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'
const YEAR = { id: 'year-1', schoolId: SCHOOL, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current', version: 1 }

async function renderDashboard(options: Parameters<typeof renderWithSession>[1]) {
  const module = await import('@/routes/_app/dashboard')
  const Component = (module.Route as unknown as { component: () => ReactNode }).component
  return renderWithSession(<Component />, options)
}

beforeEach(() => {
  vi.clearAllMocks()
  academicYears.mockResolvedValue([YEAR])
  sections.mockResolvedValue([{ id: 'sec-1', schoolId: SCHOOL, gradeId: 'grade-1', academicYearId: YEAR.id, name: 'A', version: 1 }])
  grades.mockResolvedValue([{ id: 'grade-1', schoolId: SCHOOL, name: 'Six', shortName: '6', order: 6, version: 1 }])
  subjects.mockResolvedValue([])
  school.mockResolvedValue({ id: SCHOOL, name: 'Fixture A', shortName: 'A', board: 'cbse', address: '', phone: '+919876543210', email: 'a@b.test', version: 1 })
  sectionStrengths.mockResolvedValue([{ sectionId: 'sec-1', count: 12 }])
  auditList.mockResolvedValue({ items: [{ id: 'a1', at: new Date().toISOString(), actorDisplayName: 'Owner A', action: 'students.create', summary: 'admitted a student', outcome: 'allowed' }], page: 1, pageSize: 8, total: 1 })
  bellSchedules.mockResolvedValue([])
  forSection.mockResolvedValue({ cells: [], allowedActions: [] })
  studentGet.mockResolvedValue({ student: { id: 'st-2', schoolId: SCHOOL, version: 1, firstName: 'Student B', admissionNumber: 'B/2026-27/001', status: 'active', anonymised: false }, guardianContacts: [{ id: 'g1', displayName: 'Asha Rao', relation: 'mother', phone: '9876543210' }], allowedActions: [] })
})

describe('dashboard by audience', () => {
  it('shows the office counts, the class strengths and recent activity', async () => {
    dashboardGet.mockResolvedValue({ audience: 'office', activeStudents: 16, staffCount: 29 })
    await renderDashboard({
      roleKeys: ['owner'],
      capabilities: ['dashboard.read', 'sections.read', 'sections.read_strengths', 'grades.read', 'academic_years.read', 'audit.read', 'students.create'],
    })

    expect(await screen.findByText('16')).toBeInTheDocument()
    expect(screen.getByText('29')).toBeInTheDocument()
    expect(await screen.findByText('Six A')).toBeInTheDocument()
    expect(await screen.findByText('admitted a student')).toBeInTheDocument()
    expect(screen.getByText('Admit student')).toBeInTheDocument()
  })

  it('hides a quick action and recent activity when the capability is missing', async () => {
    dashboardGet.mockResolvedValue({ audience: 'office', activeStudents: 1, staffCount: 1 })
    await renderDashboard({ roleKeys: ['principal'], capabilities: ['dashboard.read', 'sections.read', 'grades.read'] })

    await screen.findByText('Setup checklist')
    expect(screen.queryByText('Admit student')).not.toBeInTheDocument()
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument()
    expect(auditList).not.toHaveBeenCalled()
    expect(sectionStrengths).not.toHaveBeenCalled()
  })

  it('shows a teacher their own classes', async () => {
    dashboardGet.mockResolvedValue({
      audience: 'teacher',
      assignedSections: [{ id: 'sec-1', name: 'Six A' }],
      ownTimetable: [{ section: { id: 'sec-1', name: 'Six A' }, subject: { id: 'sub-1', name: 'Mathematics' }, teacher: { id: 't1', name: 'Fixture' }, dayOfWeek: 1, periodIndex: 1 }],
    })
    await renderDashboard({ roleKeys: ['teacher'], capabilities: ['dashboard.read', 'timetable.read', 'sections.read'] })

    expect(await screen.findByText('Your classes')).toBeInTheDocument()
    expect(screen.getAllByText('Six A').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Mathematics').length).toBeGreaterThan(0)
  })

  it('shows a parent one card per child and nothing about fees', async () => {
    dashboardGet.mockResolvedValue({
      audience: 'parent',
      children: [
        { id: 'st-1', schoolId: SCHOOL, version: 1, firstName: 'Student A2', admissionNumber: 'A/2026-27/002', status: 'active', enrollment: { id: 'e1', academicYear: { id: YEAR.id, name: '2026-27' }, section: { id: 'sec-1', name: 'A' }, grade: { id: 'grade-1', name: 'Six' }, outcome: 'ongoing' } },
        { id: 'st-2', schoolId: SCHOOL, version: 1, firstName: 'Student B', admissionNumber: 'B/2026-27/001', status: 'active' },
      ],
    })
    await renderDashboard({ roleKeys: ['parent'], capabilities: ['dashboard.read', 'timetable.read', 'students.read_basic', 'students.read_enrollments', 'sections.read'] })

    expect(await screen.findByText('Student A2')).toBeInTheDocument()
    // The parent may read enrollments, so a missing block really does mean no class.
    expect(screen.getByText('Not in a class this year.')).toBeInTheDocument()
    expect(screen.queryByText(/fee/i)).not.toBeInTheDocument()
    await waitFor(() => expect(forSection).toHaveBeenCalledWith(SCHOOL, 'sec-1', { academicYearId: YEAR.id }))
  })

  it('lets a parent give a consent their child record allows, through the portal', async () => {
    dashboardGet.mockResolvedValue({
      audience: 'parent',
      children: [{ id: 'st-2', schoolId: SCHOOL, version: 1, firstName: 'Student B', admissionNumber: 'B/2026-27/001', status: 'active', anonymised: false }],
    })
    studentConsents.mockResolvedValue({
      items: [{
        id: 'c1', studentId: 'st-2', guardianId: 'g1', guardianDisplayName: 'Asha Rao',
        purpose: 'photographs', status: 'withdrawn', method: 'portal',
        recordedAt: '2026-04-02T10:00:00.000Z', recordedBy: 'guardian',
      }],
      allowedActions: ['students.read_consents', 'students.manage_consents'],
    })
    recordConsent.mockResolvedValue({ items: [], allowedActions: ['students.read_consents', 'students.manage_consents'] })
    const user = userEvent.setup()
    await renderDashboard({
      roleKeys: ['parent'],
      capabilities: ['dashboard.read', 'students.read_basic', 'students.read_consents', 'students.manage_consents'],
    })

    const row = (await screen.findByText('Photographs')).closest('li')!
    expect(within(row).getByText('Withdrawn')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Give' }))

    await waitFor(() => expect(recordConsent).toHaveBeenCalledWith(SCHOOL, 'st-2', {
      guardianId: 'g1', purpose: 'photographs', status: 'given', method: 'portal',
    }))
  })

  it('lets a parent give a first consent when nothing has been recorded yet', async () => {
    dashboardGet.mockResolvedValue({
      audience: 'parent',
      children: [{ id: 'st-2', schoolId: SCHOOL, version: 1, firstName: 'Student B', admissionNumber: 'B/2026-27/001', status: 'active', anonymised: false }],
    })
    // No consent rows at all: the guardians come from the child's own record.
    studentConsents.mockResolvedValue({ items: [], allowedActions: ['students.read_consents', 'students.manage_consents'] })
    recordConsent.mockResolvedValue({ items: [], allowedActions: ['students.read_consents', 'students.manage_consents'] })
    const user = userEvent.setup()
    await renderDashboard({
      roleKeys: ['parent'],
      capabilities: ['dashboard.read', 'students.read_basic', 'students.read_consents', 'students.manage_consents'],
    })

    const row = (await screen.findByText('Photographs')).closest('li')!
    expect(within(row).getByText('Not asked')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: 'Give' }))

    await waitFor(() => expect(recordConsent).toHaveBeenCalledWith(SCHOOL, 'st-2', {
      guardianId: 'g1', purpose: 'photographs', status: 'given', method: 'portal',
    }))
  })

  it('does not claim a child has no class when enrollments are not readable', async () => {
    dashboardGet.mockResolvedValue({
      audience: 'parent',
      children: [{ id: 'st-2', schoolId: SCHOOL, version: 1, firstName: 'Student B', admissionNumber: 'B/2026-27/001', status: 'active' }],
    })
    await renderDashboard({ roleKeys: ['parent'], capabilities: ['dashboard.read', 'timetable.read', 'students.read_basic'] })

    expect(await screen.findByText('Student B')).toBeInTheDocument()
    expect(screen.getByText('Class not shown.')).toBeInTheDocument()
    expect(screen.queryByText('Not in a class this year.')).not.toBeInTheDocument()
  })

  it('says one sentence when the dashboard read is refused', async () => {
    dashboardGet.mockRejectedValue(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'no' }))
    await renderDashboard({ roleKeys: ['principal'], capabilities: [] })

    expect(await screen.findByText('We could not open your dashboard')).toBeInTheDocument()
    expect(screen.getByText('You do not have permission to do this.')).toBeInTheDocument()
  })
})
