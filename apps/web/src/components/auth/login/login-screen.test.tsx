import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ApiRequestError } from '@/lib/http'


const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...rest}>{children}</a>,
}))

const auth = vi.hoisted(() => ({
  signInWithEmail: vi.fn(),
  sendPhoneOtp: vi.fn(),
  studentSignIn: vi.fn(),
  needsSecondFactor: (result: unknown) => Boolean(result && typeof result === 'object' && 'twoFactorRedirect' in result),
  normaliseIndianPhone: (value: string) => (/^[6-9]\d{9}$/.test(value) ? `+91${value}` : null),
  authConfig: vi.fn(async () => ({ deliveryMode: 'provider', studentLoginEnabled: true })),
}))
vi.mock('@/lib/auth-client', () => auth)

const refresh = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/session', () => ({
  useSession: () => ({ refresh }),
  announceSignIn: vi.fn(),
}))
vi.mock('@/components/auth/auth-layout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/auth/auth-layout')>()
  return { ...actual, SandboxNotice: () => null }
})

import { LoginScreen } from '@/components/auth/login/login-screen'

function renderLogin(audience?: 'administration' | 'teacher' | 'parent') {
  return render(<LoginScreen returnTo="/students" audience={audience} />)
}

describe('LoginScreen', () => {
  afterEach(() => { vi.useRealTimers() })

  beforeEach(() => {
    navigate.mockReset()
    auth.signInWithEmail.mockReset()
    auth.sendPhoneOtp.mockReset()
    auth.studentSignIn.mockReset()
  })

  it('shows the email form for the school office and the phone form for parents', async () => {
    const user = userEvent.setup()
    renderLogin()
    expect(screen.getByLabelText('Email address')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Parent' }))
    expect(await screen.findByLabelText('Mobile number')).toBeInTheDocument()
  })

  it('signs a pupil in with the three fields and sends them to choose a password first', async () => {
    const user = userEvent.setup()
    auth.studentSignIn.mockResolvedValue({ signedIn: true, passwordChangeRequired: true })
    renderLogin()
    await user.click(screen.getByRole('tab', { name: 'Student' }))
    await user.type(await screen.findByLabelText('School code'), 'sunrise')
    await user.type(screen.getByLabelText('Admission number'), 'ADM-0901')
    await user.type(screen.getByLabelText('Password'), 'texted-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(auth.studentSignIn).toHaveBeenCalledWith({
      schoolCode: 'sunrise', admissionNumber: 'ADM-0901', password: 'texted-password', sharedDevice: false,
    }))
    expect(refresh).toHaveBeenCalled()
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/account/change-password', search: { returnTo: '/students' } })))
    expect(auth.signInWithEmail).not.toHaveBeenCalled()
  })

  it('sends a pupil with their own password straight to where they were going', async () => {
    const user = userEvent.setup()
    auth.studentSignIn.mockResolvedValue({ signedIn: true, passwordChangeRequired: false })
    render(<LoginScreen returnTo="/students" audience="student" />)
    await user.type(screen.getByLabelText('School code'), 'sunrise')
    await user.type(screen.getByLabelText('Admission number'), 'ADM-0901')
    await user.type(screen.getByLabelText('Password'), 'my-own-password')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ href: '/students' })))
  })

  it('gives a pupil one message whatever was wrong', async () => {
    const user = userEvent.setup()
    auth.studentSignIn.mockRejectedValue(new ApiRequestError({ code: 'AUTHENTICATION_REQUIRED', status: 401, message: 'x' }))
    render(<LoginScreen returnTo="/students" audience="student" />)
    await user.type(screen.getByLabelText('School code'), 'sunrise')
    await user.type(screen.getByLabelText('Admission number'), 'ADM-0000')
    await user.type(screen.getByLabelText('Password'), 'wrong')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Those details did not match. Check the school code, admission number and password.')).toBeInTheDocument()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('sends the person to where they were going after a successful sign-in', async () => {
    const user = userEvent.setup()
    auth.signInWithEmail.mockResolvedValue({ user: { id: 'u1' } })
    renderLogin()
    await user.type(screen.getByLabelText('Email address'), 'fixture-adult@example.test')
    await user.type(screen.getByLabelText('Password'), 'fixture-password-1')
    await user.click(screen.getByRole('checkbox', { name: /shared device/i }))
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(auth.signInWithEmail).toHaveBeenCalledWith({ email: 'fixture-adult@example.test', password: 'fixture-password-1', sharedDevice: true })
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ href: '/students' }))
  })

  it('keeps the query string on the page the person was sent back to', async () => {
    const user = userEvent.setup()
    auth.signInWithEmail.mockResolvedValue({ user: { id: 'u1' } })
    render(<LoginScreen returnTo="/students?q=raj" />)
    await user.type(screen.getByLabelText('Email address'), 'fixture-adult@example.test')
    await user.type(screen.getByLabelText('Password'), 'fixture-password-1')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ href: '/students?q=raj' })))
  })

  it('goes to the second step when the server asks for one', async () => {
    const user = userEvent.setup()
    auth.signInWithEmail.mockResolvedValue({ twoFactorRedirect: true })
    renderLogin()
    await user.type(screen.getByLabelText('Email address'), 'fixture-owner-a@example.test')
    await user.type(screen.getByLabelText('Password'), 'fixture-password-1')
    await user.click(screen.getByRole('checkbox', { name: /shared device/i }))
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    // The shared-device choice has to survive the second step: the provider drops it on a redirect.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/mfa/verify', search: { returnTo: '/students', sharedDevice: true } })))
    expect(refresh).not.toHaveBeenCalled()
  })

  it('never says which detail was wrong', async () => {
    const user = userEvent.setup()
    auth.signInWithEmail.mockRejectedValue(new ApiRequestError({ code: 'AUTHENTICATION_REQUIRED', status: 401, message: 'no' }))
    renderLogin()
    await user.type(screen.getByLabelText('Email address'), 'someone@example.test')
    await user.type(screen.getByLabelText('Password'), 'nope')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not sign you in with those details.')
  })

  it('disables the button and counts down when the server throttles us', async () => {
    vi.useFakeTimers()
    auth.signInWithEmail.mockRejectedValue(new ApiRequestError({ code: 'RATE_LIMITED', status: 429, message: 'slow', retryAfterSeconds: 30 }))
    renderLogin()
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'someone@example.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(screen.getByRole('button', { name: /Try again in 30s/ })).toBeDisabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(screen.getByRole('button', { name: /Try again in 28s/ })).toBeDisabled()
  })

  it('sends a code and moves to the code screen for a parent', async () => {
    const user = userEvent.setup()
    auth.sendPhoneOtp.mockResolvedValue(undefined)
    renderLogin('parent')
    await user.type(screen.getByLabelText('Mobile number'), '9876543210')
    await user.click(screen.getByRole('button', { name: 'Send code' }))
    await waitFor(() => expect(auth.sendPhoneOtp).toHaveBeenCalledWith('+919876543210'))
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: '/verify-otp', search: expect.objectContaining({ phone: '+919876543210', returnTo: '/students' }) }))
  })
})
