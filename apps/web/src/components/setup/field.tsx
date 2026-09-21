import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import type { ZodType } from 'zod'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { FORM_ERROR, type FieldLabels, fieldErrors } from '@/lib/validation'

/**
 * Labelled form field with an inline error message under it. A plain `Input` or `Textarea` is
 * marked invalid for us, which is what `focusFirstInvalid` looks for and what a screen reader
 * announces.
 */
export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  const injectable = isValidElement(children) && (children.type === Input || children.type === Textarea)
  const control = injectable && error
    ? cloneElement(children as ReactElement<Record<string, unknown>>, { 'aria-invalid': true })
    : children
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-[12.5px] text-muted-foreground">{label}</Label>
      {control}
      {error ? <p role="alert" className="text-[12px] text-tag-red">{error}</p> : hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export type FieldErrors = Record<string, string>

export { FORM_ERROR }
export type { FieldLabels }

/**
 * Check a form against the contract request schema the server will apply.
 *
 * Errors come back keyed by dotted path so a `Field` can show its own message, and a rule that
 * belongs to no single field (an end date before its start) lands on `FORM_ERROR`. The `labels`
 * give each path the words the person reads on the screen, so nothing shows Zod's own wording.
 */
export function validate<T>(schema: ZodType<T>, value: unknown, labels: FieldLabels = {}): { ok: true; data: T } | { ok: false; errors: FieldErrors } {
  const res = schema.safeParse(value)
  if (res.success) return { ok: true, data: res.data }
  return { ok: false, errors: fieldErrors(res.error, labels) }
}

/** A 10-digit Indian number typed by hand becomes the E.164 number the contract wants. */
export function toE164(input: string): string {
  const trimmed = input.trim().replace(/[\s-]/g, '')
  if (trimmed.startsWith('+')) return trimmed
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 10) return `+91${digits}`
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`
  return trimmed
}
