import { Link, useNavigate } from '@tanstack/react-router'
import { CheckCircle2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { z } from 'zod'
import { AuthLayout } from '@/components/auth/auth-layout'
import { throttleSeconds } from '@/components/auth/login/errors'
import { AuthField, FormError, PasswordInput, submitLabel, TALL_BUTTON } from '@/components/auth/login/parts'
import { useCountdown } from '@/components/auth/login/use-countdown'
import { validate, type FieldErrors } from '@/components/setup/field'
import { Button } from '@/components/ui/button'
import { describeError, isApiError } from '@/lib/api-errors'
import { resetPassword } from '@/lib/auth-client'

const Schema = z.object({
  newPassword: z.string().min(8, 'Use at least 8 characters.').max(128, 'Use 128 characters or fewer.'),
  confirm: z.string(),
}).refine((value) => value.newPassword === value.confirm, {
  message: 'Both passwords must match.',
  path: ['confirm'],
})

export function ResetPasswordScreen({ token }: { token?: string }) {
  const navigate = useNavigate()
  // Held in a constant so the submit handler keeps the narrowing done by the guard below.
  const resetToken = token
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [expired, setExpired] = useState(false)
  const [done, setDone] = useState(false)
  const [pending, setPending] = useState(false)
  const throttle = useCountdown()

  const requestNew = <Link to="/forgot-password" className="underline underline-offset-2">Request a new reset link</Link>

  if (!token) {
    return (
      <AuthLayout title="Set a new password" footer={requestNew}>
        <p className="text-[13px] text-tag-red" role="alert">This reset link is missing or incomplete.</p>
        <p className="mt-2 text-[12.5px] text-muted-foreground">Open the link from your email again, or ask for a new one.</p>
      </AuthLayout>
    )
  }

  if (expired) {
    return (
      <AuthLayout title="This link no longer works" footer={requestNew}>
        <p className="text-[13px] text-tag-red" role="alert">This reset link has expired or was already used.</p>
        <p className="mt-2 text-[12.5px] text-muted-foreground">Reset links work for 15 minutes and can be used once. Ask for a new one and open it from your email.</p>
      </AuthLayout>
    )
  }

  if (done) {
    return (
      <AuthLayout title="Password changed">
        <div className="grid justify-items-center gap-2 rounded-lg border px-4 py-8 text-center" role="status" aria-live="polite">
          <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/50 text-tag-green"><CheckCircle2 className="size-4" /></div>
          <p className="text-[13.5px] font-medium">Your password has been changed.</p>
          <p className="text-[12.5px] text-muted-foreground">Every other device has been signed out.</p>
        </div>
        <Button className={`mt-4 ${TALL_BUTTON}`} onClick={() => { void navigate({ to: '/login', replace: true } as never) }}>Sign in</Button>
      </AuthLayout>
    )
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (pending || throttle.secondsLeft > 0) return
    const checked = validate(Schema, { newPassword, confirm })
    setErrors(checked.ok ? {} : checked.errors)
    if (!checked.ok) return
    setFailure(null)
    setPending(true)
    try {
      await resetPassword({ token: resetToken!, newPassword: checked.data.newPassword })
      setDone(true)
    } catch (error) {
      // The provider answers an expired, unknown or already-used token with INVALID_REQUEST, and
      // the 8-128 character rule is already enforced above, so a refusal here means the link.
      if (isApiError(error, 'INVALID_REQUEST') || isApiError(error, 'RESOURCE_NOT_FOUND')) {
        setExpired(true)
        return
      }
      const wait = throttleSeconds(error)
      if (wait > 0) throttle.start(wait)
      setFailure(describeError(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthLayout title="Set a new password" description="Choose a password you have not used here before." footer={requestNew}>
      <form className="grid gap-4" onSubmit={onSubmit} noValidate>
        <FormError message={failure} />
        <AuthField id="reset-new" label="New password" error={errors.newPassword} hint="At least 8 characters.">
          <PasswordInput id="reset-new" value={newPassword} onChange={setNewPassword} disabled={pending} autoComplete="new-password" invalid={Boolean(errors.newPassword)} />
        </AuthField>
        <AuthField id="reset-confirm" label="Confirm new password" error={errors.confirm}>
          <PasswordInput id="reset-confirm" value={confirm} onChange={setConfirm} disabled={pending} autoComplete="new-password" invalid={Boolean(errors.confirm)} />
        </AuthField>
        <Button type="submit" className={TALL_BUTTON} disabled={pending || throttle.secondsLeft > 0}>
          {submitLabel('Reset password', 'Saving…', pending, throttle.secondsLeft)}
        </Button>
      </form>
    </AuthLayout>
  )
}
