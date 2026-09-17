/**
 * Render a screen inside a ready session, with no network and no real provider.
 *
 * A screen test should be about what the screen does with the answer the server gave, not about
 * how the session was derived. `stubSession` builds a fully-formed ready `Session` carrying
 * exactly the capabilities the test asked for; a screen reads `capabilities`, `hasPermission` and
 * the record's own `allowedActions` and nothing else.
 *
 * Screens also use the TanStack Router hooks. There is no router here on purpose: follow the
 * pattern the auth tests already use and mock the module at the top of the test file:
 *
 *   vi.mock('@tanstack/react-router', async (importOriginal) => {
 *     const actual = await importOriginal<typeof import('@tanstack/react-router')>()
 *     return { ...actual, useNavigate: () => navigate, useParams: () => ({ studentId: 's1' }),
 *              Link: ({ children }: { children: ReactNode }) => <a href="#">{children}</a> }
 *   })
 */
import type { ReactElement, ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import type { PermissionKey } from '@erp/contracts'
import { SessionContext, type Session } from '@/lib/session'

export interface SessionStubOptions {
  capabilities?: PermissionKey[]
  roleKeys?: string[]
  schoolId?: string
  membershipId?: string
  user?: { id: string; displayName: string }
  overrides?: Partial<Session>
}

const DEFAULT_SCHOOL_ID = '10000000-0000-4000-8000-000000000001'

/** A ready, authenticated session carrying exactly the access the test asked for. */
export function stubSession(options: SessionStubOptions = {}): Session {
  const schoolId = options.schoolId ?? DEFAULT_SCHOOL_ID
  const membershipId = options.membershipId ?? 'membership-1'
  const user = options.user ?? { id: 'user-1', displayName: 'Asha Rao' }
  const roleKeys = options.roleKeys ?? ['principal']
  const capabilities = options.capabilities ?? []
  const school = { id: schoolId, name: 'Saraswati Vidya Mandir', code: 'SVM' }
  const membership = {
    id: membershipId,
    school,
    status: 'active',
    kind: 'adult',
    roleKeys,
    accessVersion: 1,
  } as unknown as Session['memberships'][number]

  return {
    status: 'authenticated',
    user: user as unknown as Session['user'],
    session: {
      expiresAt: '2100-01-01T00:00:00.000Z',
      assurance: 'single_factor',
      mfaVerifiedAt: null,
    } as unknown as Session['session'],
    memberships: [membership],
    activeMemberships: [membership],
    school: school as unknown as Session['school'],
    membership,
    membershipId,
    roleKeys,
    capabilities,
    accessVersion: 1,
    context: 'ready',
    twoFactorEnabled: false,
    hasPermission: (key) => capabilities.includes(key),
    selectSchool: () => {},
    clearSchool: () => {},
    signOut: async () => {},
    refresh: async () => {},
    generation: 0,
    ...options.overrides,
  }
}

/** A client that never retries and never carries state between tests. */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false }, mutations: { retry: false } },
  })
}

export interface RenderWithSessionResult extends RenderResult {
  session: Session
  queryClient: QueryClient
}

export function renderWithSession(
  ui: ReactElement,
  options: SessionStubOptions & { renderOptions?: Omit<RenderOptions, 'wrapper'> } = {},
): RenderWithSessionResult {
  const session = stubSession(options)
  const queryClient = createTestQueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <SessionContext.Provider value={session}>{children}</SessionContext.Provider>
    </QueryClientProvider>
  )
  return { ...render(ui, { wrapper, ...options.renderOptions }), session, queryClient }
}
