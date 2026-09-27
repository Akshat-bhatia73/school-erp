import type { AssistantProposal, AssistantProposalPreview, FeeConcessionPreview, FeeOptInPreview, FeePaymentPreview } from '@erp/contracts'
import type { ReactNode } from 'react'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithSession } from '@/test/session'
import { bpToPercentText, checkPreview, concessionEstimate, percentToBp, restoreDraft, TOUCHES } from './model'
import { ProposalCard } from './proposal-card'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
  }
})

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const confirmProposal = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    assistant: {
      confirmProposal: (...args: unknown[]) => confirmProposal(...args),
      dismissProposal: vi.fn(),
      proposals: vi.fn(async () => ({ items: [] })),
    },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'
const PUPIL = '20000000-0000-4000-8000-000000000001'
const YEAR = '30000000-0000-4000-8000-000000000001'
const TUITION = '40000000-0000-4000-8000-000000000001'
const TRANSPORT = '40000000-0000-4000-8000-000000000002'
const LATE = '40000000-0000-4000-8000-000000000003'
const IN_HALF_AN_HOUR = new Date(Date.now() + 30 * 60_000).toISOString()

const pupil = { studentId: PUPIL, studentLabel: 'Aarav Shah, 9 A (SPS/0012)', academicYearId: YEAR, academicYearName: '2026-27' }

const payment: FeePaymentPreview = {
  kind: 'fee_payment',
  ...pupil,
  receivedOn: '2026-09-27',
  // Already oldest due first, as the server sends them; the fine comes last.
  dues: [
    { feeHeadId: TUITION, name: 'Tuition', balancePaise: 800_000, oldestDueOn: '2026-07-10' },
    { feeHeadId: TRANSPORT, name: 'Transport', balancePaise: 300_000, oldestDueOn: '2026-08-10' },
    { feeHeadId: LATE, name: 'Late fee', balancePaise: 20_000, oldestDueOn: null },
  ],
  balancePaise: 1_120_000,
  paidToday: [],
  proposed: { amountPaise: 800_000, mode: 'upi', reference: 'UPI123', payerName: null },
}

const concession: FeeConcessionPreview = {
  kind: 'fee_concession',
  ...pupil,
  head: { id: TUITION, name: 'Tuition' },
  fees: [{ feeHeadId: TUITION, name: 'Tuition', chargedYearPaise: 2_400_000, instalments: 12 }],
  existing: [{ headName: null, category: 'sibling', kind: 'percent', percentBp: 1000, amountPaise: null }],
  proposed: { category: 'hardship', kind: 'percent', percentBp: 2500, amountPaise: null },
}

const optIn: FeeOptInPreview = {
  kind: 'fee_opt_in',
  ...pupil,
  yearStartsOn: '2026-04-01',
  yearEndsOn: '2027-03-31',
  head: { id: TRANSPORT, name: 'Transport' },
  frequency: 'monthly',
  structureAmountPaise: null,
  proposed: { amountPaise: null, startsOn: '2026-10-01', endsOn: null },
}

const TITLES: Record<string, string> = {
  fee_payment: 'Record a payment for Aarav Shah',
  fee_concession: 'Concession for Aarav Shah',
  fee_opt_in: 'Add Transport for Aarav Shah',
}

function proposalOf(preview: AssistantProposalPreview, extra: Partial<AssistantProposal> = {}): AssistantProposal {
  return { id: `p-${preview.kind}`, kind: preview.kind, title: TITLES[preview.kind] ?? 'Change', status: 'open', expiresAt: IN_HALF_AN_HOUR, preview, ...extra }
}

function renderCard(proposal: AssistantProposal) {
  return renderWithSession(<ProposalCard proposal={proposal} />, { schoolId: SCHOOL })
}

function sentPreview<T extends AssistantProposalPreview>(): T {
  const [, , body] = confirmProposal.mock.calls[0]!
  return (body as { preview: T }).preview
}

/** The "This payment" cell of a fee's row in the split. */
function splitOf(fee: string): string {
  const row = screen.getByText(fee).closest('tr')!
  return within(row).getAllByRole('cell').at(-1)!.textContent ?? ''
}

function balanceAfter(): string {
  return screen.getByText('Balance after this payment').nextElementSibling!.textContent ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
})

describe('the payment card', () => {
  it('shows the pupil, the year, the split oldest first and the balance before and after', () => {
    renderCard(proposalOf(payment))
    expect(screen.getByText('Aarav Shah, 9 A (SPS/0012)')).toBeInTheDocument()
    expect(screen.getByText('2026-27')).toBeInTheDocument()
    expect(screen.getByLabelText('Amount')).toHaveValue('8000')
    expect(screen.getByLabelText('Reference')).toHaveValue('UPI123')
    expect(screen.getByText('UPI transaction id')).toBeInTheDocument()
    expect(screen.getByText('Due since 10 Jul 2026')).toBeInTheDocument()
    expect(splitOf('Tuition')).toBe('₹8,000')
    expect(splitOf('Transport')).toBe('—')
    expect(screen.getByText('₹11,200')).toBeInTheDocument()
    expect(balanceAfter()).toBe('₹3,200')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Record payment' })).toBeEnabled()
  })

  it('splits again, oldest due first, as the amount changes', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf(payment))
    await user.clear(screen.getByLabelText('Amount'))
    await user.type(screen.getByLabelText('Amount'), '11,000')
    expect(splitOf('Tuition')).toBe('₹8,000')
    expect(splitOf('Transport')).toBe('₹3,000')
    expect(splitOf('Late fee')).toBe('—')
    expect(balanceAfter()).toBe('₹200')

    await user.clear(screen.getByLabelText('Amount'))
    await user.type(screen.getByLabelText('Amount'), '11200')
    expect(splitOf('Late fee')).toBe('₹200')
    expect(balanceAfter()).toBe('₹0')
  })

  it('warns about a payment already recorded today and still lets Confirm send', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(payment, { status: 'done', outcome: 'Recorded ₹8,000 by UPI.' }) })
    renderCard(proposalOf({ ...payment, paidToday: [{ receiptNumber: 'R0042', amountPaise: 500_000, mode: 'cash' }] }))
    expect(screen.getByRole('alert')).toHaveTextContent('Already recorded today: receipt R0042 for ₹5,000. Check this is not the same payment.')
    const button = screen.getByRole('button', { name: 'Record payment' })
    expect(button).toBeEnabled()
    await user.click(button)
    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
  })

  it('refuses a UPI payment without its reference', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf(payment))
    await user.clear(screen.getByLabelText('Reference'))
    await user.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(await screen.findByText('Enter the reference number.')).toBeInTheDocument()
    expect(screen.getByLabelText('Reference')).toHaveAttribute('aria-invalid', 'true')
    expect(confirmProposal).not.toHaveBeenCalled()

    // Cash needs none.
    const cash = checkPreview({ ...payment, proposed: { ...payment.proposed, mode: 'cash', reference: null } })
    expect(cash.ok).toBe(true)
  })

  it('refuses more than is due today, as soon as it is typed', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf(payment))
    await user.clear(screen.getByLabelText('Amount'))
    await user.type(screen.getByLabelText('Amount'), '12000')
    expect(screen.getByText('Only ₹11,200 is due today. To take fees ahead, use the Fees screen.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(confirmProposal).not.toHaveBeenCalled()

    await user.clear(screen.getByLabelText('Amount'))
    await user.click(screen.getByRole('button', { name: 'Record payment' }))
    expect(await screen.findByText('Enter the amount in rupees.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()
  })

  it('sends only the amount, method, reference and payer, then links to the receipt', async () => {
    const user = userEvent.setup()
    confirmProposal.mockImplementation(async (_s: string, id: string, body: { preview: FeePaymentPreview }) => ({
      proposal: { ...proposalOf(body.preview), id, status: 'done', outcome: 'Recorded ₹9,500.50 by UPI.', href: '/fees/receipts/r-9' },
    }))
    renderCard(proposalOf(payment))
    await user.clear(screen.getByLabelText('Amount'))
    await user.type(screen.getByLabelText('Amount'), '9500.50')
    await user.clear(screen.getByLabelText('Reference'))
    await user.type(screen.getByLabelText('Reference'), 'UPI999')
    await user.type(screen.getByLabelText('Paid by'), 'Meera Shah')
    await user.click(screen.getByRole('button', { name: 'Record payment' }))

    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
    expect(sentPreview()).toEqual({ ...payment, proposed: { amountPaise: 950_050, mode: 'upi', reference: 'UPI999', payerName: 'Meera Shah' } })
    expect(await screen.findByText('Recorded ₹9,500.50 by UPI.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open receipt' })).toHaveAttribute('href', '/fees/receipts/r-9')
  })

  it('shows a done payment with its sentence and receipt link, and nothing to edit', () => {
    renderCard(proposalOf(payment, { status: 'done', outcome: 'Recorded ₹8,000 by UPI.', href: '/fees/receipts/r-1', decidedAt: new Date().toISOString() }))
    expect(screen.getByText('Recorded ₹8,000 by UPI.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open receipt' })).toHaveAttribute('href', '/fees/receipts/r-1')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Record payment' })).toBeNull()
  })

  it('is read-only once stale', () => {
    renderCard(proposalOf(payment, { status: 'stale' }))
    expect(screen.getByText('Changed since')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('₹8,000', { selector: 'p' })).toBeInTheDocument()
  })

  it('keeps an edited amount in the tab', async () => {
    const user = userEvent.setup()
    const first = renderCard(proposalOf(payment))
    await user.clear(screen.getByLabelText('Amount'))
    await user.type(screen.getByLabelText('Amount'), '10000')
    first.unmount()
    renderCard(proposalOf(payment))
    expect(screen.getByLabelText('Amount')).toHaveValue('10000')
    expect(splitOf('Transport')).toBe('₹2,000')
  })
})

describe('the concession card', () => {
  it('shows the pupil, the fee, the estimate and the concessions already there', () => {
    renderCard(proposalOf(concession))
    expect(screen.getByText('Tuition')).toBeInTheDocument()
    expect(screen.getByLabelText('Percentage')).toHaveValue('25')
    expect(screen.getByText('₹6,000')).toBeInTheDocument()
    expect(screen.getByText('Sibling: 10% off every fee')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply concession' })).toBeInTheDocument()
  })

  it('needs a reason, and sends the percentage as basis points', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(concession, { status: 'done', outcome: 'Applied a 12.5% concession.' }) })
    renderCard(proposalOf(concession))
    await user.clear(screen.getByLabelText('Percentage'))
    await user.type(screen.getByLabelText('Percentage'), '12.5')
    expect(screen.getByText('₹3,000')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Apply concession' }))
    expect(await screen.findByText('Give a reason.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Reason'), 'Father lost his job')
    await user.click(screen.getByRole('button', { name: 'Apply concession' }))
    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
    expect(sentPreview()).toEqual({ ...concession, reason: 'Father lost his job', proposed: { ...concession.proposed, percentBp: 1250 } })
    expect(await screen.findByText('Applied a 12.5% concession.')).toBeInTheDocument()
  })

  it('refuses a percentage that is not one', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf({ ...concession, reason: 'Hardship case' }))
    await user.clear(screen.getByLabelText('Percentage'))
    await user.type(screen.getByLabelText('Percentage'), '120')
    await user.click(screen.getByRole('button', { name: 'Apply concession' }))
    expect(await screen.findByText('Enter a percentage above 0 and up to 100, with at most two decimals.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()
  })

  it('offers only a percentage for every fee', () => {
    renderCard(proposalOf({ ...concession, head: null }))
    expect(screen.getByText('Every fee')).toBeInTheDocument()
    expect(screen.getByText('Percentage', { selector: 'p' })).toBeInTheDocument()
  })

  it('works out percentages and estimates', () => {
    expect(percentToBp('12.5')).toBe(1250)
    expect(percentToBp('33.33%')).toBe(3333)
    expect(percentToBp('1.234')).toBeNull()
    expect(percentToBp('')).toBeNull()
    expect(bpToPercentText(1250)).toBe('12.5')
    expect(bpToPercentText(1205)).toBe('12.05')
    // A fixed amount never takes more than an instalment: ₹3,000 off a ₹2,000 instalment is ₹2,000 twelve times.
    expect(concessionEstimate({ ...concession, proposed: { ...concession.proposed, kind: 'amount', percentBp: null, amountPaise: 300_000 } })).toBe(2_400_000)
    expect(concessionEstimate({ ...concession, proposed: { ...concession.proposed, kind: 'amount', percentBp: null, amountPaise: 50_000 } })).toBe(600_000)
  })

  it('shows as done', () => {
    renderCard(proposalOf(concession, { status: 'done', outcome: 'Applied a 25% concession.' }))
    expect(screen.getByText('Applied a 25% concession.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Apply concession' })).toBeNull()
  })
})

describe('the optional fee card', () => {
  it('shows the fee and how often, and asks for an amount when the class has none', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(optIn, { status: 'done', outcome: 'Added Transport.' }) })
    renderCard(proposalOf(optIn))
    expect(screen.getByText('Every month')).toBeInTheDocument()
    expect(screen.getByText('Not set')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add fee' }))
    expect(await screen.findByText('Enter the amount. The class has no amount set for this fee.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Amount per instalment'), '1500')
    await user.click(screen.getByRole('button', { name: 'Add fee' }))
    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
    expect(sentPreview()).toEqual({ ...optIn, proposed: { ...optIn.proposed, amountPaise: 150_000 } })
    expect(await screen.findByText('Added Transport.')).toBeInTheDocument()
  })

  it('takes the class amount when it is set, and refuses an end before the start', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf({ ...optIn, structureAmountPaise: 120_000 }))
    expect(screen.getByText('₹1,200 per instalment')).toBeInTheDocument()
    expect(screen.getByLabelText('Own amount (optional)')).toHaveValue('')
    fireEvent.change(screen.getByLabelText('Ends on (optional)'), { target: { value: '2026-09-01' } })
    await user.click(screen.getByRole('button', { name: 'Add fee' }))
    expect(await screen.findByText('The end cannot be before the start.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()

    expect(checkPreview({ ...optIn, structureAmountPaise: 120_000 }).ok).toBe(true)
    const outside = checkPreview({ ...optIn, structureAmountPaise: 120_000, proposed: { ...optIn.proposed, startsOn: '2027-04-01' } })
    expect(outside.ok ? '' : outside.errors['proposed.startsOn']).toBe('Choose a day from 1 Apr 2026 to 31 Mar 2027.')
  })

  it('shows as done', () => {
    renderCard(proposalOf(optIn, { status: 'done', outcome: 'Added Transport.', href: `/fees/students/${PUPIL}` }))
    expect(screen.getByText('Added Transport.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/fees/students/${PUPIL}`)
  })
})

describe('fee edits kept in the tab', () => {
  it('take only the editable fields, for the same pupil and fee', () => {
    const kept = { ...payment, studentLabel: 'Tampered', dues: [], balancePaise: 0, proposed: { amountPaise: 100_000, mode: 'cash', reference: null, payerName: 'Meera' } }
    expect(restoreDraft(payment, kept)).toEqual({ ...payment, proposed: { amountPaise: 100_000, mode: 'cash', reference: null, payerName: 'Meera' } })
    expect(restoreDraft(payment, { ...kept, studentId: '20000000-0000-4000-8000-000000000009' })).toBeNull()
    expect(restoreDraft(payment, { ...kept, proposed: { ...kept.proposed, mode: 'barter' } })).toBeNull()

    const keptConcession = { ...concession, fees: [], reason: 'Kept', proposed: { category: 'staff_child', kind: 'amount', percentBp: null, amountPaise: 10_000 } }
    expect(restoreDraft(concession, keptConcession)).toEqual({ ...concession, reason: 'Kept', proposed: keptConcession.proposed })
    expect(restoreDraft(concession, { ...keptConcession, head: { id: TRANSPORT, name: 'Transport' } })).toBeNull()

    const keptOptIn = { ...optIn, frequency: 'yearly', proposed: { amountPaise: 90_000, startsOn: '2026-11-01', endsOn: '2027-02-28' } }
    expect(restoreDraft(optIn, keptOptIn)).toEqual({ ...optIn, proposed: keptOptIn.proposed })
  })

  it('refresh the fee screens and the dashboard once saved', () => {
    for (const kind of ['fee_payment', 'fee_concession', 'fee_opt_in'] as const) {
      expect(TOUCHES[kind]).toEqual(expect.arrayContaining(['fees', 'dashboard']))
    }
  })
})
