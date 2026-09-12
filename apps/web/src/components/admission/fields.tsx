import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

export type Errors = Record<string, string>

export function Field({ label, error, hint, required, children, className }: { label: string; error?: string; hint?: ReactNode; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <Label className="text-[12.5px] text-muted-foreground">
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
      {error ? <p className="text-[12px] text-destructive">{error}</p> : hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function TextField({ label, value, onChange, error, hint, required, type = 'text', placeholder, className, inputClassName }: {
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  hint?: ReactNode
  required?: boolean
  type?: string
  placeholder?: string
  className?: string
  inputClassName?: string
}) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      <Input type={type} value={value} placeholder={placeholder} aria-invalid={!!error} onChange={(e) => onChange(e.target.value)} className={cn('h-9', inputClassName)} />
    </Field>
  )
}

export interface Opt { value: string; label: string }

export function SelectField({ label, value, onChange, options, error, hint, required, placeholder = 'Select', className, disabled }: {
  label: string
  value: string | undefined
  onChange: (v: string) => void
  options: Opt[]
  error?: string
  hint?: ReactNode
  required?: boolean
  placeholder?: string
  className?: string
  disabled?: boolean
}) {
  return (
    <Field label={label} error={error} hint={hint} required={required} className={className}>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-invalid={!!error} className="h-9 w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
}
