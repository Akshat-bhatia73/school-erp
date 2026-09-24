/**
 * The office's student login panel: what it says and which actions it offers for each state, the
 * body each action sends, and the counts sentence of the bulk issue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithSession } from '@/test/session'

const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: vi.fn() } }))

const studentLogins = {
  get: vi.fn(),
  issue: vi.fn(),
  resetPassword: vi.fn(),
  switchOff: vi.fn(),
  switchOn: vi.fn(),
  issueMissing: vi.fn(),
}
vi.mock('@/lib/api', () => ({ api: { studentLogins } }))

const { StudentLoginPanel, issuedSummary } = await import('./student-login-panel')

const SCHOOL_ID = '10000000-0000-4000-8000-000000000001'
const BASE = {
  username: 'SVM/2026/101',
  schoolCode: 'sunrise',
  passwordChangePending: false,
  allowedActions: ['students.manage_login'],
}

function render(login: Record<string, unknown>) {
  studentLogins.get.mockResolvedValue({ ...BASE, ...login })
  return renderWithSession(<StudentLoginPanel studentId="student-1" />, { capabilities: ['students.manage_login'] })
}

beforeEach(() => vi.clearAllMocks())

describe('Student login panel', () => {
  it('offers Give login to an eligible pupil with none', async () => {
    render({ state: 'none', guardianPhoneMasked: '+91•••••••1234' })
    expect(await screen.findByText('No login')).toBeInTheDocument()
    expect(screen.getByText('+91•••••••1234')).toBeInTheDocument()
    studentLogins.issue.mockResolvedValue({ ...BASE, state: 'active' })
    await userEvent.click(screen.getByRole('button', { name: /give login/i }))
    await waitFor(() => expect(studentLogins.issue).toHaveBeenCalledWith(SCHOOL_ID, 'student-1'))
    expect(toastSuccess).toHaveBeenCalledWith("Login given. The password was sent to the parent's phone.")
    expect(screen.queryByRole('button', { name: /switch off/i })).not.toBeInTheDocument()
  })

  it('names the blocker and offers nothing when one stands in the way', async () => {
    render({ state: 'none', blocker: 'no_guardian_phone' })
    expect(await screen.findByText('The primary guardian has no phone number. Add one to send the password.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /give login/i })).not.toBeInTheDocument()
  })

  it('offers a new password and switching off for a login that is on', async () => {
    render({ state: 'active', version: 5, passwordChangePending: true })
    expect(await screen.findByText('On')).toBeInTheDocument()
    expect(screen.getByText('Still the one sent to the parent')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /send new password/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /switch on/i })).not.toBeInTheDocument()

    studentLogins.switchOff.mockResolvedValue({ ...BASE, state: 'switched_off' })
    await userEvent.click(screen.getByRole('button', { name: /switch off login/i }))
    await userEvent.type(await screen.findByLabelText('Reason (optional)'), 'Asked by parent')
    const confirm = screen.getAllByRole('button', { name: /switch off login/i }).at(-1)!
    await userEvent.click(confirm)
    await waitFor(() => expect(studentLogins.switchOff).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', { expectedVersion: 5, reason: 'Asked by parent' }))
  })

  it('confirms before sending a new password', async () => {
    render({ state: 'active', version: 5 })
    studentLogins.resetPassword.mockResolvedValue({ ...BASE, state: 'active' })
    await userEvent.click(await screen.findByRole('button', { name: /send new password/i }))
    expect(await screen.findByText(/signed out everywhere/)).toBeInTheDocument()
    expect(studentLogins.resetPassword).not.toHaveBeenCalled()
    await userEvent.click(screen.getAllByRole('button', { name: /send new password/i }).at(-1)!)
    await waitFor(() => expect(studentLogins.resetPassword).toHaveBeenCalledWith(SCHOOL_ID, 'student-1'))
  })

  it('offers switching on for a switched off login', async () => {
    render({ state: 'switched_off', version: 6 })
    expect(await screen.findByText('Switched off')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /switch off login/i })).not.toBeInTheDocument()
    studentLogins.switchOn.mockResolvedValue({ ...BASE, state: 'active' })
    await userEvent.click(screen.getByRole('button', { name: /switch on login/i }))
    await userEvent.click(screen.getAllByRole('button', { name: /switch on login/i }).at(-1)!)
    await waitFor(() => expect(studentLogins.switchOn).toHaveBeenCalledWith(SCHOOL_ID, 'student-1', { expectedVersion: 6 }))
  })

  it('renders no action when the record does not allow it', async () => {
    render({ state: 'active', version: 5, allowedActions: [] })
    expect(await screen.findByText('On')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('issuedSummary', () => {
  it('reads the counts plainly', () => {
    expect(issuedSummary({ issued: 12, noGuardianPhone: 2, alreadyHadLogin: 30, textFailed: 0 })).toBe('12 logins given. 2 pupils have no guardian phone number.')
    expect(issuedSummary({ issued: 1, noGuardianPhone: 0, alreadyHadLogin: 0, textFailed: 0 })).toBe('1 login given.')
  })
})
