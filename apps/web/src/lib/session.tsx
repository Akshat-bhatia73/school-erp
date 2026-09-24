/**
 * The application session, derived from the server and nothing else.
 *
 * `/api/me` says who is signed in and which schools they belong to; `/api/schools/:id/context`
 * says what they may do inside the school this tab is looking at. The active school is a per-tab
 * preference in sessionStorage and is only honoured when it matches an active membership;
 * the server takes the school from the URL on every request, so this preference can never widen
 * access. Identity is never read from localStorage.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import type { MeResponse, PermissionKey, SchoolContextResponse } from '@erp/contracts'

type ViewerIdentity = MeResponse['user']
type SessionSummary = MeResponse['session']
type MembershipSummary = MeResponse['memberships'][number]
type SchoolSummary = SchoolContextResponse['school']
import { getSession, me, schoolContext, signOut as signOutRequest } from '@/lib/auth-client'
import { bumpGeneration, currentGeneration, isAbortLike, onSessionLost } from '@/lib/http'
import { isApiError } from '@/lib/api-errors'
import { createQueryClient } from '@/lib/query'

/**
 * `blocked` is a signed-in identity the web app will not open for anyone: today only a pupil whose
 * login the office switched off, or which ended when they left. The server deletes the session and
 * answers FEATURE_DISABLED on every session-backed route, so there is nothing to retry.
 */
export type SessionStatus = 'loading' | 'anonymous' | 'unavailable' | 'blocked' | 'authenticated'
export type ContextStatus = 'idle' | 'loading' | 'ready' | 'mfa_required' | 'password_change_required' | 'unavailable'

const ACTIVE_SCHOOL_KEY = 'erp.activeSchoolId'
const LEGACY_KEYS = ['erp.schoolId', 'erp.userId']
const CHANNEL_NAME = 'erp-session'
const CONTEXT_POLL_MS = 30_000

export interface Session {
  status: SessionStatus
  user: ViewerIdentity | null
  session: SessionSummary | null
  memberships: MembershipSummary[]
  /** Memberships this person can actually open: active ones, an adult's or a pupil's own. */
  activeMemberships: MembershipSummary[]
  school: SchoolSummary | null
  membership: MembershipSummary | null
  /** This person's membership in the active school, from the context response. Null until ready. */
  membershipId: string | null
  roleKeys: string[]
  capabilities: PermissionKey[]
  accessVersion: number | null
  context: ContextStatus
  twoFactorEnabled: boolean
  /** The password was texted by the school: nothing else opens until the person chooses their own. */
  // Optional so a hand-built test session (src/test/session.tsx) reads as an adult's by default.
  passwordChangeRequired?: boolean
  /** A pupil's own login (a student membership). No second factor, no view switcher. */
  isPupil?: boolean
  /** The pupil this membership is, from the context response. Set for a pupil only. */
  ownStudentId?: string | null
  hasPermission: (key: PermissionKey) => boolean
  selectSchool: (schoolId: string) => void
  clearSchool: () => void
  signOut: () => Promise<void>
  refresh: () => Promise<void>
  generation: number
}

/** Exported for tests only: src/test/session.tsx renders a fully-formed session through it. */
export const SessionContext = createContext<Session | null>(null)

/** An adult's membership and a pupil's own are opened the same way; the server decides the rest. */
function isUsable(membership: MembershipSummary) {
  return membership.status === 'active'
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
  ownStudentId: string | null
}

const IDLE_CONTEXT: ContextState = { status: 'idle', school: null, membershipId: null, roleKeys: [], capabilities: [], accessVersion: null, ownStudentId: null }

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading')
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false)
  const [activeSchoolId, setActiveSchoolId] = useState<string | null>(null)
  const [ctx, setCtx] = useState<ContextState>(IDLE_CONTEXT)
  // Bumped to load the school context again once a refused context can open (a new password).
  const [contextAttempt, setContextAttempt] = useState(0)
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
    const usable = memberships.filter(isUsable)
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
        ownStudentId: result.ownStudentId ?? null,
      })
    } catch (error) {
      if (isApiError(error, 'STALE_RESPONSE') || isAbortLike(error)) return
      if (isApiError(error, 'MFA_REQUIRED')) {
        setCtx({ ...IDLE_CONTEXT, status: 'mfa_required' })
        return
      }
      // The school texted this password; the gate sends the person to choose their own.
      if (isApiError(error, 'PASSWORD_CHANGE_REQUIRED')) {
        setCtx({ ...IDLE_CONTEXT, status: 'password_change_required' })
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
  const contextStatusRef = useRef<ContextStatus>(ctx.status)
  contextStatusRef.current = ctx.status

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
  }, [status, activeSchoolId, loadContext, contextAttempt])

  // Any school read refused with PASSWORD_CHANGE_REQUIRED (the office reset the password while
  // this tab was open) sends the person to choose a new one, without waiting for the next poll.
  useEffect(() => client.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || !isApiError(event.query.state.error, 'PASSWORD_CHANGE_REQUIRED')) return
    setCtx((current) => (current.status === 'password_change_required' ? current : { ...IDLE_CONTEXT, status: 'password_change_required' }))
  }), [client])

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
    // The context was refused while the texted password stood. Once it is replaced, ask again
    // rather than leaving the gate on a refusal that no longer holds.
    if (contextStatusRef.current === 'password_change_required') {
      setCtx({ ...IDLE_CONTEXT, status: 'loading' })
      setContextAttempt((n) => n + 1)
    }
  }, [loadIdentity])

  // ---------- derived ----------

  const memberships = identity?.memberships ?? []
  const activeMemberships = useMemo(() => memberships.filter(isUsable), [memberships])
  const membership = useMemo(
    () => activeMemberships.find((m) => m.school.id === activeSchoolId) ?? null,
    [activeMemberships, activeSchoolId],
  )
  const roleKeys: string[] = ctx.status === 'ready' ? ctx.roleKeys : (membership?.roleKeys ?? [])

  const value = useMemo<Session>(() => ({
    status,
    user: identity?.user ?? null,
    session: identity?.session ?? null,
    memberships,
    activeMemberships,
    school: ctx.school ?? membership?.school ?? null,
    membership,
    membershipId: ctx.membershipId,
    roleKeys,
    capabilities: ctx.capabilities,
    accessVersion: ctx.accessVersion,
    context: ctx.status,
    twoFactorEnabled,
    passwordChangeRequired: identity?.session.passwordChangeRequired === true || ctx.status === 'password_change_required',
    isPupil: memberships.some((m) => m.kind === 'student'),
    ownStudentId: ctx.ownStudentId,
    hasPermission: (key) => ctx.capabilities.includes(key),
    selectSchool,
    clearSchool,
    signOut: doSignOut,
    refresh,
    generation,
  }), [status, identity, memberships, activeMemberships, ctx, membership, roleKeys, twoFactorEnabled, selectSchool, clearSchool, doSignOut, refresh, generation])

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

/**
 * The school this screen is inside. It is only ever called under AppGate, which renders nothing
 * school-shaped until the context is ready, so everything here is non-null and a screen never has
 * to write `schoolId ?? ''`.
 */
export function useSchoolContext() {
  const session = useSession()
  if (session.context !== 'ready' || !session.school || !session.membershipId) {
    throw new Error('useSchoolContext must be used inside AppGate, once the school context is ready')
  }
  return {
    schoolId: session.school.id,
    membershipId: session.membershipId,
    school: session.school,
    roleKeys: session.roleKeys,
    capabilities: session.capabilities,
    accessVersion: session.accessVersion,
    hasPermission: session.hasPermission,
    ownStudentId: session.ownStudentId ?? undefined,
  }
}

export function useSession() {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}
