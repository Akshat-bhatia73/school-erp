/**
 * The small pieces every fee form uses: a labelled field, a rupees box and today's date.
 *
 * A person types rupees; the request carries paise. The conversion happens once, here, so no form
 * multiplies by a hundred on its own.
 */
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/** A rejected `Input` or `Textarea` is marked invalid, which is what the focus helper looks for. */
export function Field({ label, error, hint, children, className }: {
  label: string
  error?: string
  hint?: string
  children: ReactNode
  className?: string
}) {
  const injectable = isValidElement(children) && (children.type === Input || children.type === Textarea)
  const control = injectable && error
    ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'aria-invalid': true })
    : children
  return (
    <div className={`grid gap-1.5 ${className ?? ''}`}>
      <Label className="text-[12.5px] text-muted-foreground">{label}</Label>
      {control}
      {error ? <p className="text-[12px] text-destructive">{error}</p> : hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** A rupees box. The value stays as the person typed it; the caller converts it when it saves. */
export function RupeeInput({ value, onChange, label, error, hint, className }: {
  value: string
  onChange: (value: string) => void
  label: string
  error?: string
  hint?: string
  className?: string
}) {
  return (
    <Field label={label} error={error} hint={hint} className={className}>
      <Input inputMode="decimal" placeholder="0" value={value} onChange={(event) => onChange(event.target.value)} />
    </Field>
  )
}

/** Today in the browser's own calendar, as the ISO date every date box and request uses. */
export function todayIso(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** The first day of the month that today falls in. */
export function monthStartIso(): string {
  return `${todayIso().slice(0, 7)}-01`
}

/** Rupees, as a box starts out: paise the server sent, written back the way a person reads them. */
export function paiseToRupeeText(paise: number): string {
  const whole = Math.trunc(Math.abs(paise))
  const rest = whole % 100
  const rupees = Math.floor(whole / 100)
  const sign = paise < 0 ? '-' : ''
  return rest === 0 ? `${sign}${rupees}` : `${sign}${rupees}.${String(rest).padStart(2, '0')}`
}
