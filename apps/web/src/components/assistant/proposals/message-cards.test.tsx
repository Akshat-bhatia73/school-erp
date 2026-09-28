import type { AssistantProposal, AssistantProposalPreview, MessagePreview, MessageWithdrawPreview } from '@erp/contracts'
import type { ReactNode } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isoToLocalInput } from '@/components/messages/labels'
import { renderWithSession } from '@/test/session'
import { checkPreview, countChanges, messageConfirmLabel, restoreDraft, TOUCHES } from './model'
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
/** How many pupils in the audience have their own login, as the preview of the pupils alone says. */
let pupilsWithLogin = 5
vi.mock('@/lib/api', () => ({
  api: {
    messages: {
      audiencePreview: vi.fn(async () => ({
        audience: { kind: 'section', label: 'Class 9 A', recipients: 'students' },
        recipients: 30, pupils: 30, pupilsInApp: pupilsWithLogin,
        delivered: pupilsWithLogin, noConsent: 0, notReceiving: 0, noContact: 30 - pupilsWithLogin, inApp: pupilsWithLogin, email: 0,
      })),
    },
    assistant: {
      confirmProposal: (...args: unknown[]) => confirmProposal(...args),
      dismissProposal: vi.fn(),
      proposals: vi.fn(async () => ({ items: [] })),
    },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'
const IN_HALF_AN_HOUR = new Date(Date.now() + 30 * 60_000).toISOString()
const IN_TWO_DAYS = new Date(Date.now() + 2 * 86_400_000).toISOString()

const notice: MessagePreview = {
  kind: 'message',
  messageId: null,
  version: null,
  currentStatus: null,
  audience: { kind: 'section', sectionId: 'sec-9a', recipients: 'families' },
  audienceLabel: 'Class 9 A',
  pupilAudience: true,
  timeZone: 'Asia/Kolkata',
  current: null,
  proposed: { title: 'Sports day', body: 'Sports day is on Friday. Send your child in sports kit.', send: { when: 'now' } },
}

const draft: MessagePreview = {
  ...notice,
  messageId: 'msg-1',
  version: 4,
  currentStatus: 'draft',
  current: { title: 'Sports day', body: 'Old words.', sendAt: null, recipients: 'families' },
  proposed: { title: 'Sports day on Friday', body: 'Old words.', send: { when: 'draft' } },
}

const scheduled: MessagePreview = {
  ...draft,
  currentStatus: 'scheduled',
  current: { title: 'Sports day', body: 'Old words.', sendAt: IN_TWO_DAYS, recipients: 'families' },
  proposed: { title: 'Sports day', body: 'Old words.', send: { when: 'at', sendAt: IN_TWO_DAYS } },
}

const staffNotice: MessagePreview = { ...notice, audience: { kind: 'staff' }, audienceLabel: 'All staff', pupilAudience: false }

const withdrawal: MessageWithdrawPreview = {
  kind: 'message_withdraw',
  messageId: 'msg-2',
  version: 7,
  title: 'Holiday on Monday',
  audienceLabel: 'The whole school',
  sentAt: '2026-09-25T04:30:00.000Z',
  recipients: 58,
}

function proposalOf(preview: AssistantProposalPreview, extra: Partial<AssistantProposal> = {}): AssistantProposal {
  return {
    id: `p-${preview.kind}`,
    kind: preview.kind,
    title: preview.kind === 'message_withdraw' ? 'Withdraw "Holiday on Monday"' : 'Notice to Class 9 A',
    status: 'open',
    expiresAt: IN_HALF_AN_HOUR,
    preview,
    ...extra,
  }
}

function renderCard(proposal: AssistantProposal) {
  return renderWithSession(<ProposalCard proposal={proposal} />, { schoolId: SCHOOL })
}

/** Everything in a message preview the card may not change. */
function fixedPart(preview: MessagePreview) {
  const { proposed: _proposed, audience, ...rest } = preview
  const { recipients: _recipients, ...target } = audience as { recipients?: string }
  return { ...rest, target }
}

function sentPreview(): MessagePreview {
  const [, , body] = confirmProposal.mock.calls[0]!
  return (body as { preview: MessagePreview }).preview
}

beforeEach(() => {
  vi.clearAllMocks()
  window.sessionStorage.clear()
  pupilsWithLogin = 5
})

describe('the message card', () => {
  it('shows who it is for, the words, the character limit and what Confirm does', async () => {
    renderCard(proposalOf(notice))
    expect(screen.getByText('Class 9 A')).toBeInTheDocument()
    expect(screen.getByLabelText('Title')).toHaveValue('Sports day')
    expect(screen.getByLabelText('Message')).toHaveValue(notice.proposed.body)
    expect(screen.getByText(`${notice.proposed.body.length} / 5000`)).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Send now' })).toBeChecked()
    expect(await screen.findByRole('radio', { name: 'Parents' })).toBeChecked()
    expect(screen.getByText('Students in Class 9 to 12 who have their own login get the message in the app.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send notice' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('offers no families or pupils choice for staff', () => {
    renderCard(proposalOf(staffNotice))
    expect(screen.queryByRole('radio', { name: 'Parents' })).toBeNull()
  })

  it('hides the choice and sends to parents when no pupil in the audience has a login', async () => {
    pupilsWithLogin = 0
    const user = userEvent.setup()
    confirmProposal.mockImplementation(async (_s: string, id: string, body: { preview: MessagePreview }) => ({
      proposal: { ...proposalOf(body.preview), id, status: 'done', outcome: 'Sent the notice to Class 9 A.', href: '/messages/msg-9' },
    }))
    renderCard(proposalOf({ ...notice, audience: { kind: 'section', sectionId: 'sec-9a', recipients: 'both' } }))

    const { api } = await import('@/lib/api')
    await waitFor(() => expect(api.messages.audiencePreview).toHaveBeenCalledWith(SCHOOL, { kind: 'section', sectionId: 'sec-9a', recipients: 'students' }))
    await vi.mocked(api.messages.audiencePreview).mock.results[0]!.value
    expect(screen.queryByRole('radio', { name: 'Parents and students' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Send notice' }))

    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
    expect(sentPreview().audience).toEqual({ kind: 'section', sectionId: 'sec-9a', recipients: 'families' })
  })

  it('names the button by the choice', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf(notice))
    await user.click(screen.getByRole('radio', { name: 'Schedule' }))
    expect(screen.getByRole('button', { name: 'Schedule notice' })).toBeInTheDocument()
    expect(screen.getByText(/at least 5 minutes from now and at most 60 days ahead/)).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Keep as draft' }))
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument()

    expect(messageConfirmLabel(draft)).toBe('Save changes')
    expect(messageConfirmLabel({ ...draft, proposed: { ...draft.proposed, send: { when: 'now' } } })).toBe('Send notice')
    expect(messageConfirmLabel({ ...draft, proposed: { ...draft.proposed, send: { when: 'at', sendAt: IN_TWO_DAYS } } })).toBe('Schedule notice')
    expect(messageConfirmLabel({ ...scheduled, proposed: { ...scheduled.proposed, send: { when: 'draft' } } })).toBe('Take back to draft')
    expect(messageConfirmLabel(scheduled)).toBe('Save changes')
  })

  it('sends the edited words, time and recipients and nothing else', async () => {
    const user = userEvent.setup()
    confirmProposal.mockImplementation(async (_s: string, id: string, body: { preview: MessagePreview }) => ({
      proposal: { ...proposalOf(body.preview), id, status: 'done', outcome: 'Scheduled the notice to Class 9 A.', href: '/messages/msg-9' },
    }))
    renderCard(proposalOf(notice))

    await user.clear(screen.getByLabelText('Title'))
    await user.type(screen.getByLabelText('Title'), 'Sports day moved')
    await user.type(screen.getByLabelText('Message'), ' Bring water.')
    await user.click(await screen.findByRole('radio', { name: 'Parents and students' }))
    await user.click(screen.getByRole('radio', { name: 'Schedule' }))
    const day = isoToLocalInput(IN_TWO_DAYS).slice(0, 10)
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: day } })
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '10:30' } })
    await user.click(screen.getByRole('button', { name: 'Schedule notice' }))

    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
    const sent = sentPreview()
    expect(fixedPart(sent)).toEqual(fixedPart(notice))
    expect(sent.audience).toEqual({ kind: 'section', sectionId: 'sec-9a', recipients: 'both' })
    expect(sent.proposed.title).toBe('Sports day moved')
    expect(sent.proposed.body).toBe(`${notice.proposed.body} Bring water.`)
    // 10:30 in the school's time is 05:00 UTC.
    expect(sent.proposed.send).toEqual({ when: 'at', sendAt: `${day}T05:00:00.000Z` })

    expect(await screen.findByText('Scheduled the notice to Class 9 A.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/messages/msg-9')
  })

  it('keeps a time too soon, or no time, from being sent', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf(notice))
    await user.click(screen.getByRole('radio', { name: 'Schedule' }))
    await user.click(screen.getByRole('button', { name: 'Schedule notice' }))
    expect(await screen.findByText('Choose the date and time it should go.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()

    const soon = checkPreview({ ...notice, proposed: { ...notice.proposed, send: { when: 'at', sendAt: new Date(Date.now() + 60_000).toISOString() } } })
    expect(soon.ok ? '' : soon.errors['proposed.send']).toBe('Choose a time at least 5 minutes from now.')
    const empty = checkPreview({ ...notice, proposed: { ...notice.proposed, title: '  ' } })
    expect(empty.ok ? '' : empty.errors['proposed.title']).toBe('Give the message a title.')
  })

  it('shows a draft as it is saved beside what changes, and refuses a change that changes nothing', async () => {
    const user = userEvent.setup()
    renderCard(proposalOf(draft))
    expect(screen.getByText('Draft')).toBeInTheDocument()
    // The saved title, struck through beside the new one.
    expect(screen.getByText('Sports day')).toBeInTheDocument()
    expect(countChanges(draft)).toBe(1)

    await user.clear(screen.getByLabelText('Title'))
    await user.type(screen.getByLabelText('Title'), 'Sports day')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('There is nothing to change. Change a value first, or discard this.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()
  })

  it('shows a scheduled message with its time and can take it back to a draft', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(scheduled, { status: 'done' }) })
    renderCard(proposalOf({ ...scheduled, proposed: { ...scheduled.proposed, send: { when: 'draft' } } }))
    expect(screen.getByText(/^Scheduled for /)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Take back to draft' }))
    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
    expect(sentPreview().proposed.send).toEqual({ when: 'draft' })
  })

  it('counts a change of recipients alone against the proposal as made', () => {
    const edited: MessagePreview = { ...scheduled, audience: { kind: 'section', sectionId: 'sec-9a', recipients: 'students' } }
    expect(countChanges(scheduled, scheduled)).toBe(0)
    expect(countChanges(edited, scheduled)).toBe(1)
  })

  it('is read-only once settled', () => {
    renderCard(proposalOf(notice, { status: 'stale' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('Changed since')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send notice' })).toBeNull()
  })
})

describe('the withdraw card', () => {
  it('shows the message and how many it reached, and needs a reason', async () => {
    const user = userEvent.setup()
    confirmProposal.mockResolvedValue({ proposal: proposalOf(withdrawal, { status: 'done', outcome: 'Withdrew "Holiday on Monday".' }) })
    renderCard(proposalOf(withdrawal))
    expect(screen.getByText('Holiday on Monday')).toBeInTheDocument()
    expect(screen.getByText('The whole school')).toBeInTheDocument()
    expect(screen.getByText('Reached 58 people.')).toBeInTheDocument()

    const button = screen.getByRole('button', { name: 'Withdraw message' })
    expect(button).toHaveAttribute('data-variant', 'destructive')
    await user.click(button)
    expect(await screen.findByText('Give a reason.')).toBeInTheDocument()
    expect(confirmProposal).not.toHaveBeenCalled()

    await user.type(screen.getByLabelText('Reason'), 'Sent to the wrong classes')
    await user.click(screen.getByRole('button', { name: 'Withdraw message' }))
    await waitFor(() => expect(confirmProposal).toHaveBeenCalledTimes(1))
    const [, , body] = confirmProposal.mock.calls[0]!
    expect((body as { preview: MessageWithdrawPreview }).preview).toEqual({ ...withdrawal, reason: 'Sent to the wrong classes' })
  })
})

describe('message edits kept in the tab', () => {
  it('take only the words, the time and the recipients', () => {
    const kept = {
      ...draft,
      audienceLabel: 'Tampered',
      audience: { kind: 'section', sectionId: 'someone-else', recipients: 'students' },
      proposed: { title: 'Kept title', body: 'Kept words', send: { when: 'now' } },
    }
    const restored = restoreDraft(draft, kept) as MessagePreview
    expect(restored.audienceLabel).toBe('Class 9 A')
    expect(restored.audience).toEqual({ kind: 'section', sectionId: 'sec-9a', recipients: 'students' })
    expect(restored.proposed).toEqual({ title: 'Kept title', body: 'Kept words', send: { when: 'now' } })
    expect(restoreDraft(draft, { ...kept, messageId: 'msg-other' })).toBeNull()
    expect(restoreDraft(draft, { ...kept, proposed: { ...kept.proposed, send: { when: 'later' } } })).toBeNull()

    const withdrawn = restoreDraft(withdrawal, { ...withdrawal, title: 'Tampered', reason: 'Wrong day' })
    expect(withdrawn).toEqual({ ...withdrawal, reason: 'Wrong day' })
  })

  it('come back after the card is drawn again', async () => {
    const user = userEvent.setup()
    const first = renderCard(proposalOf(notice))
    await user.type(screen.getByLabelText('Title'), ' and prizes')
    first.unmount()
    renderCard(proposalOf(notice))
    expect(screen.getByLabelText('Title')).toHaveValue('Sports day and prizes')
  })

  it('refresh the messages screens once saved', () => {
    expect(TOUCHES.message).toContain('messages')
    expect(TOUCHES.message_withdraw).toContain('messages')
  })
})
