import { Link } from '@tanstack/react-router'
import { MailCheck } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { AuthLayout, SandboxNotice } from '@/components/auth/auth-layout'
import { describeSignInError, throttleSeconds } from '@/components/auth/login/errors'
import { AuthField, AuthInput, FormError, submitLabel, TALL_BUTTON } from '@/components/auth/login/parts'
import { useCountdown } from '@/components/auth/login/use-countdown'
import { Button } from '@/components/ui/button'
import { requestPasswordReset } from '@/lib/auth-client'

/**
 * The answer is the same whether or not the address is known here: the server returns success for
 * an address it has never seen, so nobody can probe for accounts. Transport and throttle failures
 * are still shown, because pretending they were sent leaves the person waiting for nothing.
 */
export function ForgotPasswordScreen() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [fieldError, setFieldError] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const throttle = useCountdown()
  const inputRef = useRef<HTMLInputElement>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (pending || throttle.secondsLeft > 0) return
    const value = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setFieldError('Enter the email address your school has for you.')
      inputRef.current?.focus()
      return
    }
    setFieldError(undefined)
    setFailure(null)
    setPending(true)
    try {
      await requestPasswordReset(value)
      setSent(true)
    } catch (error) {
      // The server answers the same way for a known and an unknown address, so a rejection here
      // is a real failure (throttle, outage, bad connection). Saying "sent" would strand the person.
      const wait = throttleSeconds(error)
      if (wait > 0) throttle.start(wait)
      setFailure(describeSignInError(error))
    } finally {
      setPending(false)
    }
  }

  const backToSignIn = <Link to="/login" className="underline underline-offset-2">Back to sign in</Link>

  if (sent) {
    return (
      <AuthLayout title="Check your email" footer={backToSignIn}>
        <div className="grid justify-items-center gap-2 rounded-lg border px-4 py-8 text-center" role="status" aria-live="polite">
          <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground"><MailCheck className="size-4" /></div>
          <p className="text-[13.5px] font-medium">If that email has an account, we have sent a reset link.</p>
          <p className="text-[12.5px] text-muted-foreground">It works for 15 minutes. Check the spam folder if it does not arrive.</p>
        </div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout title="Reset your password" description="We will email you a link to set a new password." footer={backToSignIn}>
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        <SandboxNotice />
        <FormError message={failure} />
        <AuthField id="forgot-email" label="Email address" error={fieldError}>
          <AuthInput
            id="forgot-email"
            ref={inputRef}
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            disabled={pending}
            aria-invalid={fieldError ? true : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
        </AuthField>
        <Button type="submit" className={TALL_BUTTON} disabled={pending || throttle.secondsLeft > 0}>
          {submitLabel('Send reset link', 'Sending…', pending, throttle.secondsLeft)}
        </Button>
      </form>
    </AuthLayout>
  )
}
