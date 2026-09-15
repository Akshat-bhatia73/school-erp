import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MfaVerifyPanel } from '@/components/auth/mfa/verify-panel'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigate, Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }
})

const client = vi.hoisted(() => ({
  getSession: vi.fn(),
  twoFactorVerifyTotp: vi.fn(),
  twoFactorVerifyBackupCode: vi.fn(),
}))
vi.mock('@/lib/auth-client', () => client)

vi.mock('@/lib/session', () => ({ announceSignIn: () => {} }))

const reloadTo = vi.hoisted(() => vi.fn())
vi.mock('@/components/auth/mfa/reload-to', () => ({ reloadTo }))

const SESSION = { session: { id: 's1' }, user: { id: 'u1', name: 'Owner A', twoFactorEnabled: true } }

function renderPanel(props: { returnTo?: string; sharedDevice?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MfaVerifyPanel returnTo={props.returnTo ?? '/dashboard'} sharedDevice={props.sharedDevice} />
    </QueryClientProvider>,
  )
}

async function refuse(code: string, status: number, message = 'no') {
  const { ApiRequestError } = await import('@/lib/http')
  return new ApiRequestError({ code: code as never, status, message })
}

describe('MfaVerifyPanel', () => {
  beforeEach(() => {
    navigate.mockReset()
    reloadTo.mockReset()
    client.getSession.mockReset()
    client.twoFactorVerifyTotp.mockReset()
    client.twoFactorVerifyBackupCode.mockReset()
  })

  it('offers enrolment when this account has no authenticator yet', async () => {
    client.getSession.mockResolvedValue({ ...SESSION, user: { ...SESSION.user, twoFactorEnabled: false } })
    renderPanel({ returnTo: '/students' })
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/mfa/setup', search: { returnTo: '/students' } })))
  })

  it('checks the code as soon as six digits are in, then loads the page they asked for', async () => {
    client.getSession.mockResolvedValue(SESSION)
    client.twoFactorVerifyTotp.mockResolvedValue(undefined)
    renderPanel({ returnTo: '/students' })
    await userEvent.type(await screen.findByLabelText('Code from your authenticator app'), '123456')
    await waitFor(() => expect(client.twoFactorVerifyTotp).toHaveBeenCalledWith({ code: '123456', sharedDevice: false }))
    await waitFor(() => expect(reloadTo).toHaveBeenCalledWith('/students'))
  })

  it('carries the shared device choice over from the sign-in screen', async () => {
    client.getSession.mockResolvedValue(SESSION)
    client.twoFactorVerifyTotp.mockResolvedValue(undefined)
    renderPanel({ sharedDevice: true })
    await userEvent.type(await screen.findByLabelText('Code from your authenticator app'), '123456')
    await waitFor(() => expect(client.twoFactorVerifyTotp).toHaveBeenCalledWith({ code: '123456', sharedDevice: true }))
  })

  it('says the code was wrong when the provider refuses it, without sending anyone back to sign in', async () => {
    // The provider answers 401 for a mistyped code as well as for a lost session.
    client.getSession.mockResolvedValue(SESSION)
    client.twoFactorVerifyTotp.mockRejectedValue(await refuse('AUTHENTICATION_REQUIRED', 401))
    renderPanel()
    await userEvent.type(await screen.findByLabelText('Code from your authenticator app'), '000000')
    expect(await screen.findByText('That code did not work.')).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
    expect(reloadTo).not.toHaveBeenCalled()
  })

  it('sends someone to sign in when a refusal turns out to be a session that has gone', async () => {
    client.getSession.mockResolvedValueOnce(SESSION).mockResolvedValue(null)
    client.twoFactorVerifyTotp.mockRejectedValue(await refuse('AUTHENTICATION_REQUIRED', 401))
    renderPanel({ returnTo: '/students' })
    await userEvent.type(await screen.findByLabelText('Code from your authenticator app'), '000000')
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/login', search: { returnTo: '/students' } })))
  })

  it('swaps to a backup code and says plainly when one is refused', async () => {
    client.getSession.mockResolvedValue(SESSION)
    client.twoFactorVerifyBackupCode.mockRejectedValue(await refuse('AUTHENTICATION_REQUIRED', 401))
    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: 'Use a backup code instead' }))
    await userEvent.type(screen.getByLabelText('Backup code'), 'aaaaa-bbbbb')
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }))
    await waitFor(() => expect(client.twoFactorVerifyBackupCode).toHaveBeenCalledWith({ code: 'aaaaa-bbbbb', sharedDevice: false }))
    expect(await screen.findByText('That code did not work.')).toBeInTheDocument()
  })

  it('states a long throttle in minutes rather than counting out 900 seconds', async () => {
    const { ApiRequestError } = await import('@/lib/http')
    client.getSession.mockResolvedValue(SESSION)
    client.twoFactorVerifyTotp.mockRejectedValue(new ApiRequestError({ code: 'RATE_LIMITED', status: 429, message: 'slow', retryAfterSeconds: 900 }))
    renderPanel()
    await userEvent.type(await screen.findByLabelText('Code from your authenticator app'), '123456')
    expect(await screen.findByText('Too many attempts. Try again in about 15 minutes.')).toBeInTheDocument()
  })
})
