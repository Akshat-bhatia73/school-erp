import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MfaSetupPanel, secretFromUri } from '@/components/auth/mfa/setup-panel'

const client = vi.hoisted(() => ({
  twoFactorEnable: vi.fn(),
  twoFactorVerifyTotp: vi.fn(),
}))
vi.mock('@/lib/auth-client', () => client)

const reloadTo = vi.hoisted(() => vi.fn())
vi.mock('@/components/auth/mfa/reload-to', () => ({ reloadTo }))


const URI = 'otpauth://totp/School%20ERP:owner@example.test?secret=JBSWY3DPEHPK3PXP&issuer=School%20ERP'

describe('MfaSetupPanel', () => {
  it('reads the secret out of the enrolment URI in groups of four', () => {
    expect(secretFromUri(URI)).toBe('JBSW Y3DP EHPK 3PXP')
  })

  it('walks password, then the code, then the backup codes, and only leaves once they are saved', async () => {
    client.twoFactorEnable.mockResolvedValue({ totpURI: URI, backupCodes: ['aaaa-1111', 'bbbb-2222'] })
    client.twoFactorVerifyTotp.mockResolvedValue(undefined)
    render(<MfaSetupPanel returnTo="/dashboard" />)

    // Step 1: the password.
    await userEvent.type(screen.getByLabelText('Your password'), 'fixture-password-1')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))

    // Step 2: the code to scan. Nothing claims success yet.
    expect(await screen.findByText('JBSW Y3DP EHPK 3PXP')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Authenticator setup code' })).toBeInTheDocument()
    expect(screen.queryByText('aaaa-1111')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'I have added it' }))

    // Step 3: the first code from the app.
    await userEvent.type(screen.getByLabelText('Code from your authenticator app'), '123456')
    await waitFor(() => expect(client.twoFactorVerifyTotp).toHaveBeenCalledWith({ code: '123456' }))

    // Step 4: the backup codes, with Continue held back until they are acknowledged.
    expect(await screen.findByText('aaaa-1111')).toBeInTheDocument()
    const carryOn = screen.getByRole('button', { name: 'Continue' })
    expect(carryOn).toBeDisabled()
    await userEvent.click(screen.getByLabelText('I have saved these codes'))
    expect(carryOn).toBeEnabled()
    await userEvent.click(carryOn)
    await waitFor(() => expect(reloadTo).toHaveBeenCalledWith('/dashboard'))
  })

  it('says plainly when the password is wrong and stays on the first step', async () => {
    const { ApiRequestError } = await import('@/lib/http')
    client.twoFactorEnable.mockRejectedValue(new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'no' }))
    render(<MfaSetupPanel returnTo="/dashboard" />)
    await userEvent.type(screen.getByLabelText('Your password'), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByText('That password did not match.')).toBeInTheDocument()
    expect(screen.getByLabelText('Your password')).toBeInTheDocument()
  })
})
