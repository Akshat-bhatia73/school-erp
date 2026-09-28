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

/** How many pupils in the audience have their own login, as the preview of the pupils alone says. */
let pupilsWithLogin = 0

const create = vi.fn()
const update = vi.fn()
const send = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    messages: {
      audiences: vi.fn(async () => ({ school: true, staff: true, grades: [], sections: [], pupils: false })),
      templates: vi.fn(async () => ({ items: [] })),
      audiencePreview: vi.fn(async (_school: string, audience: { recipients?: string }) => {
        const pupils = audience.recipients === 'families' || audience.recipients === undefined ? 0 : 12
        const inApp = pupils === 0 ? 0 : pupilsWithLogin
        return {
          audience: { kind: 'school', label: 'The whole school', recipients: audience.recipients ?? 'families' },
          recipients: 58 + pupils, pupils, pupilsInApp: inApp,
          delivered: 58 + inApp, noConsent: 0, notReceiving: 0, noContact: pupils - inApp, inApp: 40 + inApp, email: 0,
        }
      }),
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
  pupilsWithLogin = 0
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

describe('who in the household gets it', () => {
  async function writeToWholeSchool(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole('radio', { name: 'Whole school' }))
    await user.type(screen.getByLabelText('Title'), 'Sports day')
    await user.type(screen.getByLabelText('Message'), 'On Friday.')
  }

  it('hides the choice and sends to parents when no pupil in the audience has a login', async () => {
    const user = userEvent.setup()
    create.mockResolvedValue({ ...saved, status: 'sent' })
    renderWithSession(<MessageForm />, { schoolId: SCHOOL, capabilities: ['communication.send'] })
    await writeToWholeSchool(user)

    expect(await screen.findByText(/Goes to 58 families/)).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Send to' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![1]).toMatchObject({ audience: { kind: 'school', recipients: 'families' } })
  })

  it('offers parents, students with their own login, or both when some pupils have a login', async () => {
    pupilsWithLogin = 5
    const user = userEvent.setup()
    create.mockResolvedValue({ ...saved, status: 'sent' })
    renderWithSession(<MessageForm />, { schoolId: SCHOOL, capabilities: ['communication.send'] })
    await writeToWholeSchool(user)

    expect(await screen.findByRole('radio', { name: 'Parents' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Parents and students' })).toBeInTheDocument()
    expect(screen.getByText('Students in Class 9 to 12 who have their own login get the message in the app.')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Students (own login)' }))
    await user.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(create.mock.calls[0]![1]).toMatchObject({ audience: { kind: 'school', recipients: 'students' } })
  })
})
