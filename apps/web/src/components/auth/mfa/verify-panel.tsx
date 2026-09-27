import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { SecondStepMethod } from '@erp/contracts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { CodeField } from '@/components/auth/mfa/code-field'
import { RedirectOnce } from '@/components/auth/app-gate'
import { describeError, describeWait, isApiError } from '@/lib/api-errors'
import { getSession, twoFactorSendCode, twoFactorVerifyBackupCode, twoFactorVerifyCode, twoFactorVerifyTotp } from '@/lib/auth-client'
import { destinationFor, isCodeMethod } from '@/components/auth/mfa/methods'
import { reloadTo } from '@/components/auth/mfa/reload-to'
import { announceSignIn } from '@/lib/session'

/**
 * The second step. Reached straight after a password sign-in that asked for it, or from the gate
 * when a school needs a second factor before it will open.
 */
export function MfaVerifyPanel({ returnTo, sharedDevice: sharedDeviceFromSignIn, method: methodFromSignIn, destination: destinationFromSignIn }: {
  returnTo: string
  sharedDevice?: boolean
  /** From a password sign-in: the step this person chose, and where a code goes. */
  method?: SecondStepMethod
  destination?: string
}) {
  const [mode, setMode] = useState<'step' | 'backup'>('step')
  const [code, setCode] = useState('')
  const [sharedDevice, setSharedDevice] = useState(sharedDeviceFromSignIn ?? false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [retryAfter, setRetryAfter] = useState(0)
  const [signedOut, setSignedOut] = useState(false)
  const [resendIn, setResendIn] = useState(0)
  const [sent, setSent] = useState(false)
  const attempted = useRef<string | null>(null)
  const autoSent = useRef(false)

  const hadSession = useRef(false)

  const account = useQuery({ queryKey: ['auth', 'get-session'], queryFn: getSession })

  useEffect(() => {
    if (account.data) hadSession.current = true
  }, [account.data])

  useEffect(() => {
    if (resendIn <= 0) return
    const timer = window.setInterval(() => setResendIn((left) => Math.max(0, left - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [resendIn])

  // With a session the server says which step is in use; on a sign-in challenge there is no
  // session yet, so the sign-in answer said it.
  const user = account.data?.user
  const method: SecondStepMethod = (user?.twoFactorEnabled ? user.twoFactorMethod : undefined) ?? methodFromSignIn ?? 'totp'
  const destination = destinationFor(method, user) ?? destinationFromSignIn
  const sendsCode = isCodeMethod(method)

  const send = async () => {
    setMessage(null)
    try {
      await twoFactorSendCode()
      setSent(true)
      setResendIn(60)
    } catch (error) {
      if (isApiError(error, 'RATE_LIMITED')) {
        const seconds = error.retryAfterSeconds ?? 60
        setSent(true)
        setResendIn(seconds)
        setMessage(`A code was sent a moment ago. ${describeWait(seconds)}`)
      } else if (isApiError(error, 'SESSION_EXPIRED')) {
        setSignedOut(true)
      } else {
        setMessage(describeError(error))
      }
    }
  }

  // A code step sends its code as soon as the person arrives: that is what they came here for.
  useEffect(() => {
    if (account.isPending || !sendsCode || autoSent.current) return
    autoSent.current = true
    void send()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.isPending, sendsCode])

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
      if (mode === 'backup') await twoFactorVerifyBackupCode({ code: entered, sharedDevice })
      else if (sendsCode) await twoFactorVerifyCode({ code: entered, sharedDevice })
      else await twoFactorVerifyTotp({ code: entered, sharedDevice })
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
        {mode === 'step' && sendsCode && sent && ` We sent a 6 digit code${destination ? ` to ${destination}` : ''}.`}
      </p>

      <CodeField
        mode={mode === 'backup' ? 'backup' : 'totp'}
        label={mode === 'step' && sendsCode ? (method === 'sms' ? 'Code from the text message' : 'Code from the email') : undefined}
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

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {mode === 'step' && sendsCode && (
          <button
            type="button"
            disabled={resendIn > 0}
            className="text-[12.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60"
            onClick={() => { void send() }}
          >
            {resendIn > 0 ? `Send a new code in ${resendIn}s` : sent ? 'Send a new code' : 'Send the code'}
          </button>
        )}
        <button
          type="button"
          className="text-[12.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            setMode((current) => (current === 'step' ? 'backup' : 'step'))
            setCode('')
            setMessage(null)
            attempted.current = null
          }}
        >
          {mode === 'step' ? 'Use a backup code instead' : sendsCode ? `Use a code by ${method === 'sms' ? 'text message' : 'email'} instead` : 'Use your authenticator app instead'}
        </button>
      </div>
    </form>
  )
}
