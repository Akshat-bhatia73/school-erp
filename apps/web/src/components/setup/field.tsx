import type { ReactNode } from 'react'
import type { ZodType } from 'zod'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/** Labelled form field with an inline error message under it. */
export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label className="text-[12.5px] text-muted-foreground">{label}</Label>
      {children}
      {error ? <p role="alert" className="text-[12px] text-tag-red">{error}</p> : hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export type FieldErrors = Record<string, string>

/** The key a whole-form problem is filed under, for a rule that spans two fields. */
export const FORM_ERROR = '_'

/**
 * Check a form against the contract request schema the server will apply.
 *
 * Errors come back keyed by dotted path so a `Field` can show its own message, and a rule that
 * belongs to no single field (an end date before its start) lands on `FORM_ERROR`.
 */
export function validate<T>(schema: ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false; errors: FieldErrors } {
  const res = schema.safeParse(value)
  if (res.success) return { ok: true, data: res.data }
  const errors: FieldErrors = {}
  for (const issue of res.error.issues) {
    const key = issue.path.join('.') || FORM_ERROR
    if (!errors[key]) errors[key] = issue.message
  }
  return { ok: false, errors }
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
