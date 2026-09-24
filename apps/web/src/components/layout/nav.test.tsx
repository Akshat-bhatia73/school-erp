import type { ReactNode } from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeDashboardView } from '@/lib/dashboard-view'
import { renderWithSession } from '@/test/session'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    useNavigate: () => vi.fn(),
    useRouterState: () => '/dashboard',
  }
})

const dashboardGet = vi.fn()
const studentCount = vi.fn()
const staffCount = vi.fn()
const searchRun = vi.fn()
const academicYears = vi.fn()
const sections = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    dashboard: { get: (...args: unknown[]) => dashboardGet(...args) },
    students: { count: (...args: unknown[]) => studentCount(...args) },
    staff: { count: (...args: unknown[]) => staffCount(...args) },
    search: { run: (...args: unknown[]) => searchRun(...args) },
    messages: { unread: async () => ({ unread: 0 }) },
    setup: {
      academicYears: (...args: unknown[]) => academicYears(...args),
      sections: (...args: unknown[]) => sections(...args),
    },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'

// cmdk scrolls the active item into view; jsdom has no such method.
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
  dashboardGet.mockResolvedValue({ audience: 'office', activeStudents: 16, staffCount: 29 })
  academicYears.mockResolvedValue([{ id: 'year-1', schoolId: SCHOOL, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current', version: 1 }])
  sections.mockResolvedValue([])
  studentCount.mockResolvedValue({ count: 16 })
  staffCount.mockResolvedValue({ count: 29 })
  searchRun.mockResolvedValue({ students: [], staff: [] })
})

describe('Sidebar', () => {
  it('shows every allowed destination and the office counts', async () => {
    const { Sidebar } = await import('./sidebar')
    renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, {
      roleKeys: ['owner'],
      capabilities: ['students.read_basic', 'staff.read_directory', 'timetable.read', 'school.read', 'academic_years.read', 'audit.read'],
    })

    expect(screen.getByText('Students')).toBeInTheDocument()
    expect(screen.getByText('Audit log')).toBeInTheDocument()
    expect(await screen.findByText('16')).toBeInTheDocument()
    expect(await screen.findByText('29')).toBeInTheDocument()
    // The counts come from the module prefixes so student and staff writes refresh them.
    expect(studentCount).toHaveBeenCalledWith(SCHOOL, { status: 'active' })
    expect(staffCount).toHaveBeenCalledWith(SCHOOL)
    expect(await screen.findByText(/2026-27/)).toBeInTheDocument()
  })

  it('drops a destination and its section label when the capability is missing', async () => {
    const { Sidebar } = await import('./sidebar')
    renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, {
      roleKeys: ['teacher'],
      capabilities: ['students.read_basic', 'timetable.read'],
    })

    expect(screen.getByText('Students')).toBeInTheDocument()
    expect(screen.queryByText('Staff')).not.toBeInTheDocument()
    expect(screen.queryByText('Settings')).not.toBeInTheDocument()
    expect(screen.queryByText('School setup')).not.toBeInTheDocument()
    expect(screen.queryByText('Coming next')).not.toBeInTheDocument()
    expect(studentCount).not.toHaveBeenCalled()
    expect(staffCount).not.toHaveBeenCalled()
    expect(dashboardGet).not.toHaveBeenCalled()
  })

  it('offers Exams to anybody who reads exams or report cards, and its settings to the office', async () => {
    const { Sidebar } = await import('./sidebar')
    const { unmount } = renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, {
      roleKeys: ['owner'],
      capabilities: ['exams.read', 'exams.manage', 'members.read'],
    })
    expect(screen.getByText('Exams')).toBeInTheDocument()
    expect(screen.getByText('Exams & report cards')).toBeInTheDocument()
    expect(screen.queryByText('Exams & marks')).not.toBeInTheDocument()
    unmount()

    renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, {
      roleKeys: ['parent'],
      capabilities: ['report_cards.read'],
    })
    expect(screen.getByText('Exams')).toBeInTheDocument()
    expect(screen.queryByText('Exams & report cards')).not.toBeInTheDocument()
  })

  it('hides Exams from somebody who reads neither', async () => {
    const { Sidebar } = await import('./sidebar')
    renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, { roleKeys: ['accountant'], capabilities: ['fees.read'] })
    expect(screen.queryByText('Exams')).not.toBeInTheDocument()
  })

  it('greets a parent with My children and no quick actions', async () => {
    const { Sidebar } = await import('./sidebar')
    renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, {
      roleKeys: ['parent'],
      capabilities: ['students.read_basic', 'timetable.read'],
    })

    expect(screen.getByText('My children')).toBeInTheDocument()
    expect(screen.queryByText('Quick actions')).not.toBeInTheDocument()
    expect(screen.getAllByText('Saraswati Vidya Mandir').length).toBeGreaterThan(0)
  })

  it('shapes the nav by the chosen view, not the highest role', async () => {
    writeDashboardView('user-1', 'parent')
    const { Sidebar } = await import('./sidebar')
    renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, {
      roleKeys: ['teacher', 'parent'],
      capabilities: ['students.read_basic', 'timetable.read'],
    })

    expect(screen.getByText('My children')).toBeInTheDocument()
    expect(screen.queryByText('Quick actions')).not.toBeInTheDocument()
    // Rights are the union whatever the view: the student list is still there.
    expect(screen.getByText('Students')).toBeInTheDocument()
  })
})

describe('a pupil', () => {
  // Everything the student role grants, including the own-record reads that also gate office screens.
  const PUPIL_CAPABILITIES = [
    'grades.read', 'sections.read', 'subjects.read', 'holidays.read', 'students.read_basic', 'students.read_enrollments',
    'timetable.read', 'dashboard.read', 'attendance.read', 'exams.read', 'report_cards.read', 'communication.read',
  ] as const

  it('sees Home, Timetable, Attendance, Exams and Messages and nothing of the office', async () => {
    const { Sidebar } = await import('./sidebar')
    renderWithSession(<Sidebar onOpenQuickActions={() => {}} />, { roleKeys: ['student'], capabilities: [...PUPIL_CAPABILITIES] })

    const links = screen.getAllByRole('link').map((link) => link.textContent)
    expect(links).toEqual(['Home', 'Timetable', 'Attendance', 'Exams', 'Messages'])
    expect(screen.queryByText('Students')).not.toBeInTheDocument()
    expect(screen.queryByText('School setup')).not.toBeInTheDocument()
    expect(screen.queryByText('Quick actions')).not.toBeInTheDocument()
    expect(studentCount).not.toHaveBeenCalled()
  })

  it('has no Viewing as choice', async () => {
    const { AccountMenu } = await import('@/components/auth/account-menu')
    renderWithSession(<AccountMenu />, { roleKeys: ['student'], capabilities: [] })
    await userEvent.click(screen.getByRole('button', { name: /Account menu/ }))
    expect(await screen.findByText('Account security')).toBeInTheDocument()
    expect(screen.queryByText('Viewing as')).not.toBeInTheDocument()
  })

  it('never searches people from the quick menu', async () => {
    const { CommandMenu } = await import('./command-menu')
    renderWithSession(<CommandMenu open onOpenChange={() => {}} />, { roleKeys: ['student'], capabilities: [...PUPIL_CAPABILITIES] })
    expect(screen.queryByText('Classes & sections')).not.toBeInTheDocument()
    await userEvent.type(screen.getByPlaceholderText(/Search screens/), 'stu')
    await waitFor(() => expect(screen.queryByText('Students')).not.toBeInTheDocument())
    expect(searchRun).not.toHaveBeenCalled()
  })
})

describe('the Viewing as switcher', () => {
  it('is absent for a membership that earns one home', async () => {
    const { AccountMenu } = await import('@/components/auth/account-menu')
    renderWithSession(<AccountMenu />, { roleKeys: ['teacher'], capabilities: [] })

    await userEvent.click(screen.getByRole('button', { name: /Account menu/ }))
    expect(await screen.findByText('Sign out')).toBeInTheDocument()
    expect(screen.queryByText('Viewing as')).not.toBeInTheDocument()
  })

  it('lists the homes the roles earn, ticks the current one and remembers a choice', async () => {
    const { AccountMenu } = await import('@/components/auth/account-menu')
    const { queryClient } = renderWithSession(<AccountMenu />, { roleKeys: ['teacher', 'parent'], capabilities: [] })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    await userEvent.click(screen.getByRole('button', { name: /Account menu/ }))
    expect(await screen.findByText('Viewing as')).toBeInTheDocument()
    const teacher = screen.getByRole('menuitemradio', { name: 'Teacher' })
    const parent = screen.getByRole('menuitemradio', { name: 'Parent' })
    expect(teacher).toHaveAttribute('aria-checked', 'true')
    expect(parent).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('menuitemradio', { name: 'Office' })).not.toBeInTheDocument()

    await userEvent.click(parent)
    expect(window.localStorage.getItem('erp.dashboardView.user-1')).toBe('parent')
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL, 'dashboard'] })
  })
})

describe('CommandMenu', () => {
  it('lists only the actions the person may take and searches people', async () => {
    searchRun.mockResolvedValue({
      students: [{ id: 'st-1', schoolId: SCHOOL, version: 1, firstName: 'Student A2', admissionNumber: 'A/2026-27/002', status: 'active', enrollment: { id: 'e1', academicYear: { id: 'y', name: '2026-27' }, section: { id: 's', name: 'A' }, grade: { id: 'g', name: 'Six' }, outcome: 'ongoing' } }],
      staff: [{ id: 'sf-1', schoolId: SCHOOL, version: 1, displayName: 'Invited Teacher', designation: 'Teacher' }],
    })
    const { CommandMenu } = await import('./command-menu')
    renderWithSession(<CommandMenu open onOpenChange={() => {}} />, {
      roleKeys: ['principal'],
      capabilities: ['students.read_basic', 'students.create', 'staff.read_directory'],
    })

    expect(screen.getByText('Admit student')).toBeInTheDocument()
    expect(screen.queryByText('Invite user')).not.toBeInTheDocument()
    expect(screen.queryByText('Promote students')).not.toBeInTheDocument()

    await userEvent.type(screen.getByPlaceholderText(/Search screens/), 'stu')
    await waitFor(() => expect(searchRun).toHaveBeenCalledWith(SCHOOL, 'stu'))
    expect(await screen.findByText('Student A2')).toBeInTheDocument()
    expect(screen.getByText('Invited Teacher')).toBeInTheDocument()
  })

  it('never searches for a parent who cannot read a student', async () => {
    const { CommandMenu } = await import('./command-menu')
    renderWithSession(<CommandMenu open onOpenChange={() => {}} />, { roleKeys: ['parent'], capabilities: ['timetable.read'] })

    await userEvent.type(screen.getByPlaceholderText(/Search screens/), 'stu')
    await waitFor(() => expect(screen.queryByText('Students')).not.toBeInTheDocument())
    expect(searchRun).not.toHaveBeenCalled()
  })
})
