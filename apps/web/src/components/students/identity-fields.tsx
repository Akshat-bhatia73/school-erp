/**
 * The boxes people type an Aadhaar number or a PAN into.
 *
 * A number that is already on file is never echoed back: the school sees the last digits and an
 * explicit "Replace" before a box appears at all. What is typed lives in the form's own state for
 * as long as the form is open and goes nowhere else — not into the query cache, not into storage.
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** `123456789012` shown as `1234 5678 9012` while it is being typed. */
export function groupAadhaar(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 12)
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim()
}

/** Whatever was typed, upper-cased, at most the ten characters a PAN has. */
export function cleanPan(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10)
}

export function IdentityField({ label, value, onChange, onFile, error, optional = true, kind }: {
  label: string
  value: string
  onChange: (v: string) => void
  /** The last digits the server sent, when the record already carries a number. */
  onFile?: string
  error?: string
  optional?: boolean
  kind: 'aadhaar' | 'pan'
}) {
  const [replacing, setReplacing] = useState(false)
  const showBox = replacing || !onFile

  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-[12.5px] text-muted-foreground">{label}</Label>
      {showBox ? (
        <Input
          value={value}
          inputMode={kind === 'aadhaar' ? 'numeric' : 'text'}
          placeholder={kind === 'aadhaar' ? '1234 5678 9012' : 'AAAAA9999A'}
          aria-label={label}
          aria-invalid={!!error}
          onChange={(event) => onChange(kind === 'aadhaar' ? groupAadhaar(event.target.value) : cleanPan(event.target.value))}
        />
      ) : (
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px]">ending {onFile}</span>
          <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(true)}>Replace</Button>
        </div>
      )}
      {error
        ? <p className="text-[12px] text-destructive">{error}</p>
        : showBox && optional ? <p className="text-[12px] text-muted-foreground">Optional</p> : null}
    </div>
  )
}
