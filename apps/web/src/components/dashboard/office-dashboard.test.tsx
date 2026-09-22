/**
 * The office dashboard: one sentence about today, the things waiting on a person, the school in
 * numbers and what is coming up. Every block is there only when the server sent it.
 */
import type { ReactNode } from 'react'
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeDashboard as OfficeDashboardData, PermissionKey } from '@erp/contracts'
import { OfficeDashboard } from '@/components/dashboard/office-dashboard'
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

const OFFICE_CAPABILITIES: PermissionKey[] = [
  'dashboard.read', 'students.read_basic', 'staff.read_directory', 'timetable.read', 'audit.read',
]

function office(patch: Partial<OfficeDashboardData> = {}): OfficeDashboardData {
  return {
    audience: 'office',
    day: { date: '2026-09-21', dayOfWeek: 1, kind: 'school_day' },
    academicYear: { id: 'year-1', name: '2026-27' },
    attention: [],
    holidays: [],
    ...patch,
  } as OfficeDashboardData
}

function renderOffice(data: OfficeDashboardData, capabilities: PermissionKey[] = OFFICE_CAPABILITIES) {
  return renderWithSession(<OfficeDashboard data={data} isLoading={false} error={undefined} />, {
    roleKeys: ['owner'],
    capabilities,
  })
}

/** April to March of one academic year, the twelve bars the chart draws. */
const ADMISSION_MONTHS = [
  '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09',
  '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03',
].map((month, i) => ({ month, count: i }))

beforeEach(() => vi.clearAllMocks())

describe('office dashboard, the sentence about today', () => {
  it('uses the singular for one teacher away and one period without cover', () => {
    renderOffice(office({ today: { teachersAway: 1, periodsWithoutCover: 1 } }))
    expect(screen.getByText('School day. 1 teacher is away, 1 period has no cover yet.')).toBeInTheDocument()
  })

  it('uses the plural for two teachers away and two periods without cover', () => {
    renderOffice(office({ today: { teachersAway: 2, periodsWithoutCover: 2 } }))
    expect(screen.getByText('School day. 2 teachers are away, 2 periods have no cover yet.')).toBeInTheDocument()
  })

  it('says every period has cover when nobody is missing one', () => {
    renderOffice(office({ today: { teachersAway: 2, periodsWithoutCover: 0 } }))
    expect(screen.getByText('School day. 2 teachers are away, every period has cover.')).toBeInTheDocument()
  })

  it('names the holiday and the next school day', () => {
    renderOffice(office({
      day: { date: '2026-10-02', dayOfWeek: 5, kind: 'holiday', holidayName: 'Gandhi Jayanti', nextSchoolDay: { date: '2026-10-03', dayOfWeek: 6 } },
    }))
    expect(screen.getByText('No school today (Gandhi Jayanti). The next school day is Saturday, 3 Oct.')).toBeInTheDocument()
  })

  it('says no school on a Sunday without inventing a reason', () => {
    renderOffice(office({
      day: { date: '2026-09-20', dayOfWeek: 0, kind: 'sunday', nextSchoolDay: { date: '2026-09-21', dayOfWeek: 1 } },
    }))
    expect(screen.getByText('No school today. The next school day is Monday, 21 Sept.')).toBeInTheDocument()
  })
})

describe('office dashboard, needs attention', () => {
  it('lists each key that has a count, with a link to where the work is done', () => {
    renderOffice(office({
      attention: [
        { key: 'periods_without_cover', count: 1 },
        { key: 'students_without_guardian_phone', count: 4 },
        { key: 'sections_without_class_teacher', count: 0 },
      ],
    }))
    const cover = screen.getByText('1 period has no cover today')
    expect(cover.closest('a')).toHaveAttribute('href', '/timetable/substitutions')
    expect(screen.getByText('4 students without a guardian phone').closest('a')).toHaveAttribute('href', '/students')
    expect(screen.queryByText(/class teacher/)).not.toBeInTheDocument()
  })

  it('says all clear when every key the office may read is at zero', () => {
    renderOffice(office({ attention: [{ key: 'staff_without_login', count: 0 }] }))
    expect(screen.getByText('All clear')).toBeInTheDocument()
    expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument()
  })
})

describe('office dashboard, the blocks', () => {
  it('shows the glance tiles and students per teacher', () => {
    renderOffice(office({
      glance: { students: { total: 240 }, mix: { boys: 130, girls: 108, other: 2 }, admittedThisMonth: 6, leftThisMonth: 1 },
      studentsPerTeacher: 18.46,
    }))
    expect(screen.getByText('240')).toBeInTheDocument()
    expect(screen.getByText('130 boys · 108 girls')).toBeInTheDocument()
    expect(screen.getByText('New this month')).toBeInTheDocument()
    expect(screen.getByText('18.5')).toBeInTheDocument()
  })

  it('shows one pill per section and twelve bars for the year', () => {
    const { container } = renderOffice(office({
      classStrength: [{ grade: { id: 'g1', name: 'Six' }, sections: [{ id: 's1', name: 'A', count: 30 }, { id: 's2', name: 'B', count: 28 }] }],
      admissionsByMonth: ADMISSION_MONTHS,
    }))
    expect(screen.getByText('Six')).toBeInTheDocument()
    expect(screen.getByText('A 30 · B 28')).toBeInTheDocument()
    expect(screen.getByText('58')).toBeInTheDocument()
    expect(container.querySelectorAll('svg[aria-label="Admissions by month"] > g')).toHaveLength(12)
  })

  it('shows the holidays and the birthdays that are coming up', () => {
    renderOffice(office({
      holidays: [{ id: 'h1', name: 'Diwali', startDate: '2026-11-08', endDate: '2026-11-12', type: 'festival' }],
      birthdays: {
        today: [{ kind: 'student', id: 'st-1', name: 'Aarav Sharma', className: 'Six A', date: '2026-09-21' }],
        thisWeek: [{ kind: 'staff', id: 'sf-1', name: 'Meena Iyer', date: '2026-09-24' }],
      },
    }))
    expect(screen.getByText('Diwali')).toBeInTheDocument()
    expect(screen.getByText('8 Nov 2026 to 12 Nov 2026')).toBeInTheDocument()
    expect(screen.getByText('Birthdays today')).toBeInTheDocument()
    expect(screen.getByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.getByText('Meena Iyer')).toBeInTheDocument()
    expect(screen.getByText('Staff')).toBeInTheDocument()
  })

  it('shows recent activity, and the security list only when the server sent one', () => {
    const { unmount } = renderOffice(office({
      recentActivity: [{ id: 'a1', at: '2026-09-21T04:00:00.000Z', actorDisplayName: 'Asha Rao', action: 'students.create', summary: 'admitted a student', outcome: 'allowed' }],
    }))
    expect(screen.getByText('admitted a student')).toBeInTheDocument()
    expect(screen.queryByText('Security')).not.toBeInTheDocument()
    unmount()

    renderOffice(office({
      recentActivity: [],
      securityEvents: [{ id: 'a2', at: '2026-09-21T04:00:00.000Z', actorDisplayName: 'Asha Rao', action: 'roles.change', summary: 'changed a role', outcome: 'denied' }],
    }))
    expect(screen.getByText('Security')).toBeInTheDocument()
    expect(screen.getByText('changed a role')).toBeInTheDocument()
  })

  it('leaves out recent activity altogether when the block was not sent', () => {
    renderOffice(office({}))
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument()
    expect(screen.queryByText('School at a glance')).not.toBeInTheDocument()
    expect(screen.queryByText('Class strength')).not.toBeInTheDocument()
  })
})

describe('office dashboard, setting up', () => {
  const steps = (doneCount: number) =>
    (['school', 'years', 'grades', 'sections', 'subjects'] as const).map((key, i) => ({ key, done: i < doneCount }))

  it('shows the checklist while steps are open', () => {
    renderOffice(office({ setup: { steps: steps(3) } }))
    expect(screen.getByText('Finish setting up')).toBeInTheDocument()
    expect(screen.getByText('Add sections')).toBeInTheDocument()
  })

  it('hides the checklist when all five steps are done', () => {
    renderOffice(office({ setup: { steps: steps(5) } }))
    expect(screen.queryByText('Finish setting up')).not.toBeInTheDocument()
  })
})

describe('office dashboard, permissions', () => {
  it('does not render Admit student without students.create', () => {
    renderOffice(office({ today: { teachersAway: 0, periodsWithoutCover: 0 } }))
    expect(screen.queryByText('Admit student')).not.toBeInTheDocument()
    expect(screen.getByText('Open substitutions')).toBeInTheDocument()
  })

  it('renders Admit student when the person may admit', () => {
    renderOffice(office({}), [...OFFICE_CAPABILITIES, 'students.create'])
    expect(screen.getByText('Admit student')).toBeInTheDocument()
  })

  it('names the next holiday and the birthdays today in the hero chips', () => {
    renderOffice(office({
      holidays: [{ id: 'h1', name: 'Gandhi Jayanti', startDate: '2026-10-02', endDate: '2026-10-02', type: 'national' }],
      birthdays: { today: [{ kind: 'student', id: 's1', name: 'Aarav Sharma', date: '2026-09-21', className: 'Six A' }], thisWeek: [] },
    }))
    expect(screen.getByText('Next holiday: Gandhi Jayanti, 2 Oct')).toBeInTheDocument()
    expect(screen.getByText('1 birthday today')).toBeInTheDocument()
  })
})

describe('office dashboard, the money cards', () => {
  it('shows the four fee numbers when the block is there', () => {
    renderOffice(office({
      fees: {
        collectedTodayPaise: 1_250_00, receiptsToday: 4, collectedThisMonthPaise: 4_50_000_00,
        outstandingPaise: 1_20_000_00, studentsWithDues: 17,
      },
    }))
    expect(screen.getByText('Collected today')).toBeInTheDocument()
    expect(screen.getByText('4 receipts')).toBeInTheDocument()
    expect(screen.getByText('Pupils with dues')).toBeInTheDocument()
    expect(screen.getByText('Outstanding dues').closest('a')).toHaveAttribute('href', '/fees')
  })

  it('draws nothing about money when the block was not sent', () => {
    renderOffice(office())
    expect(screen.queryByText('Collected today')).not.toBeInTheDocument()
  })
})
