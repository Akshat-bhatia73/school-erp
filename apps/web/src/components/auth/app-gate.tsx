import { useNavigate, useRouterState } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { sanitiseReturnTo } from '@/lib/return-to'
import { useSession } from '@/lib/session'

/**
 * Nothing protected renders until the server has told us who this is and what they may do here.
 * Every branch below is a redirect or a neutral screen; none of them shows school data.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const session = useSession()
  const location = useRouterState({ select: (s) => s.location })
  // Captured once. While a redirect is in flight the location is already the auth screen, and
  // recomputing it there would send the person round in circles.
  const returnTo = useRef(sanitiseReturnTo(location.href)).current

  if (session.status === 'loading') return <GateSkeleton />

  if (session.status === 'anonymous') return <RedirectOnce to="/login" search={{ returnTo }} />

  if (session.status === 'blocked') return <RedirectOnce to="/access-unavailable" search={{ reason: 'student' }} />

  if (session.status === 'unavailable') {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-3 bg-background p-8 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-tag-orange"><AlertTriangle className="size-5" /></div>
        <p className="text-[15px] font-semibold">We cannot reach the server</p>
        <p className="max-w-sm text-[13px] text-muted-foreground">Your work is safe. Check your connection and try again.</p>
        <Button className="mt-2 h-11 md:h-9" onClick={() => { void session.refresh() }}>Try again</Button>
      </div>
    )
  }

  // A password the school texted is replaced before anything else opens; the school routes would
  // answer PASSWORD_CHANGE_REQUIRED anyway.
  if (session.passwordChangeRequired) return <RedirectOnce to="/account/change-password" search={{ returnTo }} />

  if (session.activeMemberships.length === 0) {
    return <RedirectOnce to="/access-unavailable" search={{ reason: 'no_membership' }} />
  }
  if (!session.membership) return <RedirectOnce to="/select-school" search={{ returnTo }} />
  if (session.context === 'mfa_required') return <RedirectOnce to="/mfa/verify" search={{ returnTo }} />
  if (session.context === 'unavailable') return <RedirectOnce to="/access-unavailable" search={{ reason: 'school' }} />
  if (session.context !== 'ready') return <GateSkeleton />

  return <>{children}</>
}

/**
 * A redirect that fires exactly once. `<Navigate>` re-runs on every render, and a gate that also
 * watches the router state re-renders while the redirect is in flight, which turns a single
 * redirect into a loop.
 */
export function RedirectOnce({ to, search }: { to: string; search?: Record<string, unknown> }) {
  const navigate = useNavigate()
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current) return
    sent.current = true
    // The paths and search shapes are written out in this file; the router's generic option type
    // cannot see that from a shared helper.
    void navigate({ to, search, replace: true } as never)
    // The redirect is decided by the render that mounted this component; later renders must not
    // change it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <GateSkeleton />
}

/** Deliberately empty: no shell, no navigation, no data — just something calm to look at. */
function GateSkeleton() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background p-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your account</span>
      <Skeleton className="h-24 w-full max-w-sm rounded-xl" />
    </div>
  )
}

/**
 * Wraps the public sign-in screens. Somebody who is already all the way in has no business on
 * them, so send them to the app instead of letting them sign in twice.
 */
export function RedirectWhenSignedIn({ children }: { children: ReactNode }) {
  const session = useSession()
  if (session.status === 'authenticated' && session.context === 'ready') return <RedirectOnce to="/dashboard" />
  return <>{children}</>
}
