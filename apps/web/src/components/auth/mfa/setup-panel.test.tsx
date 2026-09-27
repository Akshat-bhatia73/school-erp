import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MfaSetupPanel, secretFromUri } from '@/components/auth/mfa/setup-panel'

const client = vi.hoisted(() => ({
  getSession: vi.fn(),
  startSecondStep: vi.fn(),
  twoFactorSendCode: vi.fn(),
  twoFactorVerifyCode: vi.fn(),
  twoFactorVerifyTotp: vi.fn(),
}))
vi.mock('@/lib/auth-client', () => client)

const reloadTo = vi.hoisted(() => vi.fn())
vi.mock('@/components/auth/mfa/reload-to', () => ({ reloadTo }))

const URI = 'otpauth://totp/School%20ERP:owner@example.test?secret=JBSWY3DPEHPK3PXP&issuer=School%20ERP'

function account(user: Record<string, unknown> = {}) {
  return {
    session: { id: 's1' },
    user: { id: 'u1', name: 'Owner A', email: 'owner@example.test', phoneNumber: '+919876543210', phoneNumberVerified: true, twoFactorEnabled: false, ...user },
  }
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MfaSetupPanel returnTo="/dashboard" />
    </QueryClientProvider>,
  )
}

describe('MfaSetupPanel', () => {
  beforeEach(() => {
    for (const fn of Object.values(client)) fn.mockReset()
    reloadTo.mockReset()
    client.getSession.mockResolvedValue(account())
  })

  it('reads the secret out of the enrolment URI in groups of four', () => {
    expect(secretFromUri(URI)).toBe('JBSW Y3DP EHPK 3PXP')
  })

  it('offers all three steps, saying where a code would go', async () => {
    renderPanel()
    expect(await screen.findByRole('radio', { name: /Authenticator app/ })).toBeInTheDocument()
    expect(screen.getByText(/It goes to ••••••3210/)).toBeInTheDocument()
    expect(screen.getByText(/It goes to o•••@example.test/)).toBeInTheDocument()
  })

  it('does not offer a text message without a number, nor the step already in use', async () => {
    client.getSession.mockResolvedValue(account({ phoneNumber: null, twoFactorEnabled: true, twoFactorMethod: 'totp' }))
    renderPanel()
    expect(await screen.findByRole('radio', { name: /Email/ })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /Text message/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: /Authenticator app/ })).not.toBeInTheDocument()
  })

  it('walks choice, password, the code, then the backup codes, and only leaves once they are saved', async () => {
    client.startSecondStep.mockResolvedValue({ method: 'totp', totpURI: URI, backupCodes: ['aaaa-1111', 'bbbb-2222'] })
    client.twoFactorVerifyTotp.mockResolvedValue(undefined)
    renderPanel()

    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await userEvent.type(screen.getByLabelText('Your password'), 'fixture-password-1')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(client.startSecondStep).toHaveBeenCalledWith({ method: 'totp', password: 'fixture-password-1' })

    // The code to scan. Nothing claims success yet.
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Authenticator setup code' })).toBeInTheDocument()
    expect(screen.queryByText('aaaa-1111')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'I have added it' }))

    await userEvent.type(screen.getByLabelText('Code from your authenticator app'), '123456')
    await waitFor(() => expect(client.twoFactorVerifyTotp).toHaveBeenCalledWith({ code: '123456' }))

    // The backup codes, with Continue held back until they are acknowledged.
    expect(await screen.findByText('aaaa-1111')).toBeInTheDocument()
    const carryOn = screen.getByRole('button', { name: 'Continue' })
    expect(carryOn).toBeDisabled()
    await userEvent.click(screen.getByLabelText('I have saved these codes'))
    expect(carryOn).toBeEnabled()
    await userEvent.click(carryOn)
    await waitFor(() => expect(reloadTo).toHaveBeenCalledWith('/dashboard'))
  })

  it('sends a text message code and switches once it is accepted', async () => {
    client.getSession.mockResolvedValue(account({ twoFactorEnabled: true, twoFactorMethod: 'totp' }))
    client.startSecondStep.mockResolvedValue({ method: 'sms', destination: '••••••3210' })
    client.twoFactorSendCode.mockResolvedValue(undefined)
    client.twoFactorVerifyCode.mockResolvedValue(undefined)
    renderPanel()

    await userEvent.click(await screen.findByRole('radio', { name: /Text message/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await userEvent.type(screen.getByLabelText('Your password'), 'fixture-password-1')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(await screen.findByText(/We sent a 6 digit code to ••••••3210/)).toBeInTheDocument()
    expect(client.twoFactorSendCode).toHaveBeenCalledTimes(1)
    await userEvent.type(screen.getByLabelText('Code from the text message'), '654321')
    await waitFor(() => expect(client.twoFactorVerifyCode).toHaveBeenCalledWith({ code: '654321' }))
    // Leaving the authenticator keeps the saved backup codes, so there are none to show.
    await waitFor(() => expect(reloadTo).toHaveBeenCalledWith('/dashboard'))
  })

  it('says plainly when the password is wrong and stays on the password step', async () => {
    const { ApiRequestError } = await import('@/lib/http')
    client.startSecondStep.mockRejectedValue(new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'That password did not match.', reason: 'second_step_wrong_password' }))
    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await userEvent.type(screen.getByLabelText('Your password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('That password did not match.')).toBeInTheDocument()
    expect(screen.getByLabelText('Your password')).toBeInTheDocument()
  })

  it('asks for the current step first when switching needs a fresh one', async () => {
    const { ApiRequestError } = await import('@/lib/http')
    client.getSession.mockResolvedValue(account({ twoFactorEnabled: true, twoFactorMethod: 'sms' }))
    client.startSecondStep.mockRejectedValue(new ApiRequestError({ code: 'FRESH_AUTHENTICATION_REQUIRED', status: 403, message: 'no' }))
    renderPanel()
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await userEvent.type(screen.getByLabelText('Your password'), 'fixture-password-1')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('link', { name: 'Confirm your current second step' })).toBeInTheDocument()
  })
})
