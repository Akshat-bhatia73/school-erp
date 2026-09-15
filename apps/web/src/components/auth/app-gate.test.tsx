import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { AppGate } from '@/components/auth/app-gate'
import type { Session } from '@/lib/session'

const useSession = vi.hoisted(() => vi.fn())
vi.mock('@/lib/session', () => ({ useSession }))

function session(over: Partial<Session>): Session {
  return {
    status: 'authenticated', user: null, session: null, memberships: [], activeMemberships: [],
    school: null, membership: null, roleKeys: [], capabilities: [], accessVersion: null,
    context: 'ready', twoFactorEnabled: false, hasPermission: () => false, selectSchool: () => {}, clearSchool: () => {},
    signOut: async () => {}, refresh: async () => {}, generation: 0,
    ...over,
  } as Session
}

function renderAt(initial: string) {
  const rootRoute = createRootRoute({ component: Outlet })
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/students',
    component: () => <AppGate><p>Student list</p></AppGate>,
  })
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    validateSearch: (search: Record<string, unknown>) => ({ returnTo: typeof search.returnTo === 'string' ? search.returnTo : undefined }),
    component: () => <p>Sign in page</p>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  })
  render(<RouterProvider router={router as never} />)
  return router
}

describe('AppGate', () => {
  it('shows nothing from the app while the session is loading', async () => {
    useSession.mockReturnValue(session({ status: 'loading' }))
    renderAt('/students')
    await waitFor(() => expect(screen.getByText('Loading your account')).toBeInTheDocument())
    expect(screen.queryByText('Student list')).not.toBeInTheDocument()
  })

  it('shows nothing from the app while the school context is still loading', async () => {
    useSession.mockReturnValue(session({ context: 'loading', activeMemberships: [{} as never], membership: {} as never }))
    renderAt('/students')
    await waitFor(() => expect(screen.getByText('Loading your account')).toBeInTheDocument())
    expect(screen.queryByText('Student list')).not.toBeInTheDocument()
  })

  it('sends an anonymous visitor to sign in and remembers where they were going', async () => {
    useSession.mockReturnValue(session({ status: 'anonymous' }))
    const router = renderAt('/students')
    await waitFor(() => expect(screen.getByText('Sign in page')).toBeInTheDocument())
    expect(router.state.location.pathname).toBe('/login')
    expect(router.state.location.search).toEqual({ returnTo: '/students' })
  })

  it('renders the app once the context is ready', async () => {
    useSession.mockReturnValue(session({ activeMemberships: [{} as never], membership: {} as never, context: 'ready' }))
    renderAt('/students')
    await waitFor(() => expect(screen.getByText('Student list')).toBeInTheDocument())
  })
})
