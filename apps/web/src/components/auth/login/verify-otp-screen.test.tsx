import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'


const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...rest}>{children}</a>,
}))
vi.mock('@/components/auth/app-gate', () => ({ RedirectOnce: ({ to }: { to: string }) => <p>redirect:{to}</p> }))

const auth = vi.hoisted(() => ({ verifyPhoneOtp: vi.fn(), sendPhoneOtp: vi.fn(), authConfig: vi.fn() }))
vi.mock('@/lib/auth-client', () => auth)

const refresh = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/session', () => ({ useSession: () => ({ refresh }), announceSignIn: vi.fn() }))
vi.mock('@/components/auth/auth-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/auth/auth-layout')>()
  return { ...actual, SandboxNotice: () => null }
})

import { maskPhone, VerifyOtpScreen } from '@/components/auth/login/verify-otp-screen'

describe('VerifyOtpScreen', () => {
  beforeEach(() => { navigate.mockReset(); auth.verifyPhoneOtp.mockReset(); auth.sendPhoneOtp.mockReset() })

  it('masks the destination', () => {
    expect(maskPhone('+919876543210')).toBe('+91 98xxxxxx10')
  })

  it('sends the person back to sign in when there is no number', () => {
    render(<VerifyOtpScreen returnTo="/dashboard" />)
    expect(screen.getByText('redirect:/login')).toBeInTheDocument()
  })

  it('checks the code as soon as six digits are typed', async () => {
    const user = userEvent.setup()
    auth.verifyPhoneOtp.mockResolvedValue({ user: { id: 'u' } })
    render(<VerifyOtpScreen phone="+919876543210" returnTo="/students" />)
    await user.type(screen.getByLabelText('6 digit code'), '123456')
    await waitFor(() => expect(auth.verifyPhoneOtp).toHaveBeenCalledWith({ phoneNumber: '+919876543210', code: '123456', sharedDevice: undefined }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ href: '/students' })))
  })

  it('keeps the query string on the page the person was sent back to', async () => {
    const user = userEvent.setup()
    auth.verifyPhoneOtp.mockResolvedValue({ user: { id: 'u' } })
    render(<VerifyOtpScreen phone="+919876543210" returnTo="/students?q=raj" />)
    await user.type(screen.getByLabelText('6 digit code'), '123456')
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ href: '/students?q=raj' })))
  })

  it('holds the resend button for sixty seconds', async () => {
    vi.useFakeTimers()
    render(<VerifyOtpScreen phone="+919876543210" returnTo="/dashboard" />)
    expect(screen.getByRole('button', { name: /Send a new code in 60s/ })).toBeDisabled()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(screen.getByRole('button', { name: 'Send a new code' })).toBeEnabled()
    vi.useRealTimers()
  })

  it('says the code did not work without blaming the person', async () => {
    const user = userEvent.setup()
    const { ApiRequestError } = await import('@/lib/http')
    auth.verifyPhoneOtp.mockRejectedValue(new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'bad' }))
    render(<VerifyOtpScreen phone="+919876543210" returnTo="/dashboard" />)
    await user.type(screen.getByLabelText('6 digit code'), '000000')
    expect(await screen.findByRole('alert')).toHaveTextContent('That code did not work. You have limited attempts.')
  })
})
