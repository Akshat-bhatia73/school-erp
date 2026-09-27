import type { ReactNode } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRecord } from '@/lib/api/messages'
import { renderWithSession } from '@/test/session'
import { isoToLocalInput } from './labels'
import { MessageForm } from './message-form'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigate, Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }
})
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const create = vi.fn()
const update = vi.fn()
const send = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    messages: {
      audiences: vi.fn(async () => ({ school: true, staff: true, grades: [], sections: [], pupils: false })),
      templates: vi.fn(async () => ({ items: [] })),
      audiencePreview: vi.fn(async () => ({ audience: { kind: 'school', label: 'The whole school', recipients: 'families' }, recipients: 58, pupils: 0 })),
      create: (...args: unknown[]) => create(...args),
      update: (...args: unknown[]) => update(...args),
      send: (...args: unknown[]) => send(...args),
    },
    search: { run: vi.fn() },
  },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'

const saved = { id: 'msg-1', version: 3, status: 'draft', audience: { kind: 'staff', label: 'All staff' }, title: 'Staff meeting', body: 'At 3 pm.', attachments: [] } as unknown as MessageRecord

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sending from the message screen', () => {
  it('a new message is saved and sent in one call', async () => {
    const user = userEvent.setup()
    create.mockResolvedValue({ ...saved, status: 'sent' })
    renderWithSession(<MessageForm />, { schoolId: SCHOOL, capabilities: ['communication.send'] })
    await user.click(await screen.findByRole('radio', { name: 'All staff' }))
    await user.type(screen.getByLabelText('Title'), 'Staff meeting')
    await user.type(screen.getByLabelText('Message'), 'At 3 pm.')
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create).toHaveBeenCalledWith(SCHOOL, { audience: { kind: 'staff' }, title: 'Staff meeting', body: 'At 3 pm.', send: { when: 'now' } })
    expect(send).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/messages/$messageId', params: { messageId: 'msg-1' } }))
  })

  it('a saved draft is changed and scheduled in one call', async () => {
    const user = userEvent.setup()
    update.mockResolvedValue({ ...saved, status: 'scheduled' })
    renderWithSession(<MessageForm message={saved} />, { schoolId: SCHOOL, capabilities: ['communication.send'] })
    await user.click(await screen.findByRole('radio', { name: 'Schedule' }))
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString()
    const day = isoToLocalInput(at).slice(0, 10)
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: `${day}T10:30` } })
    await user.click(screen.getByRole('button', { name: 'Schedule message' }))

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update).toHaveBeenCalledWith(SCHOOL, 'msg-1', {
      expectedVersion: 3,
      audience: { kind: 'staff' },
      title: 'Staff meeting',
      body: 'At 3 pm.',
      templateId: null,
      send: { when: 'at', sendAt: `${day}T05:00:00.000Z` },
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('Save draft saves without sending', async () => {
    const user = userEvent.setup()
    update.mockResolvedValue(saved)
    renderWithSession(<MessageForm message={saved} />, { schoolId: SCHOOL, capabilities: ['communication.send'] })
    await user.click(await screen.findByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1))
    expect(update.mock.calls[0]![2]).not.toHaveProperty('send')
  })
})
