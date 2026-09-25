/**
 * The parent home: one card per child, today's classes, the next holiday and anything the school
 * is still waiting for.
 */
import type { ReactNode } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParentDashboard as ParentDashboardData, PermissionKey } from '@erp/contracts'
import { ParentDashboard } from '@/components/dashboard/parent-dashboard'
import { renderWithSession } from '@/test/session'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: unknown) => options,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    useNavigate: () => vi.fn(),
  }
})

const photoUrl = vi.fn(() => 'blob:photo')
const consents = vi.fn()
const studentGet = vi.fn()
const recordConsent = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

vi.mock('@/lib/api', () => ({
  api: {
    students: {
      photoUrl: (...args: unknown[]) => photoUrl(...(args as [])),
      consents: (...args: unknown[]) => consents(...args),
      get: (...args: unknown[]) => studentGet(...args),
      recordConsent: (...args: unknown[]) => recordConsent(...args),
      subjectAccess: vi.fn(),
    },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'

function child(patch: Partial<ParentDashboardData['children'][number]> = {}): ParentDashboardData['children'][number] {
  return {
    student: {
      id: 'st-1', schoolId: SCHOOL, version: 1, firstName: 'Aarav', lastName: 'Sharma',
      admissionNumber: 'SVM/2026/101', status: 'active', anonymised: false, hasPhoto: false,
    },
    enrollment: {
      id: 'e1', academicYear: { id: 'year-1', name: '2026-27' },
      section: { id: 'sec-1', name: 'A' }, grade: { id: 'g1', name: 'Six' },
      rollNumber: 7, outcome: 'ongoing',
    },
    classTeacher: { id: 'sf-1', name: 'Meena Iyer' },
    todayLessons: [
      { periodIndex: 1, name: 'Period 1', startTime: '08:00', endTime: '08:45', type: 'period', lesson: { section: { id: 'sec-1', name: 'Six A' }, subject: { id: 'sub-1', name: 'Mathematics' }, cover: false } },
    ],
    nextHoliday: { id: 'h1', name: 'Diwali', startDate: '2026-11-08', endDate: '2026-11-12', type: 'festival' },
    hasPupilLogin: false,
    assistantConsent: 'none',
    waitingOn: [],
    ...patch,
  } as ParentDashboardData['children'][number]
}

function parent(patch: Partial<ParentDashboardData> = {}): ParentDashboardData {
  return {
    audience: 'parent',
    day: { date: '2026-09-21', dayOfWeek: 1, kind: 'school_day' },
    children: [child()],
    ...patch,
  } as ParentDashboardData
}

function renderParent(data: ParentDashboardData) {
  return renderWithSession(<ParentDashboard data={data} isLoading={false} error={undefined} />, {
    roleKeys: ['parent'],
    capabilities: ['dashboard.read', 'students.read_basic', 'students.read_consents'],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  consents.mockResolvedValue({ items: [], allowedActions: [] })
  studentGet.mockResolvedValue({ student: null, guardianContacts: [], allowedActions: [] })
  recordConsent.mockResolvedValue({ items: [], allowedActions: [] })
})

describe('parent dashboard', () => {
  it('shows one card per child with the class, the class teacher and today', () => {
    renderParent(parent({
      children: [
        child(),
        child({ student: { id: 'st-2', schoolId: SCHOOL, version: 1, firstName: 'Diya', admissionNumber: 'SVM/2026/102', status: 'active', anonymised: false, hasPhoto: false } }),
      ],
    }))
    expect(screen.getByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.getByText('Diya')).toBeInTheDocument()
    // Per child: the header tag and the Class fact. Today's rows lead with the subject.
    expect(screen.getAllByText('Six A')).toHaveLength(4)
    expect(screen.getAllByText('Roll 7')).toHaveLength(2)
    expect(screen.getAllByText('Meena Iyer')).toHaveLength(2)
    expect(screen.getAllByText('Mathematics')).toHaveLength(2)
    expect(screen.getAllByText('Diwali, 8 Nov 2026 to 12 Nov 2026')).toHaveLength(2)
  })

  it('says all done when nothing is waiting, and names each consent when something is', () => {
    const { unmount } = renderParent(parent())
    expect(screen.getByText('All done.')).toBeInTheDocument()
    unmount()

    renderParent(parent({
      children: [child({ waitingOn: [{ kind: 'consent', purpose: 'photographs' }, { kind: 'consent', purpose: 'health_information' }] })],
    }))
    expect(screen.getByText('Consent for photographs')).toBeInTheDocument()
    expect(screen.getByText('Consent for health information')).toBeInTheDocument()
    expect(screen.getAllByText('Waiting')).toHaveLength(2)
  })

  it('says there is no school today instead of an empty timetable', () => {
    renderParent(parent({
      day: { date: '2026-10-02', dayOfWeek: 5, kind: 'holiday', holidayName: 'Gandhi Jayanti' },
      children: [child({ todayLessons: [] })],
    }))
    expect(screen.getByText('No school today. Gandhi Jayanti.')).toBeInTheDocument()
  })

  it('says nothing is on the timetable when a school day has no lessons', () => {
    renderParent(parent({ children: [child({ todayLessons: [] })] }))
    expect(screen.getByText('Nothing on the timetable today.')).toBeInTheDocument()
  })

  it('does not claim a class or a holiday the server did not send', () => {
    renderParent(parent({ children: [child({ enrollment: undefined, classTeacher: undefined, nextHoliday: undefined })] }))
    expect(screen.getByText('Not in a class this year')).toBeInTheDocument()
    expect(screen.getByText('Not set yet')).toBeInTheDocument()
    expect(screen.getByText('No holiday in the next 30 days.')).toBeInTheDocument()
  })

  it('says so plainly when no child is linked to the login', () => {
    renderParent(parent({ children: [] }))
    expect(screen.getByText('No child is linked to your login yet')).toBeInTheDocument()
    expect(screen.getByText('Ask the school office to link your children to your account.')).toBeInTheDocument()
  })

  it('opens the consent block only when the parent asks for it', () => {
    renderParent(parent())
    expect(screen.getByRole('button', { name: 'Manage consent' })).toBeInTheDocument()
    expect(consents).not.toHaveBeenCalled()
  })
})

describe('parent dashboard, fees', () => {
  it('links to the statement when something is owed', () => {
    renderParent(parent({ children: [child({ feesDuePaise: 250000 })] }))
    expect(screen.getByText('Fees due ₹2,500')).toBeInTheDocument()
  })

  it('says there is nothing to pay when the figure is zero', () => {
    renderParent(parent({ children: [child({ feesDuePaise: 0 })] }))
    expect(screen.getByText('No fees due')).toBeInTheDocument()
  })

  it('says nothing about fees when the figure was not sent', () => {
    renderParent(parent())
    expect(screen.queryByText('No fees due')).not.toBeInTheDocument()
  })
})

describe('parent dashboard, allow school messages', () => {
  const GUARDIAN = '20000000-0000-4000-8000-000000000041'
  const waitingMessages = [{ kind: 'consent' as const, purpose: 'communication' as const }]
  const ira = child({
    student: { id: 'st-2', schoolId: SCHOOL, version: 1, firstName: 'Ira', lastName: 'Sharma', admissionNumber: 'SVM/2026/102', status: 'active', anonymised: false, hasPhoto: false },
    waitingOn: waitingMessages,
  })

  function renderAsker(data: ParentDashboardData, capabilities: PermissionKey[] = ['dashboard.read', 'students.read_basic', 'students.read_consents', 'students.manage_consents']) {
    return renderWithSession(<ParentDashboard data={data} isLoading={false} error={undefined} />, {
      roleKeys: ['parent'],
      capabilities,
    })
  }

  it('asks once for every child still waiting, naming them in plain English', () => {
    renderAsker(parent({ guardianId: GUARDIAN, children: [child({ waitingOn: waitingMessages }), ira] }))
    expect(screen.getByText('Get messages from the school')).toBeInTheDocument()
    expect(screen.getByText(
      'The school sends notices, absence alerts, fee reminders and results in this app and by email. Allow them for Aarav and Ira.',
    )).toBeInTheDocument()
    expect(screen.getByText('You can turn this off any time under Manage consent.')).toBeInTheDocument()
    // Nothing is recorded just by opening the page.
    expect(recordConsent).not.toHaveBeenCalled()
  })

  it('names only the children still waiting on messages', () => {
    renderAsker(parent({ guardianId: GUARDIAN, children: [child({ waitingOn: [{ kind: 'consent', purpose: 'photographs' }] }), ira] }))
    expect(screen.getByText(/Allow them for Ira\.$/)).toBeInTheDocument()
  })

  it('records the consent for each waiting child, then says so and refreshes the home', async () => {
    const { queryClient } = renderAsker(parent({ guardianId: GUARDIAN, children: [child({ waitingOn: waitingMessages }), ira] }))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(screen.getByRole('button', { name: 'Allow school messages' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('School messages allowed'))
    expect(recordConsent).toHaveBeenCalledTimes(2)
    for (const studentId of ['st-1', 'st-2']) {
      expect(recordConsent).toHaveBeenCalledWith(SCHOOL, studentId, {
        guardianId: GUARDIAN, purpose: 'communication', status: 'given', method: 'portal',
      })
    }
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))
    expect(keys).toContain(JSON.stringify([SCHOOL, 'dashboard', {}]))
    expect(keys.filter((key) => key.includes('consents'))).toHaveLength(2)
  })

  it('reports a refusal in plain words', async () => {
    recordConsent.mockRejectedValueOnce(new Error('boom'))
    renderAsker(parent({ guardianId: GUARDIAN, children: [ira] }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow school messages' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('is not shown once nothing is waiting on messages', () => {
    renderAsker(parent({ guardianId: GUARDIAN, children: [child({ waitingOn: [{ kind: 'consent', purpose: 'photographs' }] })] }))
    expect(screen.queryByText('Get messages from the school')).not.toBeInTheDocument()
  })

  it('is not shown without a guardian record or without the right to answer', () => {
    const { unmount } = renderAsker(parent({ children: [ira] }))
    expect(screen.queryByText('Get messages from the school')).not.toBeInTheDocument()
    unmount()
    renderAsker(parent({ guardianId: GUARDIAN, children: [ira] }), ['dashboard.read', 'students.read_basic', 'students.read_consents'])
    expect(screen.queryByText('Get messages from the school')).not.toBeInTheDocument()
  })
})

describe('parent dashboard, allow the school assistant', () => {
  const GUARDIAN = '20000000-0000-4000-8000-000000000041'
  const riya = child({
    student: { id: 'st-3', schoolId: SCHOOL, version: 1, firstName: 'Riya', lastName: 'Sharma', admissionNumber: 'SVM/2026/103', status: 'active', anonymised: false, hasPhoto: false },
    hasPupilLogin: true,
    assistantConsent: 'none',
  })
  const TITLE = 'Let Riya use the school assistant'

  function renderAsker(data: ParentDashboardData, capabilities: PermissionKey[] = ['dashboard.read', 'students.read_basic', 'students.read_consents', 'students.manage_consents']) {
    return renderWithSession(<ParentDashboard data={data} isLoading={false} error={undefined} />, {
      roleKeys: ['parent'],
      capabilities,
    })
  }

  it('asks only for a child with their own login and no yes on record', () => {
    renderAsker(parent({ guardianId: GUARDIAN, children: [child(), riya] }))
    expect(screen.getByText(TITLE)).toBeInTheDocument()
    expect(screen.getByText(/Their questions go to Google to be answered\. Conversations are kept for 30 days/)).toBeInTheDocument()
    // The younger child has no login, so nobody asks about them.
    expect(screen.queryByText('Let Aarav use the school assistant')).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Allow' })).toHaveLength(1)
    // Nothing is recorded just by opening the page, and the school is not shown as waiting on it.
    expect(recordConsent).not.toHaveBeenCalled()
    expect(screen.queryByText('Consent for the school assistant')).not.toBeInTheDocument()
  })

  it('asks again after a withdrawal, and says nothing once it is given', () => {
    const { unmount } = renderAsker(parent({ guardianId: GUARDIAN, children: [{ ...riya, assistantConsent: 'withdrawn' }] }))
    expect(screen.getByText(TITLE)).toBeInTheDocument()
    unmount()
    renderAsker(parent({ guardianId: GUARDIAN, children: [{ ...riya, assistantConsent: 'given' }] }))
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('is not shown without a guardian record, the right to answer or a consent answer to read', () => {
    const { unmount } = renderAsker(parent({ children: [riya] }))
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
    unmount()
    const second = renderAsker(parent({ guardianId: GUARDIAN, children: [riya] }), ['dashboard.read', 'students.read_basic', 'students.read_consents'])
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
    second.unmount()
    renderAsker(parent({ guardianId: GUARDIAN, children: [{ ...riya, assistantConsent: undefined }] }))
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument()
  })

  it('records the assistant consent for that child through the portal, then refreshes the home', async () => {
    const { queryClient } = renderAsker(parent({ guardianId: GUARDIAN, children: [child(), riya] }))
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Riya can now use the school assistant'))
    expect(recordConsent).toHaveBeenCalledTimes(1)
    expect(recordConsent).toHaveBeenCalledWith(SCHOOL, 'st-3', {
      guardianId: GUARDIAN, purpose: 'ai_assistant', status: 'given', method: 'portal',
    })
    const keys = invalidate.mock.calls.map(([filters]) => JSON.stringify(filters?.queryKey))
    expect(keys).toContain(JSON.stringify([SCHOOL, 'dashboard', {}]))
  })
})
