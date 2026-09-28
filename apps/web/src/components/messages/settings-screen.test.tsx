/**
 * The automatic messages settings screen, on a mocked API: the leave decisions switch and the
 * words of both leave decision kinds, editable like every other automatic kind.
 */
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AUTOMATIC_MESSAGE_KINDS,
  DEFAULT_COMMUNICATION_SETTINGS,
  DEFAULT_MESSAGE_WORDING,
  type PermissionKey,
} from '@erp/contracts'
import { renderWithSession } from '@/test/session'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    createFileRoute: () => (options: Record<string, unknown>) => options,
    useNavigate: () => vi.fn(),
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  }
})

const messages = { settings: vi.fn(), saveSettings: vi.fn(), createTemplate: vi.fn(), templates: vi.fn(), archiveTemplate: vi.fn() }
vi.mock('@/lib/api', () => ({ api: { messages } }))

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'

function settingsRecord(patch: Record<string, unknown> = {}) {
  return {
    ...DEFAULT_COMMUNICATION_SETTINGS,
    version: 4,
    wording: AUTOMATIC_MESSAGE_KINDS.map((kind) => ({ kind, ...DEFAULT_MESSAGE_WORDING[kind] })),
    allowedActions: ['communication.read', 'communication.manage'] as PermissionKey[],
    ...patch,
  }
}

async function renderSettings() {
  const { Route } = await import('@/routes/_app/messages/settings/index')
  const Screen = (Route as unknown as { component: () => ReactElement }).component
  return renderWithSession(<Screen />, { schoolId: SCHOOL_ID, capabilities: ['communication.read', 'communication.manage'], roleKeys: ['admin'] })
}

beforeEach(() => {
  vi.clearAllMocks()
  messages.settings.mockResolvedValue(settingsRecord())
  messages.saveSettings.mockResolvedValue(settingsRecord({ version: 5 }))
  messages.createTemplate.mockResolvedValue({})
})

describe('leave decisions on the automatic messages screen', () => {
  it('has one switch for both kinds and sends it with the rest of the settings', async () => {
    await renderSettings()

    const toggle = await screen.findByRole('switch', { name: 'Leave decisions on or off' })
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Goes out while leave decisions are on.')).toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Staff leave decisions on or off' })).not.toBeInTheDocument()

    await userEvent.click(toggle)
    await userEvent.click(screen.getAllByRole('button', { name: /^Save/ })[0]!)
    await waitFor(() => expect(messages.saveSettings).toHaveBeenCalled())
    expect(messages.saveSettings.mock.calls[0]![1]).toMatchObject({ leaveDecisionsEnabled: false, expectedVersion: 4 })
  })

  it('shows the words of each leave decision kind with its placeholders, and saves new words', async () => {
    await renderSettings()

    expect(await screen.findByDisplayValue(DEFAULT_MESSAGE_WORDING.leave_decision_staff.title)).toBeInTheDocument()
    const pupilTitle = screen.getByDisplayValue(DEFAULT_MESSAGE_WORDING.leave_decision_pupil.title)
    const panel = pupilTitle.closest('section')!
    expect(within(panel as HTMLElement).getAllByText('{decision_note}').length).toBeGreaterThan(0)

    await userEvent.clear(pupilTitle)
    await userEvent.type(pupilTitle, 'Leave for {{pupil_first_name} is {{decision}')
    const saveWords = within(panel as HTMLElement).getByRole('button', { name: 'Save words' })
    await userEvent.click(saveWords)
    await waitFor(() => expect(messages.createTemplate).toHaveBeenCalledWith(SCHOOL_ID, expect.objectContaining({
      kind: 'leave_decision_pupil',
      title: 'Leave for {pupil_first_name} is {decision}',
    })))
  })
})
