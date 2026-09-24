import { describe, expect, it, vi, beforeEach } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import type { Session } from '@/lib/session'
import { SchoolChooser } from '@/components/auth/school/school-chooser'
import { AcceptInvitePanel, inviteReturnTo } from '@/components/auth/school/accept-invite-panel'
import { AccessUnavailable } from '@/components/auth/school/access-unavailable'
import { ACCESS_REASONS, accessReasonForError } from '@/components/auth/school/access-error'
import { ApiRequestError } from '@/lib/http'

const useSession = vi.hoisted(() => vi.fn())
vi.mock('@/lib/session', () => ({ useSession }))

const acceptInvitation = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth-client', () => ({ acceptInvitation }))

const toastSuccess = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { success: toastSuccess } }))

function membership(over: Record<string, unknown> = {}) {
  return {
    id: 'm1', school: { id: 's1', name: 'Fixture A', code: 'fixture-a' },
    status: 'active', kind: 'adult', roleKeys: ['teacher'], accessVersion: 1,
    ...over,
  } as Session['memberships'][number]
}

const selectSchool = vi.fn()
const signOut = vi.fn(async () => {})
const refresh = vi.fn(async () => {})

function session(over: Partial<Session>): Session {
  const memberships = (over.memberships ?? []) as Session['memberships']
  return {
    status: 'authenticated',
    user: { id: 'u1', displayName: 'Fixture Adult', email: 'fixture-adult@example.test' },
    session: null, memberships, activeMemberships: memberships.filter((m) => m.status === 'active' && m.kind === 'adult'),
    school: null, membership: null, roleKeys: [], capabilities: [], accessVersion: null,
    context: 'ready', twoFactorEnabled: false, hasPermission: () => false, selectSchool, clearSchool: () => {},
    signOut, refresh, generation: 0,
    ...over,
  } as Session
}

function renderInRouter(node: ReactNode, initial = '/') {
  const rootRoute = createRootRoute({ component: Outlet })
  const here = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => <>{node}</> })
  const login = createRoute({
    getParentRoute: () => rootRoute, path: '/login',
    validateSearch: (s: Record<string, unknown>) => ({ returnTo: typeof s.returnTo === 'string' ? s.returnTo : undefined }),
    component: () => <p>Sign in page</p>,
  })
  const other = createRoute({ getParentRoute: () => rootRoute, path: '/$', component: () => <p>Elsewhere</p> })
  const router = createRouter({
    routeTree: rootRoute.addChildren([here, login, other]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(<RouterProvider router={router as never} />)
  return router
}

beforeEach(() => { vi.clearAllMocks() })

describe('SchoolChooser', () => {
  it('lists only the memberships the session already has', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch' as never)
    useSession.mockReturnValue(session({ memberships: [membership(), membership({ id: 'm2', school: { id: 's2', name: 'Fixture B', code: 'fixture-b' }, roleKeys: ['owner'] })] }))
    renderInRouter(<SchoolChooser />)
    await waitFor(() => expect(screen.getByText('Fixture A')).toBeInTheDocument())
    expect(screen.getByText('Fixture B')).toBeInTheDocument()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not list student memberships', async () => {
    useSession.mockReturnValue(session({ memberships: [membership(), membership({ id: 'm3', kind: 'student', school: { id: 's3', name: 'Student School', code: 'stu' } })] }))
    renderInRouter(<SchoolChooser />)
    await waitFor(() => expect(screen.getByText('Fixture A')).toBeInTheDocument())
    expect(screen.queryByText('Student School')).not.toBeInTheDocument()
  })

  it('does not list a membership the server did not mark active', async () => {
    useSession.mockReturnValue(session({ memberships: [membership(), membership({ id: 'm4', status: 'suspended', school: { id: 's4', name: 'Suspended School', code: 'sus' } })] }))
    renderInRouter(<SchoolChooser />)
    await waitFor(() => expect(screen.getByText('Fixture A')).toBeInTheDocument())
    expect(screen.queryByText('Suspended School')).not.toBeInTheDocument()
  })

  it('selects a school and goes to the return path', async () => {
    useSession.mockReturnValue(session({ memberships: [membership()] }))
    const router = renderInRouter(<SchoolChooser returnTo="/students" />)
    await userEvent.click(await screen.findByRole('button', { name: /Fixture A/ }))
    expect(selectSchool).toHaveBeenCalledWith('s1')
    await waitFor(() => expect(router.state.location.pathname).toBe('/students'))
  })

  it('offers a retry when the server cannot be reached', async () => {
    useSession.mockReturnValue(session({ status: 'unavailable', memberships: [] }))
    renderInRouter(<SchoolChooser />)
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalled()
  })

  it('explains that nothing is linked yet when there is no membership', async () => {
    useSession.mockReturnValue(session({ memberships: [] }))
    renderInRouter(<SchoolChooser />)
    expect(await screen.findByText(/not linked to any school right now/)).toBeInTheDocument()
  })
})

describe('AcceptInvitePanel', () => {
  const token = '10000000-0000-4000-8000-000000000001.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

  it('says the link is incomplete without a token', async () => {
    useSession.mockReturnValue(session({}))
    renderInRouter(<AcceptInvitePanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/missing or incomplete/)
  })

  it('asks an anonymous visitor to sign in and comes back to the invite', async () => {
    useSession.mockReturnValue(session({ status: 'anonymous' }))
    renderInRouter(<AcceptInvitePanel token={token} />)
    const link = await screen.findByRole('link', { name: 'Sign in to accept' })
    expect(link).toHaveAttribute('href', expect.stringContaining(encodeURIComponent(token)))
    expect(inviteReturnTo(token)).toBe(`/accept-invite?token=${encodeURIComponent(token)}`)
  })

  it('shows the invitation-unavailable copy when the server refuses', async () => {
    useSession.mockReturnValue(session({ memberships: [] }))
    acceptInvitation.mockRejectedValue(new ApiRequestError({ code: 'INVITATION_UNAVAILABLE', status: 400, message: 'no' }))
    renderInRouter(<AcceptInvitePanel token={token} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/cannot be used/)
    expect(alert).toHaveTextContent(/different email address or phone number/)
    expect(screen.getByRole('button', { name: 'Not you? Sign out' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument()
  })

  it('does not offer a retry when the invitation can never be accepted', async () => {
    useSession.mockReturnValue(session({ memberships: [] }))
    acceptInvitation.mockRejectedValue(new ApiRequestError({ code: 'RESOURCE_NOT_FOUND', status: 404, message: 'no' }))
    renderInRouter(<AcceptInvitePanel token={token} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be used/)
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument()
  })

  it('offers a retry when the server cannot be reached', async () => {
    useSession.mockReturnValue(session({ status: 'unavailable', memberships: [] }))
    renderInRouter(<AcceptInvitePanel token={token} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(refresh).toHaveBeenCalled()
  })

  it('joins the school on success', async () => {
    useSession.mockReturnValue(session({ memberships: [] }))
    acceptInvitation.mockResolvedValue({ id: 'm9', schoolId: 's9', displayName: 'Fixture Adult', status: 'active', roleKeys: ['teacher'], accessVersion: 1 })
    renderInRouter(<AcceptInvitePanel token={token} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }))
    await waitFor(() => expect(selectSchool).toHaveBeenCalledWith('s9'))
    expect(refresh).toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('never renders the token itself', async () => {
    useSession.mockReturnValue(session({ memberships: [] }))
    renderInRouter(<AcceptInvitePanel token={token} />)
    await screen.findByRole('button', { name: 'Accept invitation' })
    expect(document.body.textContent).not.toContain(token)
  })
})

describe('AccessUnavailable', () => {
  const titles: Record<string, RegExp> = {
    no_membership: /not linked to any school right now/,
    suspended: /access to this school is suspended/,
    school: /not available right now/,
    student: /Your student login is switched off/,
    disabled: /This account is disabled/,
    forbidden: /do not have access to that page/,
    not_found: /could not find that record/,
  }

  it('has copy for every reason', async () => {
    for (const reason of ACCESS_REASONS) {
      useSession.mockReturnValue(session({ memberships: [membership()] }))
      renderInRouter(<AccessUnavailable reason={reason} inline />)
      expect(await screen.findByText(titles[reason]!)).toBeInTheDocument()
      cleanup()
    }
  })

  it('shows no actions while the session is still loading', async () => {
    useSession.mockReturnValue(session({ status: 'loading', memberships: [] }))
    renderInRouter(<AccessUnavailable reason="forbidden" inline />)
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Go to sign in' })).not.toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('always offers sign in to a signed-out visitor', async () => {
    useSession.mockReturnValue(session({ status: 'anonymous', memberships: [] }))
    renderInRouter(<AccessUnavailable reason="student" inline />)
    expect(await screen.findByRole('link', { name: 'Go to sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })

  it('offers another school only when there is one', async () => {
    useSession.mockReturnValue(session({ memberships: [membership()] }))
    renderInRouter(<AccessUnavailable reason="suspended" inline />)
    expect(await screen.findByRole('link', { name: 'Choose another school' })).toBeInTheDocument()
    cleanup()
    useSession.mockReturnValue(session({ memberships: [] }))
    renderInRouter(<AccessUnavailable reason="suspended" inline />)
    await screen.findByRole('button', { name: 'Sign out' })
    expect(screen.queryByRole('link', { name: 'Choose another school' })).not.toBeInTheDocument()
  })

  it('maps API refusals onto a reason', () => {
    expect(accessReasonForError(new ApiRequestError({ code: 'ACCESS_DENIED', status: 403, message: 'x' }))).toBe('forbidden')
    expect(accessReasonForError(new ApiRequestError({ code: 'RESOURCE_NOT_FOUND', status: 404, message: 'x' }))).toBe('not_found')
    expect(accessReasonForError(new ApiRequestError({ code: 'SCHOOL_ACCESS_UNAVAILABLE', status: 403, message: 'x' }))).toBe('school')
    expect(accessReasonForError(new ApiRequestError({ code: 'FEATURE_DISABLED', status: 403, message: 'x' }))).toBe('student')
    expect(accessReasonForError(new Error('boom'))).toBeNull()
  })
})
