import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SecurityScreen } from '@/components/auth/account/security-screen'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }
})

const client = vi.hoisted(() => ({
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  changePassword: vi.fn(),
  twoFactorDisable: vi.fn(),
  twoFactorGenerateBackupCodes: vi.fn(),
}))
vi.mock('@/lib/auth-client', () => client)

const session = vi.hoisted(() => ({
  status: 'authenticated',
  user: { id: 'u1', displayName: 'Owner A', email: 'owner@example.test', phone: undefined },
  twoFactorEnabled: false,
  refresh: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock('@/lib/session', () => ({ useSession: () => session }))

const DEVICES = {
  sessions: [
    { id: 'sess-1', current: true, createdAt: '2026-09-01T09:00:00.000Z', lastActiveAt: '2026-09-15T09:00:00.000Z', expiresAt: '2026-09-22T09:00:00.000Z', assurance: 'mfa' as const, sharedDevice: false },
    { id: 'sess-2', current: false, createdAt: '2026-08-20T09:00:00.000Z', lastActiveAt: '2026-09-10T09:00:00.000Z', expiresAt: '2026-09-20T09:00:00.000Z', assurance: 'single_factor' as const, sharedDevice: true },
  ],
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><SecurityScreen /></QueryClientProvider>)
}

async function apiError(code: string, status: number) {
  const { ApiRequestError } = await import('@/lib/http')
  return new ApiRequestError({ code: code as never, status, message: 'no' })
}

beforeEach(() => {
  session.status = 'authenticated'
  session.twoFactorEnabled = false
  client.listSessions.mockResolvedValue(DEVICES)
  client.revokeSession.mockResolvedValue(undefined)
  client.revokeOtherSessions.mockResolvedValue(undefined)
  client.changePassword.mockReset()
  client.twoFactorDisable.mockReset()
  client.twoFactorGenerateBackupCodes.mockReset()
})

afterEach(() => {
  client.listSessions.mockReset()
  client.revokeSession.mockReset()
})

describe('SecurityScreen', () => {
  it('says nothing about the account when the server cannot be reached', async () => {
    session.status = 'unavailable'
    renderScreen()
    expect(await screen.findByText('We cannot reach the server')).toBeInTheDocument()
    expect(screen.queryByText('Two-step verification')).not.toBeInTheDocument()
  })

  it('offers enrolment when two-step verification is off', async () => {
    renderScreen()
    expect(await screen.findByRole('button', { name: /Set up authenticator/ })).toBeInTheDocument()
    expect(screen.getByText('Two-step verification is off. Some schools will not open without it.')).toBeInTheDocument()
  })

  it('lists the devices and signs one out by its own id', async () => {
    renderScreen()
    expect(await screen.findByText('This device')).toBeInTheDocument()
    expect(screen.getByText('Another device')).toBeInTheDocument()
    expect(screen.getByText('Shared device')).toBeInTheDocument()

    await userEvent.click(screen.getAllByRole('button', { name: 'Sign out' })[1]!)
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(client.revokeSession).toHaveBeenCalledWith('sess-2'))
  })

  describe('the password form', () => {
    it('checks the length and the match before it asks the server', async () => {
      renderScreen()
      await userEvent.type(await screen.findByLabelText('Current password'), 'old-password')
      await userEvent.type(screen.getByLabelText('New password'), 'short')
      await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
      expect(await screen.findByText('Use at least 12 characters.')).toBeInTheDocument()

      await userEvent.type(screen.getByLabelText('New password'), 'a-long-enough-password')
      await userEvent.type(screen.getByLabelText('Confirm new password'), 'something-else-again')
      await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
      expect(await screen.findByText('The two new passwords do not match.')).toBeInTheDocument()
      expect(client.changePassword).not.toHaveBeenCalled()
    })

    it('says the current password did not match when the server refuses it', async () => {
      client.changePassword.mockRejectedValue(await apiError('INVALID_REQUEST', 400))
      renderScreen()
      await userEvent.type(await screen.findByLabelText('Current password'), 'wrong-password')
      await userEvent.type(screen.getByLabelText('New password'), 'a-long-enough-password')
      await userEvent.type(screen.getByLabelText('Confirm new password'), 'a-long-enough-password')
      await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
      expect(await screen.findByText('That current password did not match.')).toBeInTheDocument()
    })
  })

  describe('when two-step verification is on', () => {
    beforeEach(() => { session.twoFactorEnabled = true })

    it('shows new backup codes once the password is confirmed', async () => {
      client.twoFactorGenerateBackupCodes.mockResolvedValue({ backupCodes: ['aaaa-1111', 'bbbb-2222'] })
      renderScreen()
      await userEvent.click(await screen.findByRole('button', { name: 'Generate new backup codes' }))
      await userEvent.type(await screen.findByLabelText('Your password'), 'fixture-password-1')
      await userEvent.click(screen.getByRole('button', { name: 'Generate codes' }))
      expect(await screen.findByText('aaaa-1111')).toBeInTheDocument()
    })

    it('offers the authenticator when turning it off needs a fresh second step', async () => {
      client.twoFactorDisable.mockRejectedValue(await apiError('FRESH_AUTHENTICATION_REQUIRED', 403))
      renderScreen()
      await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
      await userEvent.type(await screen.findByLabelText('Your password'), 'fixture-password-1')
      // The panel behind the dialog is hidden from assistive tech, so this is the dialog's own button.
      fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
      expect(await screen.findByText('Verify with your authenticator first, then check your password.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Verify with your authenticator' })).toBeInTheDocument()
    })

    it('says the password did not match without offering the authenticator', async () => {
      client.twoFactorDisable.mockRejectedValue(await apiError('INVALID_REQUEST', 400))
      renderScreen()
      await userEvent.click(await screen.findByRole('button', { name: 'Turn off' }))
      await userEvent.type(await screen.findByLabelText('Your password'), 'wrong-password')
      // The panel behind the dialog is hidden from assistive tech, so this is the dialog's own button.
      fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))
      expect(await screen.findByText('That password did not match.')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Verify with your authenticator' })).not.toBeInTheDocument()
    })
  })
})
