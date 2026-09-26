import type {
  AssistantProposal,
  AssistantProposalPreview,
  AttendanceDayPreview,
  CoScholasticPreview,
  ExamMarksPreview,
  StaffAttendanceDayPreview,
} from '@erp/contracts'
import type { ReactNode } from 'react'
import type { UIMessage } from 'ai'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiRequestError } from '@/lib/http'
import { renderWithSession } from '@/test/session'
import { Message } from '../message'
import { ToolPart } from '../tool-activity'
import { ProposalsProvider } from './context'
import { checkPreview, countChanges } from './model'
import { ProposalCard } from './proposal-card'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to, search, className }: { children: ReactNode; to: string; search?: Record<string, string>; className?: string }) => {
      const query = search && Object.keys(search).length > 0 ? `?${new URLSearchParams(search).toString()}` : ''
      return <a href={`${to}${query}`} className={className}>{children}</a>
    },
  }
})

const toastSuccess = vi.fn()
vi.mock('sonner', () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args), error: vi.fn() } }))

const confirmProposal = vi.fn()
const dismissProposal = vi.fn()
const proposalStates = vi.fn()

vi.mock('@/lib/api', () => ({
  api: {
    assistant: {
      confirmProposal: (...args: unknown[]) => confirmProposal(...args),
      dismissProposal: (...args: unknown[]) => dismissProposal(...args),
      proposals: (...args: unknown[]) => proposalStates(...args),
    },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'

const attendance: AttendanceDayPreview = {
  kind: 'attendance_day',
  mode: 'first_entry',
  sectionId: 'sec-9a',
  sectionName: '9 A',
  date: '2026-09-26',
  rows: [
    { studentId: 'st-1', name: 'Aarav Gupta', rollNumber: 1, current: null, proposed: 'present' },
    { studentId: 'st-2', name: 'Kabir Mehta', rollNumber: 2, current: null, proposed: 'absent' },
    { studentId: 'st-3', name: 'Riya Sharma', rollNumber: 3, current: null, proposed: 'absent' },
  ],
}

const correction: AttendanceDayPreview = {
  ...attendance,
  mode: 'correction',
  rows: [
    { studentId: 'st-1', name: 'Aarav Gupta', rollNumber: 1, current: 'present', proposed: 'present' },
    { studentId: 'st-2', name: 'Kabir Mehta', rollNumber: 2, current: 'absent', proposed: 'present' },
  ],
}

const staff: StaffAttendanceDayPreview = {
  kind: 'staff_attendance_day',
  mode: 'first_entry',
  date: '2026-09-26',
  rows: [
    { staffId: 'sf-1', name: 'Meena Iyer', designation: 'Maths teacher', current: null, proposed: 'present' },
    { staffId: 'sf-2', name: 'Arjun Das', designation: null, current: null, proposed: 'leave' },
  ],
}

const marks: ExamMarksPreview = {
  kind: 'exam_marks',
  mode: 'first_entry',
  paperId: 'paper-1',
  route: 'marks_sheet',
  title: 'Half-yearly, Mathematics, 9 A',
  components: [
    { component: 'periodic_test', label: 'Periodic test', maxMarks: 10 },
    { component: 'written', label: 'Written', maxMarks: 80 },
  ],
  rows: [
    { studentId: 'st-1', name: 'Aarav Gupta', rollNumber: 1, cells: [{ component: 'periodic_test', current: 8, proposed: null }, { component: 'written', current: null, proposed: 62.5 }] },
    { studentId: 'st-2', name: 'Kabir Mehta', rollNumber: 2, cells: [{ component: 'periodic_test', current: 7, proposed: null }, { component: 'written', current: null, proposed: 'absent' }] },
  ],
}

const grades: CoScholasticPreview = {
  kind: 'co_scholastic',
  sectionId: 'sec-9a',
  sectionName: '9 A',
  card: 'term_1',
  rows: [
    {
      studentId: 'st-1',
      name: 'Aarav Gupta',
      rollNumber: 1,
      version: 2,
      current: { work_education: 'B', art_education: null, health_physical_education: 'A', discipline: 'A' },
      proposed: { work_education: 'A', art_education: null, health_physical_education: 'A', discipline: 'A' },
      currentRemarks: null,
      proposedRemarks: 'Works well with others.',
    },
  ],
}

function proposalOf(preview: AssistantProposalPreview, extra: Partial<AssistantProposal> = {}): AssistantProposal {
  return {
    id: `p-${preview.kind}`,
    kind: preview.kind,
    title: preview.kind === 'staff_attendance_day' ? 'Staff register for 26 Sep 2026' : 'Mark 9 A for 26 Sep 2026',
    status: 'open',
    expiresAt: '2026-09-26T05:30:00.000Z',
    preview,
    ...extra,
  }
}

function renderCard(proposal: AssistantProposal) {
  return renderWithSession(<ProposalCard proposal={proposal} />, { schoolId: SCHOOL })
}

beforeEach(() => {
  vi.clearAllMocks()
  proposalStates.mockResolvedValue({ items: [] })
})

describe('the cards', () => {
  it('draws the day register with every pupil, the marks and the change count', () => {
    renderCard(proposalOf(attendance))
    expect(screen.getByText('Proposed change')).toBeInTheDocument()
    expect(screen.getByText('Mark 9 A for 26 Sep 2026')).toBeInTheDocument()
    expect(screen.getByText('Riya Sharma')).toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Mark for Riya Sharma' })).getByRole('button', { name: 'A', pressed: true })).toBeInTheDocument()
    expect(screen.getByText('3 marks to save')).toBeInTheDocument()
    expect(screen.getByText('Open for 30 minutes')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('draws the staff register with designations and no roll numbers', () => {
    renderCard(proposalOf(staff))
    expect(screen.getByText('Maths teacher')).toBeInTheDocument()
    expect(screen.queryByText('Roll no')).not.toBeInTheDocument()
    expect(within(screen.getByRole('group', { name: 'Mark for Arjun Das' })).getByRole('button', { name: 'LV', pressed: true })).toBeInTheDocument()
  })

  it('draws the marks sheet with a box per component and the proposed marks filled in', () => {
    renderCard(proposalOf(marks))
    expect(screen.getByText('out of 80')).toBeInTheDocument()
    expect(screen.getByLabelText('Written for Aarav Gupta')).toHaveValue('62.5')
    expect(screen.getByLabelText('Written for Kabir Mehta')).toHaveValue('Absent')
    // A cell left as it is shows what is saved, and is still there to type into.
    expect(screen.getByLabelText('Periodic test for Aarav Gupta')).toHaveValue('')
    expect(screen.getByLabelText('Periodic test for Aarav Gupta')).toHaveAttribute('placeholder', '8')
    expect(screen.getByText('2 changes')).toBeInTheDocument()
  })

  it('draws co-scholastic grades with the old grade struck through and the remarks folded away', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf(grades))
    expect(screen.getByLabelText('Work education for Aarav Gupta')).toHaveTextContent('A')
    expect(screen.getByText('B')).toHaveClass('line-through')
    expect(screen.queryByRole('textbox', { name: 'Remarks for Aarav Gupta' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remarks for Aarav Gupta' }))
    expect(screen.getByRole('textbox', { name: 'Remarks for Aarav Gupta' })).toHaveValue('Works well with others.')
  })
})

describe('editing and confirming', () => {
  it('sends the register as the person left it', async () => {
    const user = userEvent.setup()
    confirmProposal.mockImplementation(async (_school: string, id: string, body: { preview: AssistantProposalPreview }) => ({
      proposal: { ...proposalOf(body.preview), id, status: 'done', outcome: "Saved 9 A's register: 2 present, 1 absent.", href: '/attendance?sectionId=sec-9a&date=2026-09-26' },
    }))
    renderCard(proposalOf(attendance))
    await user.click(within(screen.getByRole('group', { name: 'Mark for Kabir Mehta' })).getByRole('button', { name: 'P' }))
    // A first entry has nothing saved to strike through, and only the marks that are not present stand out.
    expect(screen.queryByText('Not marked')).toBeNull()
    expect(document.querySelectorAll('tr[data-changed]').length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
    const [school, id, body] = confirmProposal.mock.calls[0]!
    expect(school).toBe(SCHOOL)
    expect(id).toBe('p-attendance_day')
    expect(body.preview.rows.map((row: { proposed: string }) => row.proposed)).toEqual(['present', 'present', 'absent'])

    expect(await screen.findByText(/^Saved at /)).toBeInTheDocument()
    expect(screen.getByText("Saved 9 A's register: 2 present, 1 absent.")).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/attendance?sectionId=sec-9a&date=2026-09-26')
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalledWith("Saved 9 A's register: 2 present, 1 absent.")
  })

  it('marks everybody present in one go', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(attendance, { status: 'done' }) })
    renderCard(proposalOf(attendance))
    await user.click(screen.getByRole('button', { name: 'Mark all present' }))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(confirmProposal).toHaveBeenCalled())
    expect(confirmProposal.mock.calls[0]![2].preview.rows.every((row: { proposed: string }) => row.proposed === 'present')).toBe(true)
  })

  it('sends a typed mark and a status from the menu', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(marks, { status: 'done' }) })
    renderCard(proposalOf(marks))
    const cell = screen.getByLabelText('Periodic test for Aarav Gupta')
    await user.type(cell, '9.5')
    expect(cell).toHaveValue('9.5')
    await user.click(screen.getByRole('button', { name: 'Set a status for Kabir Mehta, Periodic test' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Medical' }))
    // Aarav's periodic test mark is already saved, so changing it asks why, as the marks sheet does.
    await user.type(screen.getByLabelText('Reason'), 'Re-check asked by the family')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(confirmProposal).toHaveBeenCalled())
    const sent = confirmProposal.mock.calls[0]![2].preview as ExamMarksPreview
    expect(sent.rows[0]!.cells[0]!.proposed).toBe(9.5)
    expect(sent.rows[1]!.cells[0]!.proposed).toBe('medical')
  })

  it('keeps a mark above what the part is out of from being sent', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf(marks))
    const cell = screen.getByLabelText('Written for Aarav Gupta')
    await user.clear(cell)
    await user.type(cell, '92')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('1 mark is not right.')
    expect(screen.getByLabelText('Written for Aarav Gupta')).toHaveAttribute('aria-invalid', 'true')
    expect(confirmProposal).not.toHaveBeenCalled()
  })

  it('asks for a reason before a correction can be confirmed, on the card', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(correction, { status: 'done' }) })
    renderCard(proposalOf(correction))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Say why these marks are being changed.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Reason'), '  Kabir came in late, not absent  ')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(confirmProposal).toHaveBeenCalled())
    expect(confirmProposal.mock.calls[0]![2].preview.reason).toBe('Kabir came in late, not absent')
  })

  it('asks why marks are changing, with the kind of reason starting on re-check', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(marks, { status: 'done' }) })
    renderCard(proposalOf({ ...marks, mode: 'correction' }))
    expect(screen.getByLabelText('Why')).toHaveTextContent('Re-check')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Say in a few words why these marks are changing.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()
    await user.type(screen.getByLabelText('Reason'), 'Paper re-checked')
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(confirmProposal).toHaveBeenCalled())
    expect(confirmProposal.mock.calls[0]![2].preview).toMatchObject({ reasonKind: 'recheck', reason: 'Paper re-checked' })
  })

  it('says a refusal under the buttons and keeps the card open', async () => {
    const user = userEvent.setup()
    confirmProposal.mockRejectedValue(new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'Add a reason for changing a saved register.' }))
    renderCard(proposalOf(attendance))
    await user.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Add a reason for changing a saved register.')
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled()
  })

  it('discards', async () => {
    const user = userEvent.setup()
    dismissProposal.mockResolvedValue({ proposal: proposalOf(attendance, { status: 'dismissed' }) })
    renderCard(proposalOf(attendance))
    await user.click(screen.getByRole('button', { name: 'Discard' }))
    expect(await screen.findByText('Discarded. Nothing was saved.')).toBeInTheDocument()
    expect(dismissProposal).toHaveBeenCalledWith(SCHOOL, 'p-attendance_day')
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })
})

describe('settled cards are read-only', () => {
  it.each([
    ['confirming', 'Saving this change. It updates here in a moment.'],
    ['stale', 'This changed after the assistant read it. Ask again to get a fresh copy.'],
    ['failed', 'This day has not happened yet. The register opens on the day itself.'],
    ['expired', 'This was not confirmed in time, so nothing was saved. Ask again to get a fresh copy.'],
    ['dismissed', 'Discarded. Nothing was saved.'],
  ] as const)('%s', (status, text) => {
    renderCard(proposalOf(attendance, { status, outcome: status === 'failed' ? text : undefined }))
    expect(screen.getByText(text)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Mark 9 A for 26 Sep 2026' })).toHaveAttribute('data-status', status)
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Mark all present' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Mark for Riya Sharma' })).not.toBeInTheDocument()
  })

  it('done shows the outcome and a link, and no register', () => {
    renderCard(proposalOf(attendance, { status: 'done', outcome: 'Saved.', href: '/attendance' }))
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/attendance')
    expect(screen.queryByText('Riya Sharma')).not.toBeInTheDocument()
  })

  it('a reopened conversation shows how a proposal stands now, not how it was made', async () => {
    proposalStates.mockResolvedValue({ items: [proposalOf(attendance, { status: 'expired' })] })
    renderWithSession(
      <ProposalsProvider schoolId={SCHOOL} threadId="t-1" enabled>
        <ProposalCard proposal={proposalOf(attendance)} />
      </ProposalsProvider>,
      { schoolId: SCHOOL },
    )
    expect(await screen.findByText('This was not confirmed in time, so nothing was saved. Ask again to get a fresh copy.')).toBeInTheDocument()
    expect(proposalStates).toHaveBeenCalledWith(SCHOOL, 't-1')
  })
})

describe('Confirm all', () => {
  function answerWith(previews: Array<[string, AssistantProposalPreview, string]>): UIMessage {
    return {
      id: 'm-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Here are the three registers. Check them and confirm.' },
        ...previews.map(([id, preview, title]) => ({
          type: 'tool-propose_attendance_day',
          toolCallId: `call-${id}`,
          state: 'output-available',
          input: {},
          output: { status: 'ok', proposal: { ...proposalOf(preview), id, title } },
        })),
      ],
    } as UIMessage
  }

  it('runs them in order and stops at the first that is not saved', async () => {
    const user = userEvent.setup()
    confirmProposal.mockImplementation(async (_school: string, id: string, body: { preview: AssistantProposalPreview }) => ({
      proposal: { ...proposalOf(body.preview), id, title: id, status: id === 'p-2' ? 'stale' : 'done' },
    }))
    renderWithSession(
      <ProposalsProvider schoolId={SCHOOL} threadId="t-1" enabled={false}>
        <Message message={answerWith([['p-1', attendance, 'Mark 9 A'], ['p-2', attendance, 'Mark 9 B'], ['p-3', attendance, 'Mark 9 C']])} />
      </ProposalsProvider>,
      { schoolId: SCHOOL },
    )
    await user.click(screen.getByRole('button', { name: 'Confirm all (3)' }))

    expect(await screen.findByText('Saved 1 of 3. Stopped at “Mark 9 B”: check that card, then confirm it or the rest again.')).toBeInTheDocument()
    expect(confirmProposal.mock.calls.map((call) => call[1])).toEqual(['p-1', 'p-2'])
    expect(screen.getByRole('region', { name: 'p-1' })).toHaveAttribute('data-status', 'done')
    expect(screen.getByRole('region', { name: 'p-2' })).toHaveAttribute('data-status', 'stale')
    expect(screen.getByRole('region', { name: 'Mark 9 C' })).toHaveAttribute('data-status', 'open')
  })

  it('stops before sending a card that needs a reason', async () => {
    const user = userEvent.setup()
    confirmProposal.mockImplementation(async (_school: string, id: string, body: { preview: AssistantProposalPreview }) => ({
      proposal: { ...proposalOf(body.preview), id, status: 'done' },
    }))
    renderWithSession(
      <ProposalsProvider schoolId={SCHOOL} threadId="t-1" enabled={false}>
        <Message message={answerWith([['p-1', correction, 'Correct 9 A'], ['p-2', attendance, 'Mark 9 B']])} />
      </ProposalsProvider>,
      { schoolId: SCHOOL },
    )
    await user.click(screen.getByRole('button', { name: 'Confirm all (2)' }))
    expect(await screen.findByText('Say why these marks are being changed.')).toBeInTheDocument()
    expect(screen.getByText(/Nothing was saved\. Stopped at “Correct 9 A”/)).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()
  })

  it('is not offered for a single proposal', () => {
    renderWithSession(
      <Message message={answerWith([['p-1', attendance, 'Mark 9 A']])} />,
      { schoolId: SCHOOL },
    )
    expect(screen.queryByRole('button', { name: /Confirm all/ })).not.toBeInTheDocument()
  })
})

describe('the tool part', () => {
  it('draws a change tool result as a proposal card', () => {
    renderWithSession(
      <ToolPart part={{ type: 'tool-propose_attendance_day', state: 'output-available', output: { status: 'ok', proposal: proposalOf(attendance), forModel: { note: 'model only' } } }} toolName="propose_attendance_day" />,
      { schoolId: SCHOOL },
    )
    expect(screen.getByRole('region', { name: 'Mark 9 A for 26 Sep 2026' })).toBeInTheDocument()
    expect(screen.queryByText(/model only/)).not.toBeInTheDocument()
  })

  it('says why a change could not be proposed, and nothing for a refusal', () => {
    const { unmount } = renderWithSession(
      <ToolPart part={{ type: 'tool-propose_attendance_day', state: 'output-available', output: { status: 'invalid', problem: 'There is no pupil called Riyaa in 9 A.' } }} toolName="propose_attendance_day" />,
    )
    expect(screen.getByText('There is no pupil called Riyaa in 9 A.')).toBeInTheDocument()
    unmount()
    const refused = renderWithSession(
      <ToolPart part={{ type: 'tool-propose_attendance_day', state: 'output-available', output: { status: 'not_available' } }} toolName="propose_attendance_day" />,
    )
    expect(refused.container).toBeEmptyDOMElement()
    refused.unmount()
    renderWithSession(
      <ToolPart part={{ type: 'tool-propose_exam_marks', state: 'output-available', output: { status: 'failed' } }} toolName="propose_exam_marks" />,
    )
    expect(screen.getByText('That change could not be prepared.')).toBeInTheDocument()
  })

  it('says it is preparing the change while the tool runs', () => {
    renderWithSession(<ToolPart part={{ type: 'tool-propose_exam_marks', state: 'input-available' }} toolName="propose_exam_marks" />)
    expect(screen.getByRole('status')).toHaveTextContent('Preparing the change…')
  })
})

describe('the rules', () => {
  it('counts what changes: rows for a register, cells for marks, pupils for grades', () => {
    expect(countChanges(attendance)).toBe(3)
    expect(countChanges(correction)).toBe(1)
    expect(countChanges(marks)).toBe(2)
    expect(countChanges(grades)).toBe(1)
    expect(countChanges({ ...grades, rows: [{ ...grades.rows[0]!, proposed: grades.rows[0]!.current, proposedRemarks: null }] })).toBe(0)
  })

  it('refuses to send a preview with nothing in it that changes', () => {
    const result = checkPreview({ ...correction, reason: 'No change really', rows: correction.rows.map((row) => ({ ...row, proposed: row.current ?? 'present' })) })
    expect(result.ok).toBe(false)
  })
})
