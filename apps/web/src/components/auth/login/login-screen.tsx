import { Link, useNavigate } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { z } from 'zod'
import { AuthLayout, SandboxNotice } from '@/components/auth/auth-layout'
import { describeSignInError, throttleSeconds } from '@/components/auth/login/errors'
import { AuthField, AuthInput, FormError, HelpLine, PasswordInput, SharedDeviceField, submitLabel, TALL_BUTTON } from '@/components/auth/login/parts'
import { useCountdown } from '@/components/auth/login/use-countdown'
import { validate, type FieldErrors } from '@/components/setup/field'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { needsSecondFactor, normaliseIndianPhone, sendPhoneOtp, signInWithEmail } from '@/lib/auth-client'
import { sanitiseReturnTo } from '@/lib/return-to'
import { announceSignIn, useSession } from '@/lib/session'

export type Audience = 'administration' | 'teacher' | 'parent' | 'student'

const TABS: { value: Audience; label: string }[] = [
  { value: 'administration', label: 'School office' },
  { value: 'teacher', label: 'Teacher' },
  { value: 'parent', label: 'Parent' },
  { value: 'student', label: 'Student' },
]

const EmailSchema = z.object({
  email: z.email('Enter the email address your school has for you.'),
  password: z.string().min(1, 'Enter your password.'),
})

/**
 * One page, four named ways in. The tab changes only the instructions and the form; it never
 * changes what anyone is allowed to do once they are signed in — the server decides that.
 */
export function LoginScreen({ returnTo, audience }: { returnTo: string; audience?: Audience }) {
  const [tab, setTab] = useState<Audience>(audience ?? 'administration')
  return (
    <AuthLayout
      title="Sign in"
      description="Use the email address or phone number your school has for you."
      footer={<HelpLine />}
    >
      <Tabs value={tab} onValueChange={(value) => setTab(value as Audience)}>
        <TabsList className="grid w-full grid-cols-4 group-data-[orientation=horizontal]/tabs:h-12 md:group-data-[orientation=horizontal]/tabs:h-9">
          {TABS.map((item) => (
            <TabsTrigger key={item.value} value={item.value} className="h-full px-1 text-[12px] md:text-[12.5px]">{item.label}</TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="administration" className="mt-4">
          <EmailPanel
            returnTo={returnTo}
            help="Owners, principals, administrators and accountants sign in with email. A second step with your authenticator app follows."
          />
        </TabsContent>
        <TabsContent value="teacher" className="mt-4">
          <TeacherPanel returnTo={returnTo} />
        </TabsContent>
        <TabsContent value="parent" className="mt-4">
          <PhonePanel returnTo={returnTo} help="Parents sign in with the mobile number the school has on record. We send a 6 digit code to it." />
        </TabsContent>
        <TabsContent value="student" className="mt-4">
          <StudentPanel />
        </TabsContent>
      </Tabs>
    </AuthLayout>
  )
}

/** Teachers may use either method, so this panel simply swaps between the two forms. */
function TeacherPanel({ returnTo }: { returnTo: string }) {
  const [method, setMethod] = useState<'email' | 'phone'>('email')
  if (method === 'phone') {
    return (
      <PhonePanel
        returnTo={returnTo}
        help="We send a 6 digit code to the mobile number your school has on record."
        switchLink={<button type="button" className="text-[12.5px] underline underline-offset-2" onClick={() => setMethod('email')}>Sign in with email instead</button>}
      />
    )
  }
  return (
    <EmailPanel
      returnTo={returnTo}
      help="Teachers sign in with the email address the school has on record."
      switchLink={<button type="button" className="text-[12.5px] underline underline-offset-2" onClick={() => setMethod('phone')}>Sign in with a phone code instead</button>}
    />
  )
}

function EmailPanel({ returnTo, help, switchLink }: { returnTo: string; help: string; switchLink?: ReactNode }) {
  const navigate = useNavigate()
  const session = useSession()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [sharedDevice, setSharedDevice] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const throttle = useCountdown()
  const emailRef = useRef<HTMLInputElement>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (pending || throttle.secondsLeft > 0) return
    const checked = validate(EmailSchema, { email: email.trim(), password })
    setErrors(checked.ok ? {} : checked.errors)
    if (!checked.ok) {
      emailRef.current?.focus()
      return
    }
    setFailure(null)
    setPending(true)
    try {
      const result = await signInWithEmail({ ...checked.data, sharedDevice })
      if (needsSecondFactor(result)) {
        void navigate({ to: '/mfa/verify', search: { returnTo, sharedDevice: sharedDevice || undefined }, replace: true } as never)
        return
      }
      announceSignIn()
      await session.refresh()
      // `href` is parsed into pathname/search/hash by the router; `to` is treated as a pathname
      // only, so a returnTo that carries a query string would match no route.
      void navigate({ href: sanitiseReturnTo(returnTo), replace: true } as never)
    } catch (error) {
      const wait = throttleSeconds(error)
      if (wait > 0) throttle.start(wait)
      setFailure(describeSignInError(error))
    } finally {
      setPending(false)
    }
  }

  const blocked = pending || throttle.secondsLeft > 0
  return (
    <form className="grid gap-4" onSubmit={onSubmit} noValidate>
      <p className="text-[12.5px] text-muted-foreground">{help}</p>
      <SandboxNotice />
      <FormError message={failure} />
      <AuthField id="login-email" label="Email address" error={errors.email}>
        <AuthInput
          id="login-email"
          ref={emailRef}
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          disabled={pending}
          aria-invalid={errors.email ? true : undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
      </AuthField>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="login-password" className="text-[12.5px] text-muted-foreground">Password</Label>
          <Link to="/forgot-password" className="text-[12.5px] underline underline-offset-2">Forgot password?</Link>
        </div>
        <PasswordInput id="login-password" value={password} onChange={setPassword} disabled={pending} autoComplete="current-password" invalid={Boolean(errors.password)} />
        {errors.password && <p id="login-password-error" role="alert" className="text-[12px] text-tag-red">{errors.password}</p>}
      </div>
      <SharedDeviceField id="login-shared" checked={sharedDevice} onChange={setSharedDevice} disabled={pending} />
      <Button type="submit" className={TALL_BUTTON} disabled={blocked}>{submitLabel('Sign in', 'Signing in…', pending, throttle.secondsLeft)}</Button>
      {switchLink && <div className="text-center">{switchLink}</div>}
    </form>
  )
}

function PhonePanel({ returnTo, help, switchLink }: { returnTo: string; help: string; switchLink?: ReactNode }) {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [sharedDevice, setSharedDevice] = useState(false)
  const [fieldError, setFieldError] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const throttle = useCountdown()
  const phoneRef = useRef<HTMLInputElement>(null)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (pending || throttle.secondsLeft > 0) return
    const normalised = normaliseIndianPhone(phone)
    if (!normalised) {
      setFieldError('Enter a 10 digit Indian mobile number.')
      phoneRef.current?.focus()
      return
    }
    setFieldError(undefined)
    setFailure(null)
    setPending(true)
    try {
      await sendPhoneOtp(normalised)
      void navigate({ to: '/verify-otp', search: { phone: normalised, returnTo, sharedDevice: sharedDevice || undefined } } as never)
    } catch (error) {
      const wait = throttleSeconds(error)
      if (wait > 0) throttle.start(wait)
      setFailure(describeSignInError(error))
    } finally {
      setPending(false)
    }
  }

  const blocked = pending || throttle.secondsLeft > 0
  return (
    <form className="grid gap-4" onSubmit={onSubmit} noValidate>
      <p className="text-[12.5px] text-muted-foreground">{help}</p>
      <SandboxNotice />
      <FormError message={failure} />
      <AuthField id="login-phone" label="Mobile number" error={fieldError}>
        <div className="flex items-stretch gap-2">
          <span className="flex h-11 items-center rounded-lg border bg-muted px-2.5 font-mono text-[13px] text-muted-foreground md:h-8">+91</span>
          <AuthInput
            id="login-phone"
            ref={phoneRef}
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={10}
            className="font-mono tracking-[0.12em]"
            value={phone}
            disabled={pending}
            aria-invalid={fieldError ? true : undefined}
            onChange={(event) => setPhone(event.target.value.replace(/\D/g, '').slice(0, 10))}
          />
        </div>
      </AuthField>
      <SharedDeviceField id="phone-shared" checked={sharedDevice} onChange={setSharedDevice} disabled={pending} />
      <Button type="submit" className={TALL_BUTTON} disabled={blocked}>{submitLabel('Send code', 'Sending code…', pending, throttle.secondsLeft)}</Button>
      {switchLink && <div className="text-center">{switchLink}</div>}
    </form>
  )
}

/** Specified, and deliberately off. Nothing here ever sends a request. */
function StudentPanel() {
  return (
    <div className="grid justify-items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
      <div className="flex size-9 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground"><Lock className="size-4" /></div>
      <p className="text-[13.5px] font-medium">Student sign-in is not open yet</p>
      <p className="max-w-xs text-[12.5px] text-muted-foreground">
        Students cannot sign in to this release. Ask your school office, or sign in as a parent with the family mobile number.
      </p>
    </div>
  )
}
