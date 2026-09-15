/**
 * The application session, derived from the server and nothing else.
 *
 * `/api/me` says who is signed in and which schools they belong to; `/api/schools/:id/context`
 * says what they may do inside the school this tab is looking at. The active school is a per-tab
 * preference in sessionStorage and is only honoured when it matches an active adult membership;
 * the server takes the school from the URL on every request, so this preference can never widen
 * access. Identity is never read from localStorage.
 *
 * LEGACY BRIDGE. The feature screens still read the in-memory mock API in `api/client.ts` and ask
 * `can(module, action)` with the `@erp/shared` role model, which is a different vocabulary from
 * the server's permission keys. Until Task 7 moves those screens onto the real protected APIs and
 * `allowedActions`, this provider keeps both worlds alive: it resolves the mock roles whose key
 * matches the server's `roleKeys` (the server's `principal` maps onto the mock `owner` role),
 * computes `can`/`scope` from them, and pushes the signed-in person into the mock client through
 * `setApiContext`. Nothing in that bridge is an authorization decision — the server decides — and
 * the whole block, along with `can`, `scope` and `roles`, disappears with Task 7.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import type { MeResponse, PermissionKey, SchoolContextResponse } from '@erp/contracts'

type ViewerIdentity = MeResponse['user']
type SessionSummary = MeResponse['session']
type MembershipSummary = MeResponse['memberships'][number]
type SchoolSummary = SchoolContextResponse['school']
import { can as canWithRoles, resolvePermission, type Action, type Module, type Role, type Scope } from '@erp/shared'
import { getSession, me, schoolContext, signOut as signOutRequest } from '@/lib/auth-client'
import { bumpGeneration, currentGeneration, isAbortLike, onSessionLost } from '@/lib/http'
import { isApiError } from '@/lib/api-errors'
import { createQueryClient } from '@/lib/query'
import { setApiContext } from '@/api/client'
import { getStore } from '@/api/store'

/**
 * `blocked` is a signed-in identity the web app will not open for anyone: today only a student,
 * whose sign-in is specified but disabled. The server deletes the session and answers
 * FEATURE_DISABLED on every session-backed route, so there is nothing to retry.
 */
export type SessionStatus = 'loading' | 'anonymous' | 'unavailable' | 'blocked' | 'authenticated'
export type ContextStatus = 'idle' | 'loading' | 'ready' | 'mfa_required' | 'unavailable'

const ACTIVE_SCHOOL_KEY = 'erp.activeSchoolId'
const LEGACY_KEYS = ['erp.schoolId', 'erp.userId']
const CHANNEL_NAME = 'erp-session'
const CONTEXT_POLL_MS = 30_000

export interface Session {
  status: SessionStatus
  user: ViewerIdentity | null
  session: SessionSummary | null
  memberships: MembershipSummary[]
  /** Memberships this person can actually open: active and adult. Student access is disabled. */
  activeMemberships: MembershipSummary[]
  school: SchoolSummary | null
  membership: MembershipSummary | null
  roleKeys: string[]
  capabilities: PermissionKey[]
  accessVersion: number | null
  context: ContextStatus
  twoFactorEnabled: boolean
  hasPermission: (key: PermissionKey) => boolean
  /** LEGACY BRIDGE — removed in Task 7. */
  can: (module: Module, action?: Action) => boolean
  /** LEGACY BRIDGE — removed in Task 7. */
  scope: (module: Module, action?: Action) => Scope
  /** LEGACY BRIDGE — removed in Task 7. */
  roles: Role[]
  selectSchool: (schoolId: string) => void
  clearSchool: () => void
  signOut: () => Promise<void>
  refresh: () => Promise<void>
  generation: number
}

const SessionContext = createContext<Session | null>(null)

function isActiveAdult(membership: MembershipSummary) {
  return membership.status === 'active' && membership.kind === 'adult'
}

function readStoredSchoolId() {
  try {
    return window.sessionStorage.getItem(ACTIVE_SCHOOL_KEY)
  } catch {
    return null
  }
}

function storeSchoolId(schoolId: string | null) {
  try {
    if (schoolId) window.sessionStorage.setItem(ACTIVE_SCHOOL_KEY, schoolId)
    else window.sessionStorage.removeItem(ACTIVE_SCHOOL_KEY)
  } catch {
    // A tab with storage blocked simply picks its school again each time.
  }
}

interface Identity {
  user: ViewerIdentity
  session: SessionSummary
  memberships: MembershipSummary[]
}

interface ContextState {
  status: ContextStatus
  school: SchoolSummary | null
  membershipId: string | null
  roleKeys: string[]
  capabilities: PermissionKey[]
  accessVersion: number | null
}

const IDLE_CONTEXT: ContextState = { status: 'idle', school: null, membershipId: null, roleKeys: [], capabilities: [], accessVersion: null }

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading')
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false)
  const [activeSchoolId, setActiveSchoolId] = useState<string | null>(null)
  const [ctx, setCtx] = useState<ContextState>(IDLE_CONTEXT)
  const [generation, setGeneration] = useState(() => currentGeneration())
  const [client, setClient] = useState<QueryClient>(() => createQueryClient())
  const channelRef = useRef<BroadcastChannel | null>(null)

  // Identity used to live in localStorage. Remove the old keys so nobody can set them by hand
  // and expect anything to happen.
  useEffect(() => {
    for (const key of LEGACY_KEYS) {
      try { window.localStorage.removeItem(key) } catch { /* storage may be blocked */ }
    }
  }, [])

  /** Throw away every cached answer belonging to the previous identity or school. */
  const resetCache = useCallback(() => {
    bumpGeneration()
    setClient((previous) => {
      void previous.cancelQueries()
      previous.clear()
      return createQueryClient()
    })
    setGeneration(currentGeneration())
  }, [])

  const applyMemberships = useCallback((memberships: MembershipSummary[]) => {
    const usable = memberships.filter(isActiveAdult)
    setActiveSchoolId((current) => {
      const preferred = current ?? readStoredSchoolId()
      const matched = preferred && usable.some((m) => m.school.id === preferred) ? preferred : null
      const next = matched ?? (usable.length === 1 ? usable[0]!.school.id : null)
      storeSchoolId(next)
      return next
    })
  }, [])

  const loadIdentity = useCallback(async () => {
    try {
      const [meResult, sessionResult] = await Promise.all([me(), getSession().catch(() => null)])
      setIdentity({ user: meResult.user, session: meResult.session, memberships: meResult.memberships })
      setTwoFactorEnabled(sessionResult?.user.twoFactorEnabled === true)
      applyMemberships(meResult.memberships)
      setStatus('authenticated')
    } catch (error) {
      if (isApiError(error, 'STALE_RESPONSE') || isAbortLike(error)) return
      const blocked = isApiError(error, 'FEATURE_DISABLED')
      if (blocked || isApiError(error, 'AUTHENTICATION_REQUIRED') || isApiError(error, 'SESSION_EXPIRED')) {
        setIdentity(null)
        setTwoFactorEnabled(false)
        setActiveSchoolId(null)
        storeSchoolId(null)
        setCtx(IDLE_CONTEXT)
        // FEATURE_DISABLED here means this way of signing in is off, not that the server is down:
        // say so instead of offering a "try again" that can never work.
        setStatus(blocked ? 'blocked' : 'anonymous')
        return
      }
      setStatus('unavailable')
    }
  }, [applyMemberships])

  useEffect(() => { void loadIdentity() }, [loadIdentity])

  // A refused request anywhere in the app means the cookie is gone; re-derive the session.
  useEffect(() => onSessionLost(() => { void loadIdentity() }), [loadIdentity])

  // ---------- school context ----------

  const loadContext = useCallback(async (schoolId: string, previousVersion: number | null) => {
    try {
      const result = await schoolContext(schoolId)
      // A changed access version means someone altered this person's access: drop every cached
      // answer so screens reload against the new rules.
      if (previousVersion !== null && previousVersion !== result.accessVersion) resetCache()
      setCtx({
        status: 'ready',
        school: result.school,
        membershipId: result.membershipId,
        roleKeys: result.roleKeys,
        capabilities: result.capabilities,
        accessVersion: result.accessVersion,
      })
    } catch (error) {
      if (isApiError(error, 'STALE_RESPONSE') || isAbortLike(error)) return
      if (isApiError(error, 'MFA_REQUIRED')) {
        setCtx({ ...IDLE_CONTEXT, status: 'mfa_required' })
        return
      }
      if (isApiError(error, 'SCHOOL_ACCESS_UNAVAILABLE')) {
        setCtx({ ...IDLE_CONTEXT, status: 'unavailable' })
        setActiveSchoolId(null)
        storeSchoolId(null)
        void loadIdentity()
        return
      }
      if (isApiError(error, 'AUTHENTICATION_REQUIRED') || isApiError(error, 'SESSION_EXPIRED')) return
      setCtx({ ...IDLE_CONTEXT, status: 'unavailable' })
    }
  }, [loadIdentity, resetCache])

  const accessVersionRef = useRef<number | null>(null)
  accessVersionRef.current = ctx.accessVersion

  useEffect(() => {
    if (status !== 'authenticated' || !activeSchoolId) {
      setCtx(IDLE_CONTEXT)
      return
    }
    setCtx((current) => (current.school?.id === activeSchoolId ? current : { ...IDLE_CONTEXT, status: 'loading' }))
    void loadContext(activeSchoolId, accessVersionRef.current)

    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadContext(activeSchoolId, accessVersionRef.current)
    }, CONTEXT_POLL_MS)
    const onFocus = () => { void loadContext(activeSchoolId, accessVersionRef.current) }
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(poll)
      window.removeEventListener('focus', onFocus)
    }
  }, [status, activeSchoolId, loadContext])

  // ---------- across tabs ----------

  const clearLocally = useCallback(() => {
    resetCache()
    setIdentity(null)
    setTwoFactorEnabled(false)
    setActiveSchoolId(null)
    storeSchoolId(null)
    setCtx(IDLE_CONTEXT)
    setStatus('anonymous')
  }, [resetCache])

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channelRef.current = channel
    channel.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'signed-out') clearLocally()
      if (event.data?.type === 'signed-in') void loadIdentity()
    }
    return () => {
      channel.close()
      channelRef.current = null
    }
  }, [clearLocally, loadIdentity])

  // ---------- actions ----------

  const selectSchool = useCallback((schoolId: string) => {
    setActiveSchoolId((current) => {
      if (current === schoolId) return current
      resetCache()
      storeSchoolId(schoolId)
      return schoolId
    })
  }, [resetCache])

  const clearSchool = useCallback(() => {
    resetCache()
    storeSchoolId(null)
    setActiveSchoolId(null)
    setCtx(IDLE_CONTEXT)
  }, [resetCache])

  const doSignOut = useCallback(async () => {
    try { await signOutRequest() } catch { /* the cookie is going away either way */ }
    clearLocally()
    channelRef.current?.postMessage({ type: 'signed-out' })
  }, [clearLocally])

  const refresh = useCallback(async () => {
    await loadIdentity()
  }, [loadIdentity])

  // ---------- legacy bridge ----------

  const memberships = identity?.memberships ?? []
  const activeMemberships = useMemo(() => memberships.filter(isActiveAdult), [memberships])
  const membership = useMemo(
    () => activeMemberships.find((m) => m.school.id === activeSchoolId) ?? null,
    [activeMemberships, activeSchoolId],
  )
  const roleKeys: string[] = ctx.status === 'ready' ? ctx.roleKeys : (membership?.roleKeys ?? [])

  const legacyRoles = useMemo<Role[]>(() => {
    const wanted = new Set(roleKeys.map((key) => (key === 'principal' ? 'owner' : key)))
    const store = getStore()
    const schoolId = store.schools[0]?.id
    return store.roles.filter((role) => role.schoolId === schoolId && wanted.has(role.key))
  }, [roleKeys])

  const membershipIndex = membership ? activeMemberships.indexOf(membership) : 0
  setApiContext({
    schoolId: activeSchoolId ?? '',
    userId: identity?.user.id ?? '',
    displayName: identity?.user.displayName ?? '',
    roleKeys,
    membershipIndex: membershipIndex < 0 ? 0 : membershipIndex,
  })

  const value = useMemo<Session>(() => ({
    status,
    user: identity?.user ?? null,
    session: identity?.session ?? null,
    memberships,
    activeMemberships,
    school: ctx.school ?? membership?.school ?? null,
    membership,
    roleKeys,
    capabilities: ctx.capabilities,
    accessVersion: ctx.accessVersion,
    context: ctx.status,
    twoFactorEnabled,
    hasPermission: (key) => ctx.capabilities.includes(key),
    can: (module, action = 'view') => canWithRoles(legacyRoles, module, action),
    scope: (module, action = 'view') => resolvePermission(legacyRoles, module, action),
    roles: legacyRoles,
    selectSchool,
    clearSchool,
    signOut: doSignOut,
    refresh,
    generation,
  }), [status, identity, memberships, activeMemberships, ctx, membership, roleKeys, twoFactorEnabled, legacyRoles, selectSchool, clearSchool, doSignOut, refresh, generation])

  return (
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
    </QueryClientProvider>
  )
}

/**
 * Call once a login succeeds, right before `refresh()`. Other tabs that are still sitting on an
 * anonymous screen pick the new session up instead of waiting for a reload.
 */
export function announceSignIn() {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(CHANNEL_NAME)
  channel.postMessage({ type: 'signed-in' })
  channel.close()
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}
