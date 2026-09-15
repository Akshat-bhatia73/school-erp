import { Eye, EyeOff } from 'lucide-react'
import { cloneElement, isValidElement, useState, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/** Comfortable on a phone (44px tap target), dense from `md` up. Also avoids the iOS zoom. */
export const TALL_INPUT = 'h-11 text-[16px] md:h-8 md:text-[13px]'
export const TALL_BUTTON = 'h-11 w-full md:h-9'

/** A failure the person can read, announced to a screen reader as soon as it appears. */
export function FormError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <Alert variant="destructive" role="alert" className="text-[13px]">
      <AlertDescription className="text-tag-red">{message}</AlertDescription>
    </Alert>
  )
}

export function AuthInput({ className, ...props }: ComponentProps<typeof Input>) {
  return <Input className={cn(TALL_INPUT, className)} {...props} />
}

/** Password with a show/hide toggle that is itself a 44px target on a phone. */
export function PasswordInput({ id, value, onChange, disabled, autoComplete, invalid, 'aria-describedby': describedBy }: {
  id: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  autoComplete: 'current-password' | 'new-password'
  invalid?: boolean
  'aria-describedby'?: string
}) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <AuthInput
        id={id}
        type={shown ? 'text' : 'password'}
        className="pr-12"
        value={value}
        autoComplete={autoComplete}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        aria-pressed={shown}
        aria-label={shown ? 'Hide password' : 'Show password'}
        onClick={() => setShown((current) => !current)}
        className="absolute inset-y-0 right-0 flex h-full w-11 items-center justify-center rounded-r-lg text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  )
}

/** Shorter session, nothing remembered. Offered on every sign-in form. */
export function SharedDeviceField({ id, checked, onChange, disabled }: {
  id: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox id={id} checked={checked} disabled={disabled} className="mt-0.5 size-5 md:size-4" onCheckedChange={(next) => onChange(next === true)} />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="text-[13px] font-normal">This is a shared device</Label>
        <p className="text-[12px] text-muted-foreground">We sign you out sooner and remember nothing on this device.</p>
      </div>
    </div>
  )
}

export function HelpLine() {
  return <p className="text-[12.5px] text-muted-foreground">Need help signing in? Contact your school office.</p>
}

/**
 * The label a submit button carries while a request is in flight or a throttle is running. A long
 * wait is stated in minutes: a fifteen-minute ticking counter helps nobody.
 */
export function submitLabel(idle: string, pending: string, pendingState: boolean, secondsLeft: number) {
  if (pendingState) return pending
  if (secondsLeft > 90) return `Try again in about ${Math.max(1, Math.round(secondsLeft / 60))} minutes`
  if (secondsLeft > 0) return `Try again in ${secondsLeft}s`
  return idle
}

/**
 * Like `components/setup/field`, but the label points at the control with `htmlFor`. Public auth
 * screens are often the first thing a screen reader meets, so the association must be explicit.
 */
export function AuthField({ id, label, error, hint, children }: {
  id: string
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  // The hint and the error are part of the control's own description, so a screen reader reads
  // "At least 8 characters" on focus rather than only the label.
  const control = describedBy && isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-describedby'?: string }>, { 'aria-describedby': describedBy })
    : children
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="text-[12.5px] text-muted-foreground">{label}</Label>
      {control}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[12px] text-tag-red">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
