/** The accountant home: the money cards, the students the school has and the shortcuts. */
import type { ReactNode } from 'react'
import { screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountantDashboard as AccountantDashboardData, PermissionKey } from '@erp/contracts'
import { AccountantDashboard } from '@/components/dashboard/accountant-dashboard'
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

function accountant(patch: Partial<AccountantDashboardData> = {}): AccountantDashboardData {
  return {
    audience: 'accountant',
    day: { date: '2026-09-21', dayOfWeek: 1, kind: 'school_day' },
    ...patch,
  } as AccountantDashboardData
}

function renderAccountant(data: AccountantDashboardData, capabilities: PermissionKey[] = ['dashboard.read']) {
  return renderWithSession(<AccountantDashboard data={data} isLoading={false} error={undefined} />, {
    roleKeys: ['accountant'],
    capabilities,
  })
}

beforeEach(() => vi.clearAllMocks())

describe('accountant dashboard', () => {
  it('shows the day, the student tiles and the money cards', () => {
    renderAccountant(accountant({
      glance: { students: { total: 240 }, mix: { boys: 130, girls: 108, other: 2 }, admittedThisMonth: 6, leftThisMonth: 1 },
      fees: {
        collectedTodayPaise: 1_250_00, receiptsToday: 4, collectedThisMonthPaise: 4_50_000_00,
        outstandingPaise: 1_20_000_00, studentsWithDues: 17,
      },
    }))
    expect(screen.getByText('School is open today.')).toBeInTheDocument()
    expect(screen.getByText('240')).toBeInTheDocument()
    expect(screen.getByText('130 boys, 108 girls')).toBeInTheDocument()
    expect(screen.getByText('₹1,250')).toBeInTheDocument()
    expect(screen.getByText('4 receipts')).toBeInTheDocument()
    expect(screen.getByText('17')).toBeInTheDocument()
  })

  it('draws nothing about money when the fees block was not sent', () => {
    renderAccountant(accountant())
    expect(screen.queryByText('Collected today')).not.toBeInTheDocument()
  })

  it('leaves the class strength card out when the block was not sent', () => {
    renderAccountant(accountant())
    expect(screen.queryByText('Class strength')).not.toBeInTheDocument()
    expect(screen.queryByText('Students')).not.toBeInTheDocument()
  })

  it('leaves the mix and the movement tiles out when only the roll was sent', () => {
    renderAccountant(accountant({ glance: { students: { total: 240 } } }))
    expect(screen.getByText('240')).toBeInTheDocument()
    expect(screen.queryByText('New this month')).not.toBeInTheDocument()
    expect(screen.queryByText('Left this month')).not.toBeInTheDocument()
  })

  it('falls back to no classes yet when the block is empty', () => {
    renderAccountant(accountant({ classStrength: [] }))
    expect(screen.getByText('No classes yet')).toBeInTheDocument()
  })

  it('lists each class when the block is there', () => {
    renderAccountant(accountant({
      classStrength: [{ grade: { id: 'g1', name: 'Six' }, sections: [{ id: 's1', name: 'A', count: 30 }] }],
    }))
    expect(screen.getByText('Six')).toBeInTheDocument()
    expect(screen.getByText('A 30')).toBeInTheDocument()
  })

  it('says when school reopens on a holiday', () => {
    renderAccountant(accountant({
      day: { date: '2026-10-02', dayOfWeek: 5, kind: 'holiday', holidayName: 'Gandhi Jayanti', nextSchoolDay: { date: '2026-10-03', dayOfWeek: 6 } },
    }))
    expect(screen.getByText('No school today. Gandhi Jayanti. School reopens on Saturday, 3 Oct.')).toBeInTheDocument()
  })

  it('shows only the links the person may follow', () => {
    const { unmount } = renderAccountant(accountant())
    expect(screen.queryByText('Staff directory')).not.toBeInTheDocument()
    unmount()

    renderAccountant(accountant(), ['dashboard.read', 'staff.read_directory', 'audit.read'])
    expect(screen.getByText('Staff directory').closest('a')).toHaveAttribute('href', '/staff')
    expect(screen.getByText('Audit log').closest('a')).toHaveAttribute('href', '/settings/audit-log')
  })
})
