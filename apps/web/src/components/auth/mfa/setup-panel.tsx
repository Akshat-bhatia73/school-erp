import { Copy } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/setup/field'
import { BackupCodes, copyText } from '@/components/auth/mfa/backup-codes'
import { CodeField } from '@/components/auth/mfa/code-field'
import { QrCode } from '@/components/auth/mfa/qr'
import { reloadTo } from '@/components/auth/mfa/reload-to'
import { describeError, describeWait, isApiError } from '@/lib/api-errors'
import { twoFactorEnable, twoFactorVerifyTotp } from '@/lib/auth-client'

type Step = 'password' | 'scan' | 'confirm' | 'codes'

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
 * Adding an authenticator. Nothing is switched on until the server accepts a code from the app,
 * so the screen never claims success early.
 */
export function MfaSetupPanel({ returnTo }: { returnTo: string }) {
  const [step, setStep] = useState<Step>('password')
  const [password, setPassword] = useState('')
  const [uri, setUri] = useState('')
  const [codes, setCodes] = useState<string[]>([])
  const [code, setCode] = useState('')
  const [saved, setSaved] = useState(false)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const start = async () => {
    if (!password || pending) return
    setPending(true)
    setMessage(null)
    try {
      const result = await twoFactorEnable(password)
      setUri(result.totpURI)
      setCodes(result.backupCodes)
      setStep('scan')
    } catch (error) {
      setMessage(isApiError(error, 'INVALID_REQUEST') || isApiError(error, 'AUTHENTICATION_REQUIRED')
        ? 'That password did not match.'
        : describeError(error))
    } finally {
      setPending(false)
    }
  }

  const confirm = async (value: string) => {
    if (value.length !== 6 || pending) return
    setPending(true)
    setMessage(null)
    try {
      await twoFactorVerifyTotp({ code: value })
      setStep('codes')
    } catch (error) {
      if (isApiError(error, 'RATE_LIMITED')) setMessage(`Too many attempts. ${describeWait(error.retryAfterSeconds ?? 60)}`)
      else setMessage('That code did not work. Check the app and try the next code.')
      setCode('')
    } finally {
      setPending(false)
    }
  }

  // Turning the second step on changes what the server will let this person see, so leave with a
  // page load and let the session and school context be read again. See reload-to.ts.
  const finish = () => reloadTo(returnTo)

  if (step === 'password') {
    return (
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void start() }}>
        <p className="text-[13px] text-muted-foreground">Confirm your password to add an authenticator.</p>
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
        <Button type="submit" className="h-11 w-full md:h-9" disabled={pending || password.length === 0}>
          {pending ? 'Checking…' : 'Continue'}
        </Button>
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

  if (step === 'confirm') {
    return (
      <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void confirm(code) }}>
        <p className="text-[13px] text-muted-foreground">
          Enter the first code your app shows. Your second step is only switched on once this code is accepted.
        </p>
        <CodeField
          mode="totp"
          value={code}
          disabled={pending}
          onChange={(next) => { setCode(next); if (message) setMessage(null) }}
          onComplete={(next) => { void confirm(next) }}
          error={message ?? undefined}
        />
        <Button type="submit" className="h-11 w-full md:h-9" disabled={pending || code.length !== 6}>
          {pending ? 'Checking…' : 'Turn on second step'}
        </Button>
      </form>
    )
  }

  return (
    <div className="grid gap-4">
      <p className="text-[13px] text-muted-foreground">
        Your second step is on. Save these backup codes now — they are the way back in if you lose your phone.
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
