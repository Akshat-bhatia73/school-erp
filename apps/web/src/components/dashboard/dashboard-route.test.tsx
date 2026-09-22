/**
 * The dashboard route: one read, then the screen for whatever audience the server answered with.
 * The browser never picks the audience and never asks a second endpoint for it.
 */
import type { ReactNode } from 'react'
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
const academicYears = vi.fn()
const sections = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    dashboard: { get: (...args: unknown[]) => dashboardGet(...args) },
    setup: {
      academicYears: (...args: unknown[]) => academicYears(...args),
      sections: (...args: unknown[]) => sections(...args),
    },
    students: {
      photoUrl: () => 'blob:photo',
      consents: vi.fn(),
      get: vi.fn(),
      recordConsent: vi.fn(),
      subjectAccess: vi.fn(),
    },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'
const DAY = { date: '2026-09-21', dayOfWeek: 1, kind: 'school_day' as const }

async function renderRoute(options: Parameters<typeof renderWithSession>[1]) {
  const module = await import('@/routes/_app/dashboard')
  const Component = (module.Route as unknown as { component: () => ReactNode }).component
  return renderWithSession(<Component />, options)
}

beforeEach(() => {
  vi.clearAllMocks()
  academicYears.mockResolvedValue([{ id: 'year-1', schoolId: SCHOOL, name: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', status: 'current', version: 1 }])
  sections.mockResolvedValue([])
})

describe('the dashboard route', () => {
  it('shows a calm skeleton while the first read is on its way', async () => {
    let answer: (value: unknown) => void = () => {}
    dashboardGet.mockImplementation(() => new Promise((resolve) => { answer = resolve }))
    const { container } = await renderRoute({ roleKeys: ['owner'], capabilities: ['dashboard.read', 'academic_years.read'] })

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    answer({ audience: 'office', day: DAY, academicYear: null, attention: [], holidays: [] })
    expect(await screen.findByText('School day.')).toBeInTheDocument()
  })

  it('says one sentence when the read is refused', async () => {
    dashboardGet.mockRejectedValue(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'no' }))
    await renderRoute({ roleKeys: ['principal'], capabilities: [] })

    expect(await screen.findByText('We could not open your dashboard')).toBeInTheDocument()
    expect(screen.getByText('You do not have permission to do this.')).toBeInTheDocument()
  })

  it('asks the server once and shows the office screen it answered with', async () => {
    dashboardGet.mockResolvedValue({
      audience: 'office', day: DAY, academicYear: { id: 'year-1', name: '2026-27' },
      attention: [{ key: 'staff_without_login', count: 2 }], holidays: [],
    })
    await renderRoute({ roleKeys: ['owner'], capabilities: ['dashboard.read', 'academic_years.read'] })

    expect(await screen.findByText('2 staff without a login')).toBeInTheDocument()
    expect(dashboardGet).toHaveBeenCalledTimes(1)
    expect(dashboardGet).toHaveBeenCalledWith(SCHOOL)
    expect(screen.getAllByText('Dashboard').length).toBeGreaterThan(0)
  })

  it('shows the teacher screen when the server says teacher', async () => {
    dashboardGet.mockResolvedValue({
      audience: 'teacher', day: DAY, staffLinked: true, academicYearId: 'year-1',
      timeline: [], timelineDate: '2026-09-21', week: [], periods: [], holidays: [],
    })
    await renderRoute({ roleKeys: ['teacher'], capabilities: ['dashboard.read'] })

    // 'My week' is the teacher screen's own card; the now-and-next sentence now lives in the hero.
    expect(await screen.findByText('My week')).toBeInTheDocument()
  })

  it('shows the parent screen, with the crumb a parent expects', async () => {
    dashboardGet.mockResolvedValue({ audience: 'parent', day: DAY, children: [] })
    await renderRoute({ roleKeys: ['parent'], capabilities: ['dashboard.read'] })

    expect(await screen.findByText('No child is linked to your login yet')).toBeInTheDocument()
    expect(screen.getAllByText('My children').length).toBeGreaterThan(0)
  })

  it('shows the accountant screen when the server says accountant', async () => {
    dashboardGet.mockResolvedValue({
      audience: 'accountant',
      day: DAY,
      fees: {
        collectedTodayPaise: 125000, receiptsToday: 4, collectedThisMonthPaise: 45000000,
        outstandingPaise: 12000000, studentsWithDues: 17,
      },
    })
    await renderRoute({ roleKeys: ['accountant'], capabilities: ['dashboard.read'] })

    expect(await screen.findByText('Collected today')).toBeInTheDocument()
  })
})
