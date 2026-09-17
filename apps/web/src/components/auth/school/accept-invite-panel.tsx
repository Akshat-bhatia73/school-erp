/**
 * Accepting an invitation. The token stays in the URL and in the request body only: it is never
 * shown, never logged and never put in a message. An invitation is tied to the email address or
 * phone number the school invited, so the signed-in identity is spelled out before the button.
 */
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { acceptInvitation } from '@/lib/auth-client'
import { isApiError } from '@/lib/api-errors'
import { useSession } from '@/lib/session'
import { ServerUnreachable } from '@/components/auth/school/server-unreachable'
import { AccessUnavailable } from '@/components/auth/school/access-unavailable'

const UNAVAILABLE = 'This invitation cannot be used. It may have expired, been withdrawn or already been used, or you may be signed in with a different email address or phone number than the one the school invited. Check you are signed in as the invited person, or ask the school office for a new link.'
const CONFLICT = 'You already belong to this school, or another login is linked to it. Ask the school office to check.'
const SIGNED_OUT = 'Your sign-in has ended. Sign in again with the email address or phone number the school invited, then open this link once more.'
const MALFORMED = 'This invitation link is missing or incomplete. Ask the school office to send it again.'

/** The invite link is the return address; sign-in should come straight back to it. */
export function inviteReturnTo(token: string) {
  return `/accept-invite?token=${encodeURIComponent(token)}`
}

export function AcceptInvitePanel({ token }: { token?: string }) {
  const session = useSession()
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A permanent refusal cannot be retried, so the button goes away instead of inviting a loop.
  const [permanent, setPermanent] = useState(false)

  if (!token || token.trim().length < 32) {
    return <p className="text-[13px] text-tag-red" role="alert">{MALFORMED}</p>
  }

  if (session.status === 'loading') return <Skeleton className="h-11 w-full rounded-lg" aria-busy="true" />
  if (session.status === 'blocked') return <AccessUnavailable reason="student" inline />
  if (session.status === 'unavailable') return <ServerUnreachable onRetry={() => { void session.refresh() }} />

  if (session.status !== 'authenticated') {
    return (
      <div className="grid gap-3">
        <p className="text-[13px] text-muted-foreground">
          Sign in to accept this invitation. Use the email address or phone number the school invited — the invitation only works for that one.
        </p>
        <Button asChild className="h-11 w-full md:h-9">
          <Link to="/login" search={{ returnTo: inviteReturnTo(token) }}>Sign in to accept</Link>
        </Button>
      </div>
    )
  }

  const identity = session.user?.email ?? session.user?.phone ?? null

  async function accept() {
    if (!token) return
    setPending(true)
    setError(null)
    try {
      const member = await acceptInvitation(token)
      await session.refresh()
      session.selectSchool(member.schoolId)
      toast.success('You have joined the school')
      void navigate({ to: '/dashboard', replace: true } as never)
    } catch (caught) {
      if (
        isApiError(caught, 'INVITATION_UNAVAILABLE') ||
        isApiError(caught, 'INVALID_REQUEST') ||
        isApiError(caught, 'RESOURCE_NOT_FOUND') ||
        isApiError(caught, 'ACCESS_DENIED')
      ) { setError(UNAVAILABLE); setPermanent(true) }
      else if (isApiError(caught, 'IDENTITY_LINK_CONFLICT')) { setError(CONFLICT); setPermanent(true) }
      else if (isApiError(caught, 'AUTHENTICATION_REQUIRED') || isApiError(caught, 'SESSION_EXPIRED')) { setError(SIGNED_OUT); setPermanent(true) }
      else setError('We could not accept this invitation. Please try again.')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
        <p className="text-[12.5px] text-muted-foreground">Accepting as</p>
        <p className="text-[14px] font-medium">{session.user?.displayName}</p>
        {identity && <p className="text-[12.5px] text-muted-foreground">{identity}</p>}
      </div>
      {error && <p className="text-[12px] text-tag-red" role="alert">{error}</p>}
      {!permanent && (
        <Button className="h-11 w-full md:h-9" disabled={pending} onClick={() => { void accept() }}>
          {pending ? 'Accepting…' : 'Accept invitation'}
        </Button>
      )}
      <Button variant="ghost" className="h-11 w-full md:h-9" disabled={pending} onClick={() => { void session.signOut() }}>
        Not you? Sign out
      </Button>
    </div>
  )
}
