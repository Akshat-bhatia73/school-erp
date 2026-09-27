import { useQuery } from '@tanstack/react-query'
import { Copy, KeyRound, Mail, MessageSquare } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SecondStepMethod } from '@erp/contracts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Field } from '@/components/setup/field'
import { BackupCodes, copyText } from '@/components/auth/mfa/backup-codes'
import { CodeField } from '@/components/auth/mfa/code-field'
import { METHOD_HINT, METHOD_LABEL, destinationFor, isCodeMethod } from '@/components/auth/mfa/methods'
import { QrCode } from '@/components/auth/mfa/qr'
import { reloadTo } from '@/components/auth/mfa/reload-to'
import { describeError, describeWait, isApiError } from '@/lib/api-errors'
import { getSession, startSecondStep, twoFactorSendCode, twoFactorVerifyCode, twoFactorVerifyTotp } from '@/lib/auth-client'
import { cn } from '@/lib/utils'

type Step = 'choose' | 'password' | 'scan' | 'confirm' | 'code' | 'codes'

const METHOD_ICON = { totp: KeyRound, sms: MessageSquare, email: Mail } as const
const METHODS: SecondStepMethod[] = ['totp', 'sms', 'email']
const IN_USE: Record<SecondStepMethod, string> = { totp: 'an authenticator app', sms: 'a code by text message', email: 'a code by email' }

/** The secret inside an `otpauth://` URI, in groups of four so it can be read out loud. */
export function secretFromUri(uri: string): string {
  try {
    const secret = new URL(uri).searchParams.get('secret') ?? ''
    return secret.replace(/(.{4})/g, '$1 ').trim()
  } catch {
    return ''
  }
}

/**
 * Choosing a second step: an authenticator app, a code by text message or a code by email. Nothing
 * is switched on (or switched over) until the server accepts a code from the new step, so the
 * screen never claims success early and an unfinished switch leaves the old step working.
 */
export function MfaSetupPanel({ returnTo }: { returnTo: string }) {
  const account = useQuery({ queryKey: ['auth', 'get-session'], queryFn: getSession })
  const [step, setStep] = useState<Step>('choose')
  const [method, setMethod] = useState<SecondStepMethod>('totp')
  const [password, setPassword] = useState('')
  const [uri, setUri] = useState('')
  const [destination, setDestination] = useState<string | undefined>()
  const [codes, setCodes] = useState<string[]>([])
  const [code, setCode] = useState('')
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [needsFresh, setNeedsFresh] = useState(false)
  const [resendIn, setResendIn] = useState(0)

  useEffect(() => {
    if (resendIn <= 0) return
    const timer = window.setInterval(() => setResendIn((left) => Math.max(0, left - 1)), 1000)
    return () => window.clearInterval(timer)
  }, [resendIn])

  if (account.isPending) return <Skeleton className="h-40 w-full rounded-lg" />

  const user = account.data?.user
  const current = user?.twoFactorEnabled ? user.twoFactorMethod ?? 'totp' : null
  // A code needs somewhere to go; a step already in use is not offered again.
  const offered = METHODS.filter((option) => option !== current && (option === 'totp' || destinationFor(option, user) !== undefined))
  const chosen = offered.includes(method) ? method : offered[0]

  const send = async () => {
    try {
      await twoFactorSendCode()
      setResendIn(60)
    } catch (error) {
      if (isApiError(error, 'RATE_LIMITED')) {
        const seconds = error.retryAfterSeconds ?? 60
        setResendIn(seconds)
        setMessage(`A code was sent a moment ago. ${describeWait(seconds)}`)
      } else {
        setMessage(describeError(error))
      }
    }
  }

  const start = async () => {
    if (!password || pending) return
    setPending(true)
    setMessage(null)
    setNeedsFresh(false)
    try {
      const result = await startSecondStep({ method, password })
      setCodes(result.backupCodes ?? [])
      setDestination(result.destination)
      setPassword('')
      if (method === 'totp') {
        setUri(result.totpURI ?? '')
        setStep('scan')
      } else {
        setStep('code')
        await send()
      }
    } catch (error) {
      if (isApiError(error, 'FRESH_AUTHENTICATION_REQUIRED')) {
        setNeedsFresh(true)
        setMessage('Confirm your current second step first, then come back to switch.')
      } else {
        setMessage(describeError(error))
      }
    } finally {
      setPending(false)
    }
  }

  const confirm = async (value: string) => {
    if (value.length !== 6 || pending) return
    setPending(true)
    setMessage(null)
    try {
      if (method === 'totp') await twoFactorVerifyTotp({ code: value })
      else await twoFactorVerifyCode({ code: value })
      if (codes.length > 0) setStep('codes')
      else finish()
    } catch (error) {
      if (isApiError(error, 'RATE_LIMITED')) setMessage(`Too many attempts. ${describeWait(error.retryAfterSeconds ?? 60)}`)
      else setMessage(method === 'totp' ? 'That code did not work. Check the app and try the next code.' : 'That code did not work. Check it, or send a new one.')
      setCode('')
    } finally {
      setPending(false)
    }
  }

  // Turning the second step on changes what the server will let this person see, so leave with a
  // page load and let the session and school context be read again. See reload-to.ts.
  function finish() { reloadTo(returnTo) }

  if (step === 'choose') {
    return (
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!chosen) return; setMethod(chosen); setMessage(null); setStep('password') }}>
        <p className="text-[13px] text-muted-foreground">
          {current ? `You use ${IN_USE[current]} now. Choose the step you want instead.` : 'Choose how you want to confirm it is you after your password.'}
        </p>
        <RadioGroup value={chosen} onValueChange={(value) => setMethod(value as SecondStepMethod)} aria-label="Second step" className="gap-2">
          {offered.map((option) => {
            const Icon = METHOD_ICON[option]
            const where = destinationFor(option, user)
            return (
              <label
                key={option}
                htmlFor={`method-${option}`}
                className={cn('flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-accent/50', chosen === option && 'border-primary/50 bg-accent/40')}
              >
                <RadioGroupItem id={`method-${option}`} value={option} className="mt-0.5" />
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="grid gap-0.5">
                  <span className="text-[13.5px] font-medium">{METHOD_LABEL[option]}</span>
                  <span className="text-[12.5px] text-muted-foreground">{METHOD_HINT[option]}{where ? ` It goes to ${where}.` : ''}</span>
                </span>
              </label>
            )
          })}
        </RadioGroup>
        <Button type="submit" className="h-11 w-full md:h-9" disabled={!chosen}>Continue</Button>
      </form>
    )
  }

  if (step === 'password') {
    return (
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void start() }}>
        <p className="text-[13px] text-muted-foreground">Confirm your password to use {IN_USE[method]} as your second step.</p>
        <Field label="Your password">
          <Input
            id="mfa-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            aria-label="Your password"
            value={password}
            disabled={pending}
            onChange={(event) => setPassword(event.target.value)}
            className="h-11 text-[16px] md:h-9 md:text-[13px]"
          />
          {message && <p role="alert" className="text-[12px] text-tag-red">{message}</p>}
        </Field>
        {needsFresh && (
          <a href={`/mfa/verify?returnTo=${encodeURIComponent(returnTo)}`} className="text-[12.5px] underline underline-offset-2">Confirm your current second step</a>
        )}
        <div className="grid gap-2">
          <Button type="submit" className="h-11 w-full md:h-9" disabled={pending || password.length === 0}>
            {pending ? 'Checking…' : 'Continue'}
          </Button>
          <Button type="button" variant="ghost" className="h-11 w-full md:h-9" disabled={pending} onClick={() => { setMessage(null); setNeedsFresh(false); setStep('choose') }}>Back</Button>
        </div>
      </form>
    )
  }

  if (step === 'scan') {
    const secret = secretFromUri(uri)
    return (
      <div className="grid gap-4">
        <p className="text-[13px] text-muted-foreground">
          Scan this with your authenticator app, or enter the secret by hand.
        </p>
        <div className="flex justify-center rounded-lg border bg-card p-3">
          <QrCode value={uri} label="Authenticator setup code" className="size-48 md:size-44" />
        </div>
        <div className="grid gap-1.5 rounded-lg border bg-muted/40 p-3">
          <p className="text-[12.5px] text-muted-foreground">Enter the secret manually</p>
          <p className="font-mono text-[13px] break-all">{secret}</p>
          <div>
            <Button type="button" variant="outline" size="sm" className="h-11 md:h-7" onClick={() => { void copyText(secret.replace(/\s/g, ''), 'Secret') }}>
              <Copy /> Copy secret
            </Button>
          </div>
        </div>
        <Button type="button" className="h-11 w-full md:h-9" onClick={() => setStep('confirm')}>I have added it</Button>
      </div>
    )
  }

  if (step === 'confirm' || step === 'code') {
    const isCode = isCodeMethod(method)
    return (
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void confirm(code) }}>
        <p className="text-[13px] text-muted-foreground">
          {isCode
            ? `We sent a 6 digit code${destination ? ` to ${destination}` : ''}. It works for 5 minutes. Your second step only changes once this code is accepted.`
            : 'Enter the first code your app shows. Your second step is only switched on once this code is accepted.'}
        </p>
        <CodeField
          mode="totp"
          label={isCode ? (method === 'sms' ? 'Code from the text message' : 'Code from the email') : undefined}
          value={code}
          disabled={pending}
          onChange={(next) => { setCode(next); if (message) setMessage(null) }}
          onComplete={(next) => { void confirm(next) }}
          error={message ?? undefined}
        />
        <Button type="submit" className="h-11 w-full md:h-9" disabled={pending || code.length !== 6}>
          {pending ? 'Checking…' : current ? 'Switch second step' : 'Turn on second step'}
        </Button>
        {isCode && (
          <button
            type="button"
            disabled={resendIn > 0}
            className="justify-self-start text-[12.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60"
            onClick={() => { setMessage(null); void send() }}
          >
            {resendIn > 0 ? `Send a new code in ${resendIn}s` : 'Send a new code'}
          </button>
        )}
      </form>
    )
  }

  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted-foreground">
        Your second step is on. Save these backup codes now — they are the way back in if you lose your phone or cannot get a code.
      </p>
      <BackupCodes codes={codes} />
      <label className="flex items-center gap-2 text-[13px]">
        <Checkbox checked={saved} aria-label="I have saved these codes" onCheckedChange={(state) => setSaved(state === true)} />
        I have saved these codes
      </label>
      <Button type="button" className="h-11 w-full md:h-9" disabled={!saved} onClick={finish}>Continue</Button>
    </div>
  )
}
