/**
 * Fee screens on the real API.
 *
 * Each test fixes what the server answered and checks what the screen did with it: the controls
 * it leaves out when a capability or an `allowedActions` key is missing, and the body a collection
 * sends. The API module and the router are mocked, so nothing here touches the network.
 */
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PermissionKey } from '@erp/contracts'
import { renderWithSession } from '@/test/session'
import { formatPaise, rupeesToPaise } from '@/lib/utils'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: toastError } }))

const navigate = vi.fn()
let search: Record<string, unknown> = { show: 'all', page: 1 }
let params: Record<string, string> = { studentId: 'student-1' }

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => ({
      ...options,
      useSearch: () => search,
      useParams: () => params,
      fullPath: '/fees',
    }),
    useNavigate: () => navigate,
    Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a>,
  }
})

const fees = {
  heads: vi.fn(),
  structures: vi.fn(),
  dues: vi.fn(),
  statement: vi.fn(),
  receipts: vi.fn(),
  receipt: vi.fn(),
  collect: vi.fn(),
  refund: vi.fn(),
  cancel: vi.fn(),
  adjust: vi.fn(),
  addOptIn: vi.fn(),
  updateOptIn: vi.fn(),
  deleteOptIn: vi.fn(),
  addConcession: vi.fn(),
  removeConcession: vi.fn(),
  exportDues: vi.fn(),
  exportCollections: vi.fn(),
  exportReceipt: vi.fn(),
}
const setup = { grades: vi.fn(), sections: vi.fn(), academicYears: vi.fn(), currentAcademicYear: vi.fn() }
const files = { exportJob: vi.fn(), downloadExportFile: vi.fn() }

vi.mock('@/lib/api', () => ({ api: { fees, setup, files } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const YEAR = { id: 'year-1', name: '2026-27' }
const STUDENT = { id: 'student-1', name: 'Aarav Sharma', admissionNumber: 'SVM/2026/101', grade: { id: 'g1', name: 'Class 6' }, section: { id: 's1', name: 'A' } }

/** The mocked router hands back the options object, which carries the screen's component. */
function componentOf(route: unknown): () => ReactElement {
  return (route as { component: () => ReactElement }).component
}

function duesPage() {
  return {
    items: [{ student: STUDENT, chargedYearPaise: 5000000, dueToDatePaise: 1000000, paidPaise: 400000, balancePaise: 600000, allowedActions: ['fees.read'] }],
    total: 1,
    page: 1,
    pageSize: 25,
    academicYear: YEAR,
    asOf: '2026-09-21',
    totals: { dueToDatePaise: 1000000, paidPaise: 400000, outstandingPaise: 600000, studentsWithDues: 1 },
  }
}

function statement(allowedActions: PermissionKey[]) {
  return {
    student: STUDENT,
    academicYear: YEAR,
    asOf: '2026-09-21',
    lines: [{
      head: { id: 'head-1', name: 'Tuition' },
      category: 'tuition', appliesTo: 'class', frequency: 'monthly',
      instalments: 12, instalmentsDue: 6,
      chargedYearPaise: 6000000, concessionYearPaise: 0, adjustmentPaise: 0,
      dueToDatePaise: 3000000, paidPaise: 2000000, balancePaise: 1000000, yearBalancePaise: 4000000,
    }],
    totals: {
      chargedYearPaise: 6000000, concessionYearPaise: 0, adjustmentPaise: 0,
      dueToDatePaise: 3000000, paidPaise: 2000000, balancePaise: 1000000, yearBalancePaise: 4000000,
    },
    optIns: [],
    concessions: [],
    receipts: [],
    allowedActions,
  }
}

async function renderDues(capabilities: PermissionKey[], roleKeys: string[]) {
  const { Route } = await import('@/routes/_app/fees/index')
  const Screen = componentOf(Route)
  return renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities, roleKeys })
}

async function renderStatement(capabilities: PermissionKey[], roleKeys: string[]) {
  const { Route } = await import('@/routes/_app/fees/students/$studentId')
  const Screen = componentOf(Route)
  return renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities, roleKeys })
}

beforeEach(() => {
  vi.clearAllMocks()
  search = { show: 'all', page: 1 }
  params = { studentId: 'student-1' }
  fees.dues.mockResolvedValue(duesPage())
  fees.heads.mockResolvedValue([])
  setup.grades.mockResolvedValue([])
  setup.sections.mockResolvedValue([])
  setup.academicYears.mockResolvedValue([])
  setup.currentAcademicYear.mockResolvedValue(null)
})

describe('the dues list', () => {
  it('gives a parent their children and no export or setup control', async () => {
    await renderDues(['fees.read'], ['parent'])
    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.queryAllByText('Export')).toHaveLength(0)
    expect(screen.queryAllByText('Fee setup')).toHaveLength(0)
    expect(screen.queryByLabelText('Search pupils')).not.toBeInTheDocument()
  })

  it('gives an accountant the export menu and the setup link', async () => {
    setup.currentAcademicYear.mockResolvedValue({ id: YEAR.id, name: YEAR.name, status: 'current' })
    await renderDues(['fees.read', 'fees.collect', 'fees.manage', 'fees.export', 'holidays.read'], ['accountant'])
    expect(await screen.findByText('Aarav Sharma')).toBeInTheDocument()
    expect(screen.getAllByText('Fee setup').length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getAllByText('Export').length).toBeGreaterThan(0))
  })
})

describe('one pupil\'s statement', () => {
  it('gives an admin Collect fee and nothing that needs fees.manage', async () => {
    fees.statement.mockResolvedValue(statement(['fees.read', 'fees.collect']))
    await renderStatement(['fees.read', 'fees.collect'], ['admin'])
    expect((await screen.findAllByText('Collect fee')).length).toBeGreaterThan(0)
    expect(screen.queryAllByText('More')).toHaveLength(0)
  })

  it('gives an accountant every control', async () => {
    fees.statement.mockResolvedValue(statement(['fees.read', 'fees.collect', 'fees.manage']))
    await renderStatement(['fees.read', 'fees.collect', 'fees.manage', 'fees.export'], ['accountant'])
    expect((await screen.findAllByText('Collect fee')).length).toBeGreaterThan(0)
    await userEvent.click(screen.getAllByText('More')[0]!)
    expect(await screen.findByText('Add concession')).toBeInTheDocument()
    expect(screen.getByText('Add optional fee')).toBeInTheDocument()
  })

  it('gives a parent no way to collect anything', async () => {
    fees.statement.mockResolvedValue(statement(['fees.read']))
    await renderStatement(['fees.read'], ['parent'])
    expect((await screen.findAllByText('Aarav Sharma')).length).toBeGreaterThan(0)
    expect(screen.queryAllByText('Collect fee')).toHaveLength(0)
    expect(screen.queryAllByText('More')).toHaveLength(0)
  })

  it('sends whole paise and never a receipt number', async () => {
    fees.statement.mockResolvedValue(statement(['fees.read', 'fees.collect']))
    fees.collect.mockResolvedValue({ id: 'receipt-1', receiptNumber: 'SVM/2026-27/R0001' })
    await renderStatement(['fees.read', 'fees.collect'], ['accountant'])
    await userEvent.click((await screen.findAllByText('Collect fee'))[0]!)
    // The sheet opens with the balance already filled in: ₹10,000 of tuition.
    await userEvent.click(await screen.findByText('Save receipt'))
    await waitFor(() => expect(fees.collect).toHaveBeenCalled())
    const body = fees.collect.mock.calls[0]?.[2] as Record<string, unknown>
    expect(body).toMatchObject({
      academicYearId: YEAR.id,
      lines: [{ feeHeadId: 'head-1', amountPaise: 1000000 }],
      mode: 'cash',
      receivedOn: expect.any(String),
    })
    expect(body).not.toHaveProperty('receiptNumber')
    expect(Number.isInteger((body.lines as Array<{ amountPaise: number }>)[0]!.amountPaise)).toBe(true)
  })
})

describe('money on screen and money typed in', () => {
  it('writes paise as rupees, with the paise only when there are any', () => {
    expect(formatPaise(0)).toBe('₹0')
    expect(formatPaise(1)).toBe('₹0.01')
    expect(formatPaise(99)).toBe('₹0.99')
    expect(formatPaise(100)).toBe('₹1')
    expect(formatPaise(125050)).toBe('₹1,250.50')
    expect(formatPaise(10000000)).toBe('₹1,00,000')
    expect(formatPaise(-125050)).toBe('-₹1,250.50')
  })

  it('reads what a person typed as whole paise', () => {
    expect(rupeesToPaise('0')).toBe(0)
    expect(rupeesToPaise('1')).toBe(100)
    expect(rupeesToPaise('99')).toBe(9900)
    expect(rupeesToPaise('100')).toBe(10000)
    expect(rupeesToPaise('1250.50')).toBe(125050)
    expect(rupeesToPaise('1250.5')).toBe(125050)
    expect(rupeesToPaise('1,00,000')).toBe(10000000)
    expect(rupeesToPaise('₹ 1,250')).toBe(125000)
    expect(rupeesToPaise('')).toBeNull()
    expect(rupeesToPaise('abc')).toBeNull()
    expect(rupeesToPaise('12.345')).toBeNull()
  })
})
