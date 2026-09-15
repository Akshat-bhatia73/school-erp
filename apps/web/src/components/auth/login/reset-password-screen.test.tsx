import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...rest}>{children}</a>,
}))
const auth = vi.hoisted(() => ({ resetPassword: vi.fn(), requestPasswordReset: vi.fn(), authConfig: vi.fn() }))
vi.mock('@/lib/auth-client', () => auth)
vi.mock('@/components/auth/auth-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/auth/auth-layout')>()
  return { ...actual, SandboxNotice: () => null }
})

import { ResetPasswordScreen } from '@/components/auth/login/reset-password-screen'
import { ForgotPasswordScreen } from '@/components/auth/login/forgot-password-screen'

describe('ResetPasswordScreen', () => {
  it('says plainly when the link has no token', () => {
    render(<ResetPasswordScreen />)
    expect(screen.getByRole('alert')).toHaveTextContent('This reset link is missing or incomplete.')
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument()
  })

  it('refuses a short password before sending anything', async () => {
    const user = userEvent.setup()
    render(<ResetPasswordScreen token="school.secret" />)
    await user.type(screen.getByLabelText('New password'), 'short')
    await user.type(screen.getByLabelText('Confirm new password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))
    expect(await screen.findByText('Use at least 8 characters.')).toBeInTheDocument()
    expect(auth.resetPassword).not.toHaveBeenCalled()
  })

  it('treats a refused token as an expired link', async () => {
    const user = userEvent.setup()
    const { ApiRequestError } = await import('@/lib/http')
    // The provider answers an expired or already-used reset token with INVALID_REQUEST.
    auth.resetPassword.mockRejectedValue(new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'bad' }))
    render(<ResetPasswordScreen token="school.secret" />)
    await user.type(screen.getByLabelText('New password'), 'a-long-password')
    await user.type(screen.getByLabelText('Confirm new password'), 'a-long-password')
    await user.click(screen.getByRole('button', { name: 'Reset password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('This reset link has expired or was already used.')
  })

  it('describes the new password rule to a screen reader', () => {
    render(<ResetPasswordScreen token="school.secret" />)
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-describedby', 'reset-new-hint')
    expect(screen.getByText('At least 8 characters.')).toHaveAttribute('id', 'reset-new-hint')
  })
})

describe('ForgotPasswordScreen', () => {
  it('gives the same answer whether or not the account exists', async () => {
    const user = userEvent.setup()
    auth.requestPasswordReset.mockResolvedValue(undefined)
    render(<ForgotPasswordScreen />)
    await user.type(screen.getByLabelText('Email address'), 'nobody@example.test')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))
    await waitFor(() => expect(screen.getByText('If that email has an account, we have sent a reset link.')).toBeInTheDocument())
  })

  it('does not claim an email was sent when the request failed', async () => {
    const user = userEvent.setup()
    const { ApiRequestError } = await import('@/lib/http')
    auth.requestPasswordReset.mockRejectedValue(new ApiRequestError({ code: 'NETWORK_ERROR', status: 0, message: 'offline' }))
    render(<ForgotPasswordScreen />)
    await user.type(screen.getByLabelText('Email address'), 'teacher@example.test')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The school server is not reachable. Check your connection and try again.')
    expect(screen.queryByText('If that email has an account, we have sent a reset link.')).not.toBeInTheDocument()
  })
})
