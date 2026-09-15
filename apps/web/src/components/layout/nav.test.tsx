import type { ReactNode } from 'react'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
})

describe('CommandMenu', () => {
  it('lists only the actions the person may take and searches people', async () => {
    searchRun.mockResolvedValue({
      students: [{ id: 'st-1', schoolId: SCHOOL, version: 1, firstName: 'Student A2', admissionNumber: 'FIX-A2', status: 'active', enrollment: { id: 'e1', academicYear: { id: 'y', name: '2026-27' }, section: { id: 's', name: 'A' }, grade: { id: 'g', name: 'Six' }, outcome: 'ongoing' } }],
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
