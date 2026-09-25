/**
 * Settings → Assistant: the school's switch and limits, checked against the contract before they
 * are sent, and this month's counts by role.
 */
import type { ReactNode } from 'react'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ASSISTANT_SETTINGS, type PermissionKey } from '@erp/contracts'
import { AssistantSettingsPage } from '@/components/settings/assistant-settings'
import { renderWithSession } from '@/test/session'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
    useNavigate: () => vi.fn(),
  }
})

const settings = vi.hoisted(() => vi.fn())
const updateSettings = vi.hoisted(() => vi.fn())
const usage = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())
const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))

vi.mock('@/lib/api', () => ({
  api: { assistant: { settings, updateSettings, usage } },
}))

const SCHOOL = '10000000-0000-4000-8000-000000000001'
const MANAGER: PermissionKey[] = ['ai_assistant.use', 'ai_assistant.manage']

const RECORD = { ...DEFAULT_ASSISTANT_SETTINGS, version: 3, allowedActions: ['ai_assistant.manage'] }

function renderPage(capabilities: PermissionKey[] = MANAGER) {
  return renderWithSession(<AssistantSettingsPage />, { roleKeys: ['principal'], capabilities })
}

beforeEach(() => {
  vi.clearAllMocks()
  settings.mockResolvedValue(RECORD)
  updateSettings.mockImplementation(async (_school: string, body: Record<string, unknown>) => ({ ...RECORD, ...body, version: 4 }))
  usage.mockResolvedValue({
    month: '2026-09',
    questions: 1200,
    monthlyQuestions: 3000,
    byRole: [
      { role: 'teacher', questions: 900, people: 12 },
      { role: 'parent', questions: 300, people: 40 },
    ],
  })
})

describe('assistant settings', () => {
  it('shows the school switch off and the starting limits', async () => {
    renderPage()
    const toggle = await screen.findByRole('switch', { name: 'Let people in this school use the assistant' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByText(/Nothing is kept by Google\./)).toBeInTheDocument()
    expect(screen.getByLabelText('Questions per staff member per day')).toHaveValue(50)
    expect(screen.getByLabelText('Questions per parent or pupil per day')).toHaveValue(20)
    expect(screen.getByLabelText('Questions for the whole school per month')).toHaveValue(3000)
    // Switching it off for one person is a restriction on their access, from the users list.
    const line = screen.getByText(/To switch it off for one person/)
    expect(within(line).getByRole('link', { name: 'Users & logins' })).toHaveAttribute('href', '/settings/users')
  })

  it('says what is wrong under the field and sends nothing', async () => {
    renderPage()
    const staff = await screen.findByLabelText('Questions per staff member per day')
    fireEvent.change(staff, { target: { value: '900' } })
    fireEvent.change(screen.getByLabelText('Questions for the whole school per month'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Enter 500 or less for the questions per staff member per day')).toBeInTheDocument()
    expect(screen.getByText('Enter the questions for the whole school per month')).toBeInTheDocument()
    expect(staff).toHaveAttribute('aria-invalid', 'true')
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('sends the version it was looking at, then says so and refreshes the assistant', async () => {
    const { queryClient } = renderPage()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    fireEvent.click(await screen.findByRole('switch', { name: 'Let people in this school use the assistant' }))
    fireEvent.change(screen.getByLabelText('Questions per parent or pupil per day'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Assistant settings saved'))
    expect(updateSettings).toHaveBeenCalledWith(SCHOOL, {
      enabled: true,
      dailyQuestionsStaff: 50,
      dailyQuestionsFamily: 10,
      monthlyQuestions: 3000,
      expectedVersion: 3,
    })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [SCHOOL, 'assistant'] })
  })

  it('reports a refused save in plain words', async () => {
    updateSettings.mockRejectedValueOnce(new Error('boom'))
    renderPage()
    fireEvent.click(await screen.findByRole('switch', { name: 'Let people in this school use the assistant' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it('counts this month by role and never shows what was asked', async () => {
    renderPage()
    expect(await screen.findByText('Teacher')).toBeInTheDocument()
    expect(screen.getByText(/of 3,000 questions used/)).toBeInTheDocument()
    expect(screen.getByText('1,800 left')).toBeInTheDocument()
    expect(screen.getByText('900')).toBeInTheDocument()
    expect(screen.getByText('40')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Questions used this month' })).toBeInTheDocument()
  })

  it('says one sentence to somebody who does not run the assistant, and reads nothing', () => {
    renderPage(['ai_assistant.use'])
    expect(screen.getByText('You cannot change the school assistant')).toBeInTheDocument()
    expect(settings).not.toHaveBeenCalled()
    expect(usage).not.toHaveBeenCalled()
  })
})

describe('settings tabs', () => {
  it('offer the assistant only to those who run it', async () => {
    const { SettingsTabs } = await import('@/components/settings/settings-tabs')
    const { unmount } = renderWithSession(<SettingsTabs />, { capabilities: MANAGER })
    expect(screen.getByText('Assistant')).toBeInTheDocument()
    unmount()
    renderWithSession(<SettingsTabs />, { capabilities: ['ai_assistant.use'] })
    expect(screen.queryByText('Assistant')).not.toBeInTheDocument()
  })
})
