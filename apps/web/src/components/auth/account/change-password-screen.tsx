import { useNavigate } from '@tanstack/react-router'
import { useState, type FormEvent } from 'react'
import { AuthLayout } from '@/components/auth/auth-layout'
import { RedirectOnce } from '@/components/auth/app-gate'
import { AuthField, FormError, PasswordInput, TALL_BUTTON } from '@/components/auth/login/parts'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { describeError, isApiError } from '@/lib/api-errors'
import { changePassword } from '@/lib/auth-client'
import { DEFAULT_RETURN_TO, sanitiseReturnTo } from '@/lib/return-to'
import { useSession } from '@/lib/session'

const CHANGE_PASSWORD_PATH = '/account/change-password'

/** Where to go afterwards: never back to this screen. */
function destination(returnTo: string | undefined) {
  const next = sanitiseReturnTo(returnTo)
  return next.startsWith(CHANGE_PASSWORD_PATH) ? DEFAULT_RETURN_TO : next
}

/**
 * The first thing a pupil sees after signing in with the password the school texted to their
 * parent. Every school route refuses them until they choose their own, so this is a full page
 * outside the app shell with nothing else to click.
 */
export function ChangePasswordScreen({ returnTo }: { returnTo?: string }) {
  const session = useSession()
  const navigate = useNavigate()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [saved, setSaved] = useState(false)

  if (session.status === 'loading') {
    return <AuthLayout title="Choose your password"><Skeleton className="h-40 w-full rounded-xl" /></AuthLayout>
  }
  if (session.status === 'anonymous') return <RedirectOnce to="/login" search={{ returnTo: destination(returnTo) }} />
  if (session.status === 'blocked') return <RedirectOnce to="/access-unavailable" search={{ reason: 'student' }} />
  // Nothing to change (a typed address, or another tab already did it): carry on into the app.
  if (session.status === 'authenticated' && !session.passwordChangeRequired && !pending && !saved) {
    return <RedirectOnce to={destination(returnTo)} />
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setError(null)
    if (!current) { setError('Enter the password you signed in with.'); return }
    if (next.length < 12) { setError('Use at least 12 characters.'); return }
    if (next !== confirm) { setError('The two new passwords do not match.'); return }
    setPending(true)
    try {
      await changePassword({ currentPassword: current, newPassword: next })
      setSaved(true)
      await session.refresh()
      void navigate({ href: destination(returnTo), replace: true } as never)
    } catch (caught) {
      setError(isApiError(caught, 'INVALID_REQUEST') || isApiError(caught, 'AUTHENTICATION_REQUIRED')
        ? 'That current password did not match.'
        : describeError(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthLayout
      title="Choose your password"
      description="The password you signed in with was sent by the school. Choose your own before you carry on."
    >
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <AuthField id="change-current" label="Current password">
          <PasswordInput id="change-current" value={current} onChange={setCurrent} disabled={pending} autoComplete="current-password" />
        </AuthField>
        <AuthField id="change-new" label="New password" hint="At least 12 characters.">
          <PasswordInput id="change-new" value={next} onChange={setNext} disabled={pending} autoComplete="new-password" />
        </AuthField>
        <AuthField id="change-confirm" label="Confirm new password">
          <PasswordInput id="change-confirm" value={confirm} onChange={setConfirm} disabled={pending} autoComplete="new-password" />
        </AuthField>
        <Button type="submit" className={TALL_BUTTON} disabled={pending}>{pending ? 'Saving…' : 'Save password'}</Button>
        <button type="button" className="text-center text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => { void session.signOut() }}>
          Sign out
        </button>
      </form>
    </AuthLayout>
  )
}
