import { useEffect, useRef } from 'react'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/setup/field'

/**
 * The one-time code box. Six digits for an authenticator code, free text for a backup code. It
 * calls `onComplete` as soon as six digits are in, so nobody has to hunt for the button.
 */
export function CodeField({ mode, value, onChange, onComplete, error, disabled, label }: {
  mode: 'totp' | 'backup'
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  error?: string
  disabled?: boolean
  label?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => { ref.current?.focus() }, [mode])

  const isTotp = mode === 'totp'
  return (
    <Field label={label ?? (isTotp ? 'Code from your authenticator app' : 'Backup code')}>
      <Input
        ref={ref}
        id="mfa-code"
        name="code"
        value={value}
        disabled={disabled}
        autoComplete={isTotp ? 'one-time-code' : 'off'}
        inputMode={isTotp ? 'numeric' : 'text'}
        pattern={isTotp ? '[0-9]*' : undefined}
        maxLength={isTotp ? 6 : 24}
        aria-invalid={error ? true : undefined}
        aria-label={label ?? (isTotp ? 'Code from your authenticator app' : 'Backup code')}
        placeholder={isTotp ? '123456' : 'xxxxx-xxxxx'}
        className="h-11 text-[16px] tracking-[0.3em] md:h-9 md:text-[13px] font-mono"
        onChange={(event) => {
          const next = isTotp ? event.target.value.replace(/\D/g, '').slice(0, 6) : event.target.value.trim()
          onChange(next)
          if (isTotp && next.length === 6) onComplete?.(next)
        }}
      />
      {error && <p role="alert" className="text-[12px] text-tag-red">{error}</p>}
    </Field>
  )
}
