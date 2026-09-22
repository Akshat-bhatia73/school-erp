import { ManWomanIcon, OfficeIcon, StudentsIcon, TeachingIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { needsSecondFactor, normaliseIndianPhone, sendPhoneOtp, signInWithEmail } from '@/lib/auth-client'
import { rememberLoginSeed, type LoginSeed } from '@/lib/dashboard-view'
import { sanitiseReturnTo } from '@/lib/return-to'
import { announceSignIn, useSession } from '@/lib/session'

export type Audience = 'administration' | 'teacher' | 'parent' | 'student'

const TABS: { value: Audience; label: string; icon: IconSvgElement }[] = [
  { value: 'administration', label: 'School office', icon: OfficeIcon },
  { value: 'teacher', label: 'Teacher', icon: TeachingIcon },
  { value: 'parent', label: 'Parent', icon: ManWomanIcon },
  { value: 'student', label: 'Student', icon: StudentsIcon },
]

/**
 * The active tab grows to show its name in the brand colour (the same fill as the submit button);
 * the others collapse to an icon. Only `flex-grow` animates, so the basis stays put and the pills
 * slide rather than jump.
 */
const TAB_TRIGGER = 'h-full min-w-0 gap-1.5 overflow-hidden px-0 flex-[0_1_2.75rem] transition-[flex-grow,background-color,color] duration-300 ease-out data-[state=active]:flex-[1_1_2.75rem] data-[state=active]:bg-brand data-[state=active]:text-white data-[state=active]:shadow-none hover:text-foreground dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-brand dark:data-[state=active]:text-white'
const TAB_LABEL = 'max-w-0 overflow-hidden whitespace-nowrap text-[12.5px] font-medium opacity-0 transition-[max-width,opacity] duration-300 ease-out group-data-[state=active]/tab:max-w-32 group-data-[state=active]/tab:opacity-100'

/** A quiet secondary action under the submit button. */
const SECONDARY_LINK = 'text-[12.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'

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
    <AuthLayout title="Sign in" description="Use the email address or phone number your school has for you." footer={<HelpLine />}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as Audience)}>
        <TabsList className="flex w-full gap-1 p-1 group-data-[orientation=horizontal]/tabs:h-11 md:group-data-[orientation=horizontal]/tabs:h-9">
          {TABS.map((item) => (
            <TabsTrigger key={item.value} value={item.value} aria-label={item.label} title={item.label} className={`group/tab ${TAB_TRIGGER}`}>
              <HugeiconsIcon icon={item.icon} className="size-[18px] shrink-0" strokeWidth={1.5} aria-hidden />
              <span className={TAB_LABEL}>{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="administration" className="mt-4">
          <EmailPanel
            returnTo={returnTo}
            seed="staff"
            hint="For owners, principals, administrators and accountants. A second step with your authenticator app follows."
          />
        </TabsContent>
        <TabsContent value="teacher" className="mt-4">
          <TeacherPanel returnTo={returnTo} />
        </TabsContent>
        <TabsContent value="parent" className="mt-4">
          <PhonePanel returnTo={returnTo} seed="parent" hint="We send a 6 digit code to the mobile number your school has on record." />
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
        seed="staff"
        hint="We send a 6 digit code to the mobile number your school has on record."
        switchLink={<button type="button" className={SECONDARY_LINK} onClick={() => setMethod('email')}>Use email instead</button>}
      />
    )
  }
  return (
    <EmailPanel
      returnTo={returnTo}
      seed="staff"
      hint="Use the email address your school has on record for you."
      switchLink={<button type="button" className={SECONDARY_LINK} onClick={() => setMethod('phone')}>Use a phone code instead</button>}
    />
  )
}

/**
 * `seed` is what the tab says about the person: it is remembered once the sign-in is accepted, so
 * the app can land them on the parent home or their highest staff view. It never changes rights.
 */
function EmailPanel({ returnTo, seed, hint, switchLink }: { returnTo: string; seed: LoginSeed; hint: string; switchLink?: ReactNode }) {
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
      // The password was accepted; the second step, if any, does not know which tab this was.
      rememberLoginSeed(seed)
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
      <Hint text={hint} />
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
      <AuthField id="login-password" label="Password" error={errors.password}>
        <PasswordInput id="login-password" value={password} onChange={setPassword} disabled={pending} autoComplete="current-password" invalid={Boolean(errors.password)} />
      </AuthField>
      <SharedDeviceField id="login-shared" checked={sharedDevice} onChange={setSharedDevice} disabled={pending} />
      <Button type="submit" className={TALL_BUTTON} disabled={blocked}>{submitLabel('Sign in', 'Signing in…', pending, throttle.secondsLeft)}</Button>
      <div className="flex items-center justify-center gap-3 text-center">
        <Link to="/forgot-password" className={SECONDARY_LINK}>Forgot password?</Link>
        {switchLink && <span aria-hidden className="text-muted-foreground/60">·</span>}
        {switchLink}
      </div>
    </form>
  )
}

function PhonePanel({ returnTo, seed, hint, switchLink }: { returnTo: string; seed: LoginSeed; hint: string; switchLink?: ReactNode }) {
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
      // The code screen does not know which tab sent the person there, so the tab is noted here.
      rememberLoginSeed(seed)
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
      <Hint text={hint} />
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

/** One plain sentence under the tabs; the development notice, when there is one, sits with it. */
function Hint({ text }: { text: string }) {
  return (
    <div className="grid gap-1">
      <p className="text-[12.5px] text-muted-foreground">{text}</p>
      <SandboxNotice />
    </div>
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
