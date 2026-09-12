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
      {error ? <p className="text-[12px] text-tag-red">{error}</p> : hint ? <p className="text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export type FieldErrors = Record<string, string>

/** Validate with a Zod schema and return field errors keyed by dotted path. */
export function validate<T>(schema: ZodType<T>, value: unknown): { ok: true; data: T } | { ok: false; errors: FieldErrors } {
  const res = schema.safeParse(value)
  if (res.success) return { ok: true, data: res.data }
  const errors: FieldErrors = {}
  for (const issue of res.error.issues) {
    const key = issue.path.join('.') || '_'
    if (!errors[key]) errors[key] = issue.message
  }
  return { ok: false, errors }
}
