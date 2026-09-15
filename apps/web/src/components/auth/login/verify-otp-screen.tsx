import { Link, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AuthLayout, SandboxNotice } from '@/components/auth/auth-layout'
import { describeCodeError, describeSignInError, throttleSeconds } from '@/components/auth/login/errors'
import { AuthField, AuthInput, FormError, HelpLine, SharedDeviceField, submitLabel, TALL_BUTTON } from '@/components/auth/login/parts'
import { RedirectOnce } from '@/components/auth/app-gate'
import { useCountdown } from '@/components/auth/login/use-countdown'
import { Button } from '@/components/ui/button'
import { sendPhoneOtp, verifyPhoneOtp } from '@/lib/auth-client'
import { sanitiseReturnTo } from '@/lib/return-to'
import { announceSignIn, useSession } from '@/lib/session'

const RESEND_SECONDS = 60

/** +919876543210 reads back as +91 98xxxxxx10: enough to recognise, not enough to copy down. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '').slice(-10)
  if (digits.length !== 10) return phone
  return `+91 ${digits.slice(0, 2)}xxxxxx${digits.slice(8)}`
}

export function VerifyOtpScreen({ phone, returnTo, sharedDevice: initialShared }: {
  phone?: string
  returnTo: string
  sharedDevice?: boolean
}) {
  if (!phone) return <RedirectOnce to="/login" search={{ audience: 'parent' }} />
  return <CodeForm phone={phone} returnTo={returnTo} initialShared={initialShared ?? false} />
}

function CodeForm({ phone, returnTo, initialShared }: { phone: string; returnTo: string; initialShared: boolean }) {
  const navigate = useNavigate()
  const session = useSession()
  const [code, setCode] = useState('')
  const [sharedDevice, setSharedDevice] = useState(initialShared)
  const [failure, setFailure] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [resending, setResending] = useState(false)
  const resend = useCountdown()
  const throttle = useCountdown()
  const inputRef = useRef<HTMLInputElement>(null)
  const submitted = useRef('')

  // The code was sent on the way in, so the resend cooldown starts with the screen.
  const startResend = resend.start
  useEffect(() => { startResend(RESEND_SECONDS) }, [startResend])

  async function submit(value: string) {
    if (pending || throttle.secondsLeft > 0) return
    submitted.current = value
    setFailure(null)
    setNote(null)
    setPending(true)
    try {
      await verifyPhoneOtp({ phoneNumber: phone, code: value, sharedDevice: sharedDevice || undefined })
      announceSignIn()
      await session.refresh()
      // `href` keeps any query string on the way back; `to` would be read as a pathname.
      void navigate({ href: sanitiseReturnTo(returnTo), replace: true } as never)
    } catch (error) {
      const wait = throttleSeconds(error)
      if (wait > 0) throttle.start(wait)
      setFailure(describeCodeError(error))
      setCode('')
      inputRef.current?.focus()
    } finally {
      setPending(false)
    }
  }

  function onChange(raw: string) {
    const next = raw.replace(/\D/g, '').slice(0, 6)
    setCode(next)
    // Typing the sixth digit is the person saying "done"; no extra tap needed.
    if (next.length === 6 && next !== submitted.current) void submit(next)
  }

  async function onResend() {
    if (resend.secondsLeft > 0 || pending || resending) return
    setFailure(null)
    setResending(true)
    try {
      await sendPhoneOtp(phone)
      submitted.current = ''
      setNote('We sent a new code.')
      resend.start(RESEND_SECONDS)
    } catch (error) {
      const wait = throttleSeconds(error)
      if (wait > 0) resend.start(wait)
      setFailure(describeSignInError(error))
    } finally {
      setResending(false)
    }
  }

  const blocked = pending || throttle.secondsLeft > 0
  return (
    <AuthLayout
      title="Enter your code"
      description={<>We sent a 6 digit code to <span className="font-mono text-foreground">{maskPhone(phone)}</span>. The code works for 5 minutes.</>}
      footer={<HelpLine />}
    >
      <form className="grid gap-4" onSubmit={(event: FormEvent) => { event.preventDefault(); void submit(code) }} noValidate>
        <SandboxNotice />
        <FormError message={failure} />
        {note && <p role="status" aria-live="polite" className="text-[12.5px] text-tag-green">{note}</p>}
        <AuthField id="otp-code" label="6 digit code">
          <AuthInput
            id="otp-code"
            ref={inputRef}
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="text-center font-mono text-[18px] tracking-[0.4em] md:text-[16px]"
            value={code}
            disabled={blocked}
            aria-invalid={failure ? true : undefined}
            onChange={(event) => onChange(event.target.value)}
          />
        </AuthField>
        <SharedDeviceField id="otp-shared" checked={sharedDevice} onChange={setSharedDevice} disabled={pending} />
        <Button type="submit" className={TALL_BUTTON} disabled={blocked || code.length !== 6}>
          {submitLabel('Sign in', 'Checking code…', pending, throttle.secondsLeft)}
        </Button>
        <div className="flex items-center justify-between gap-2 text-[12.5px]">
          <button type="button" className="underline underline-offset-2 disabled:no-underline disabled:opacity-60" disabled={resend.secondsLeft > 0 || pending || resending} onClick={() => { void onResend() }}>
            {resending ? 'Sending…' : resend.secondsLeft > 0 ? `Send a new code in ${resend.secondsLeft}s` : 'Send a new code'}
          </button>
          <Link to="/login" search={{ audience: 'parent' } as never} className="underline underline-offset-2">Change number</Link>
        </div>
      </form>
    </AuthLayout>
  )
}
