import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export type Errors = Record<string, string>

/**
 * Associates the label, hint and error with the control, so a screen reader announces what a
 * box is for and why it was rejected. Three ways to get the wiring, in order of preference:
 *  - pass a function child and spread the `ids` yourself (works for any control)
 *  - pass a plain `Input`/`Textarea` and the ids are injected for you
 *  - anything else (a `Select` block, a radio group) is wrapped in a labelled group
 */
export function Field({ label, error, hint, required, children, className }: {
  label: string
  error?: string
  hint?: ReactNode
  required?: boolean
  children: ReactNode | ((ids: FieldIds) => ReactNode)
  className?: string
}) {
  const base = useId()
  const labelId = `${base}-label`
  const ids: FieldIds = {
    id: `${base}-control`,
    describedBy: error ? `${base}-error` : hint ? `${base}-hint` : undefined,
    invalid: !!error,
    required: !!required,
  }

  const injectable = isValidElement(children) && (children.type === Input || children.type === Textarea)
  let control: ReactNode
  if (typeof children === 'function') {
    control = children(ids)
  } else if (injectable) {
    const el = children as ReactElement<Record<string, unknown>>
    control = cloneElement(el, {
      id: el.props.id ?? ids.id,
      'aria-invalid': el.props['aria-invalid'] ?? ids.invalid,
      'aria-describedby': el.props['aria-describedby'] ?? ids.describedBy,
      'aria-required': ids.required || undefined,
    })
  } else {
    // Composite control we cannot reach into: name the wrapper instead of pointing a
    // dangling htmlFor at an element that does not exist.
    control = <div role="group" aria-labelledby={labelId} aria-describedby={ids.describedBy}>{children}</div>
  }
  const labelled = typeof children === 'function' || injectable

  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <Label id={labelId} htmlFor={labelled ? ids.id : undefined} className="text-[12.5px] text-muted-foreground">
        {label}
        {required && <span className="text-destructive" aria-hidden="true">*</span>}
      </Label>
      {control}
      {error ? <p id={`${base}-error`} className="text-[12px] text-destructive">{error}</p> : hint ? <p id={`${base}-hint`} className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export interface FieldIds {
  id: string
  describedBy?: string
  invalid: boolean
  required: boolean
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
      {(ids) => (
        <Input
          id={ids.id}
          type={type}
          value={value}
          placeholder={placeholder}
          aria-invalid={ids.invalid}
          aria-describedby={ids.describedBy}
          aria-required={ids.required || undefined}
          onChange={(e) => onChange(e.target.value)}
          className={cn('h-9', inputClassName)}
        />
      )}
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
      {(ids) => (
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={ids.id} aria-invalid={ids.invalid} aria-describedby={ids.describedBy} aria-required={ids.required || undefined} className="h-9 w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      )}
    </Field>
  )
}
