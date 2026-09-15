import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { CodeField } from '@/components/auth/mfa/code-field'
import { RedirectOnce } from '@/components/auth/app-gate'
import { describeError, describeWait, isApiError } from '@/lib/api-errors'
import { getSession, twoFactorVerifyBackupCode, twoFactorVerifyTotp } from '@/lib/auth-client'
import { reloadTo } from '@/components/auth/mfa/reload-to'
import { announceSignIn } from '@/lib/session'

/**
 * The second step. Reached straight after a password sign-in that asked for it, or from the gate
 * when a school needs a second factor before it will open.
 */
export function MfaVerifyPanel({ returnTo, sharedDevice: sharedDeviceFromSignIn }: { returnTo: string; sharedDevice?: boolean }) {
  const [mode, setMode] = useState<'totp' | 'backup'>('totp')
  const [code, setCode] = useState('')
  const [sharedDevice, setSharedDevice] = useState(sharedDeviceFromSignIn ?? false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [retryAfter, setRetryAfter] = useState(0)
  const [signedOut, setSignedOut] = useState(false)
  const attempted = useRef<string | null>(null)

  const hadSession = useRef(false)

  const account = useQuery({ queryKey: ['auth', 'get-session'], queryFn: getSession })

  useEffect(() => {
    if (account.data) hadSession.current = true
  }, [account.data])

  useEffect(() => {
    if (retryAfter <= 0) return
    const timer = window.setInterval(() => setRetryAfter((left) => Math.max(0, left - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [retryAfter])

  // A password sign-in that asked for a second step has no session row yet, so `get-session`
  // answers null right here; treating that as signed out would send the person back to sign in
  // for ever. Only a session that existed and then went away counts as signed out.
  if (signedOut) return <RedirectOnce to="/login" search={{ returnTo }} />
  if (account.isPending) return <Skeleton className="h-28 w-full rounded-lg" />
  // A privileged membership needs an authenticator before the school will open. Only worth saying
  // when the server actually described a session.
  if (account.data && account.data.user.twoFactorEnabled !== true) return <RedirectOnce to="/mfa/setup" search={{ returnTo }} />

  const blocked = pending || retryAfter > 0

  const submit = async (value: string) => {
    const entered = value.trim()
    if (!entered || blocked) return
    attempted.current = entered
    setPending(true)
    setMessage(null)
    try {
      if (mode === 'totp') await twoFactorVerifyTotp({ code: entered, sharedDevice })
      else await twoFactorVerifyBackupCode({ code: entered, sharedDevice })
      announceSignIn()
      // A page load, not a client route change: the school context has to be read again before
      // anything protected renders. See reload-to.ts.
      reloadTo(returnTo)
    } catch (error) {
      if (isApiError(error, 'RATE_LIMITED')) {
        const seconds = error.retryAfterSeconds ?? 60
        setRetryAfter(seconds)
        setMessage(`Too many attempts. ${describeWait(seconds)}`)
      } else if (isApiError(error, 'SESSION_EXPIRED')) {
        setSignedOut(true)
      } else if (
        isApiError(error, 'AUTHENTICATION_REQUIRED')
        || isApiError(error, 'INVALID_REQUEST')
        || isApiError(error, 'ACCESS_DENIED')
      ) {
        // A refused code and a lost session look identical here: the provider answers 401 for a
        // wrong authenticator code as well. Say the code was wrong, and only send someone back to
        // sign in when the server also says there is no session left to finish.
        setMessage('That code did not work.')
        if (hadSession.current) {
          const still = await getSession().catch(() => null)
          if (!still) { setSignedOut(true); return }
        }
      } else {
        setMessage(describeError(error))
      }
      setCode('')
    } finally {
      setPending(false)
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => { event.preventDefault(); void submit(code) }}
    >
      <p className="text-[13px] text-muted-foreground">
        Your role gives access to sensitive school records, so a second step is required.
      </p>

      <CodeField
        mode={mode}
        value={code}
        disabled={blocked}
        onChange={(next) => { setCode(next); if (message) setMessage(null) }}
        onComplete={(next) => { if (next !== attempted.current) void submit(next) }}
      />

      <label className="flex items-start gap-2 text-[13px]">
        <Checkbox
          checked={sharedDevice}
          disabled={blocked}
          onCheckedChange={(state) => setSharedDevice(state === true)}
          aria-label="This is a shared device"
        />
        <span>
          This is a shared device
          <span className="block text-[12px] text-muted-foreground">We will sign you out sooner.</span>
        </span>
      </label>

      {message && <p role="alert" className="text-[12.5px] text-tag-red">{message}</p>}
      {retryAfter > 0 && retryAfter <= 90 && <p aria-live="polite" className="text-[12.5px] text-muted-foreground">{describeWait(retryAfter)}</p>}

      <Button type="submit" className="h-11 w-full md:h-9" disabled={blocked || code.length === 0}>
        {pending ? 'Checking…' : 'Verify and continue'}
      </Button>

      <button
        type="button"
        className="justify-self-start text-[12.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => {
          setMode((current) => (current === 'totp' ? 'backup' : 'totp'))
          setCode('')
          setMessage(null)
          attempted.current = null
        }}
      >
        {mode === 'totp' ? 'Use a backup code instead' : 'Use your authenticator app instead'}
      </button>
    </form>
  )
}
