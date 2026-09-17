import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { ApiRequestError } from '@/lib/http'
import { SessionProvider, useSession } from '@/lib/session'

vi.mock('@/lib/auth-client', () => ({
  me: vi.fn(),
  getSession: vi.fn(),
  schoolContext: vi.fn(),
  signOut: vi.fn(),
}))

const client = await import('@/lib/auth-client')
const me = vi.mocked(client.me)
const getSession = vi.mocked(client.getSession)
const schoolContext = vi.mocked(client.schoolContext)

function membership(id: string, name: string, over: Record<string, unknown> = {}) {
  return { id: `mem-${id}`, school: { id, name, code: name.slice(0, 3) }, status: 'active', kind: 'adult', roleKeys: ['teacher'], accessVersion: 1, ...over } as never
}

function meResponse(memberships: unknown[]) {
  return {
    user: { id: 'u1', displayName: 'Asha Rao' },
    session: { expiresAt: '2030-01-01T00:00:00.000Z', assurance: 'single_factor', mfaVerifiedAt: null },
    memberships,
  } as never
}

function apiError(code: string, status: number) {
  return new ApiRequestError({ code: code as never, status, message: 'no' })
}

function Probe() {
  const session = useSession()
  return (
    <div>
      <span data-testid="status">{session.status}</span>
      <span data-testid="context">{session.context}</span>
      <span data-testid="school">{session.school?.id ?? 'none'}</span>
      <span data-testid="name">{session.user?.displayName ?? ''}</span>
      <span data-testid="membership">{session.membershipId ?? 'none'}</span>
    </div>
  )
}

function renderSession() {
  return render(<SessionProvider><Probe /></SessionProvider>)
}

describe('SessionProvider', () => {
  beforeEach(() => {
    me.mockReset(); getSession.mockReset(); schoolContext.mockReset()
    getSession.mockResolvedValue(null)
  })

  it('is anonymous when the bootstrap is refused', async () => {
    me.mockRejectedValue(apiError('AUTHENTICATION_REQUIRED', 401))
    renderSession()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'))
  })

  it('is blocked, not unavailable, when this way of signing in is turned off', async () => {
    // A student identity: the server deletes the session and answers FEATURE_DISABLED, so there
    // is nothing to retry and the app must say so rather than blame the connection.
    me.mockRejectedValue(apiError('FEATURE_DISABLED', 403))
    renderSession()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('blocked'))
  })

  it('is unavailable when the server cannot be reached', async () => {
    me.mockRejectedValue(apiError('NETWORK_ERROR', 0))
    renderSession()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unavailable'))
  })

  it('selects the only active school by itself', async () => {
    me.mockResolvedValue(meResponse([membership('school-a', 'Alpha')]))
    schoolContext.mockResolvedValue({ school: { id: 'school-a', name: 'Alpha', code: 'ALP' }, membershipId: 'mem-school-a', accessVersion: 1, roleKeys: ['teacher'], capabilities: [], studentLoginEnabled: false } as never)
    renderSession()
    await waitFor(() => expect(screen.getByTestId('context')).toHaveTextContent('ready'))
    expect(screen.getByTestId('school')).toHaveTextContent('school-a')
    expect(screen.getByTestId('name')).toHaveTextContent('Asha Rao')
    // Screens address a member by the membership the context response named, never by the user id.
    expect(screen.getByTestId('membership')).toHaveTextContent('mem-school-a')
  })

  it('picks no school when there is more than one', async () => {
    me.mockResolvedValue(meResponse([membership('school-a', 'Alpha'), membership('school-b', 'Beta')]))
    renderSession()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(screen.getByTestId('school')).toHaveTextContent('none')
    expect(schoolContext).not.toHaveBeenCalled()
  })

  it('keeps the school and asks for a second step when the context needs MFA', async () => {
    me.mockResolvedValue(meResponse([membership('school-a', 'Alpha', { roleKeys: ['owner'] })]))
    schoolContext.mockRejectedValue(apiError('MFA_REQUIRED', 403))
    renderSession()
    await waitFor(() => expect(screen.getByTestId('context')).toHaveTextContent('mfa_required'))
  })

  it('ignores and removes the old localStorage identity keys', async () => {
    window.localStorage.setItem('erp.userId', 'someone-else')
    window.localStorage.setItem('erp.schoolId', 'another-school')
    me.mockResolvedValue(meResponse([membership('school-a', 'Alpha')]))
    schoolContext.mockResolvedValue({ school: { id: 'school-a', name: 'Alpha', code: 'ALP' }, membershipId: 'mem-school-a', accessVersion: 1, roleKeys: ['teacher'], capabilities: [], studentLoginEnabled: false } as never)
    renderSession()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'))
    expect(window.localStorage.getItem('erp.userId')).toBeNull()
    expect(window.localStorage.getItem('erp.schoolId')).toBeNull()
    expect(screen.getByTestId('name')).toHaveTextContent('Asha Rao')
  })

  it('clears the session when another tab signs out', async () => {
    me.mockResolvedValue(meResponse([membership('school-a', 'Alpha')]))
    schoolContext.mockResolvedValue({ school: { id: 'school-a', name: 'Alpha', code: 'ALP' }, membershipId: 'mem-school-a', accessVersion: 1, roleKeys: ['teacher'], capabilities: [], studentLoginEnabled: false } as never)
    renderSession()
    await waitFor(() => expect(screen.getByTestId('context')).toHaveTextContent('ready'))

    const other = new BroadcastChannel('erp-session')
    await act(async () => {
      other.postMessage({ type: 'signed-out' })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    other.close()

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'))
    expect(screen.getByTestId('school')).toHaveTextContent('none')
    expect(window.sessionStorage.getItem('erp.activeSchoolId')).toBeNull()
  })
})
