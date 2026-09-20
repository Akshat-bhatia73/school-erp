/**
 * Plain-English form messages.
 *
 * Every form checks itself against the same @erp/contracts schema the server applies, so the
 * problems arrive as Zod issues. Zod's own wording ("Too small: expected string to have >=2
 * characters") is written for a programmer, so nothing from it ever reaches a screen: each issue
 * is turned into a sentence that names the field the person is looking at.
 *
 * A message a schema author wrote by hand is already plain English and wins. Zod's own defaults
 * are recognised by their shape and replaced.
 */
import type { ZodError, core } from 'zod'
import { ApiRequestError } from '@/lib/http'
import { describeError } from '@/lib/api-errors'

/** The key a whole-form problem is filed under, for a rule that belongs to no single field. */
export const FORM_ERROR = '_'

/** What a toast says when the fields themselves carry the detail. */
export const CHECK_FIELDS = 'Check the highlighted fields'

export type FieldErrors = Record<string, string>

/**
 * How a field is filled in, which decides the verb: you enter a name, you choose a class.
 * `phone`, `email` and `date` also decide what a format problem reads like.
 */
export type FieldKind = 'text' | 'select' | 'phone' | 'email' | 'date' | 'number' | 'list'

export type FieldLabel = string | { label: string; kind?: FieldKind }

/**
 * Labels by dotted path, as the form's own field names.
 *
 * A path with a row number matches on `*` too, so one entry covers every guardian:
 * `'guardians.*.phone': 'guardian phone number'`.
 */
export type FieldLabels = Record<string, FieldLabel>

type Issue = core.$ZodIssue

type Resolved = { label: string; kind: FieldKind }

const FALLBACK: Resolved = { label: 'details', kind: 'text' }

/** Zod's own wording, by the shapes its default messages take. Anything else was written by hand. */
const ZOD_DEFAULT = /^(Invalid |Too small:|Too big:|Unrecognized key|Not a multiple of|Input not instance of)/

function pathKey(path: readonly PropertyKey[]): string {
  return path.map(String).join('.')
}

/** The same path with every row number replaced by `*`, so one label covers a whole list. */
function wildcardKey(path: readonly PropertyKey[]): string {
  return path.map((part) => (typeof part === 'number' ? '*' : String(part))).join('.')
}

function resolveLabel(path: readonly PropertyKey[], labels: FieldLabels): Resolved {
  const candidates = [pathKey(path), wildcardKey(path), String(path[path.length - 1] ?? '')]
  for (const candidate of candidates) {
    const found = candidate === '' ? undefined : labels[candidate]
    if (found === undefined) continue
    const label = typeof found === 'string' ? found : found.label
    const kind = typeof found === 'string' ? guessKind(label) : (found.kind ?? guessKind(label))
    return { label, kind }
  }
  return FALLBACK
}

/** A label that says what it is saves the caller from spelling out the kind. */
function guessKind(label: string): FieldKind {
  const lower = label.toLowerCase()
  if (lower.includes('phone') || lower.includes('mobile')) return 'phone'
  if (lower.includes('email')) return 'email'
  if (lower.includes('date') || lower.endsWith(' on') || lower.endsWith(' day')) return 'date'
  return 'text'
}

/** "Enter the first name" or, for anything picked from a list, "Choose a class". */
function missing({ label, kind }: Resolved): string {
  return kind === 'select' || kind === 'list' || kind === 'date' ? `Choose a ${label}` : `Enter the ${label}`
}

function plural(count: number, one: string): string {
  return `${count} ${one}${count === 1 ? '' : 's'}`
}

function formatMessage(issue: Issue, field: Resolved): string {
  const { label, kind } = field

  switch (issue.code) {
    case 'invalid_type':
      return missing(field)

    case 'too_small': {
      const min = Number(issue.minimum)
      if (issue.origin === 'array' || issue.origin === 'set') {
        return min <= 1 ? `Choose at least one ${label}` : `Choose at least ${plural(min, 'option')} for the ${label}`
      }
      if (issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint') {
        return `Enter ${min} or more for the ${label}`
      }
      if (issue.origin === 'date') return `Choose a later ${label}`
      if (min <= 1) return missing(field)
      return `Enter at least ${plural(min, 'character')} for the ${label}`
    }

    case 'too_big': {
      const max = Number(issue.maximum)
      if (issue.origin === 'array' || issue.origin === 'set') {
        return `Choose at most ${plural(max, 'option')} for the ${label}`
      }
      if (issue.origin === 'number' || issue.origin === 'int' || issue.origin === 'bigint') {
        return `Enter ${max} or less for the ${label}`
      }
      if (issue.origin === 'date') return `Choose an earlier ${label}`
      return `Use at most ${plural(max, 'character')} for the ${label}`
    }

    case 'invalid_format': {
      if (issue.format === 'email') return 'Enter a valid email address'
      if (issue.format === 'date' || issue.format === 'datetime' || issue.format === 'time') return 'Choose a valid date'
      if (kind === 'phone') return 'Enter a 10 digit phone number'
      if (kind === 'email') return 'Enter a valid email address'
      if (kind === 'date') return 'Choose a valid date'
      return `Check the ${label}`
    }

    case 'invalid_value':
      return missing({ label, kind: kind === 'text' ? 'select' : kind })

    case 'not_multiple_of':
      return `Check the ${label}`

    default:
      return `Check the ${label}`
  }
}

/** One plain sentence for one issue: a hand-written message if there is one, ours otherwise. */
export function messageForIssue(issue: Issue, labels: FieldLabels = {}): string {
  const field = resolveLabel(issue.path, labels)
  if (issue.message && !ZOD_DEFAULT.test(issue.message)) return issue.message
  return formatMessage(issue, field)
}

export type FriendlyIssue = { field: string; message: string }

/** Every issue as `{ field, message }`, in the order Zod found them, first one per field. */
export function friendlyIssues(error: ZodError | { issues: readonly Issue[] }, labels: FieldLabels = {}): FriendlyIssue[] {
  const seen = new Set<string>()
  const out: FriendlyIssue[] = []
  for (const issue of error.issues) {
    const field = pathKey(issue.path) || FORM_ERROR
    if (seen.has(field)) continue
    seen.add(field)
    out.push({ field, message: messageForIssue(issue, labels) })
  }
  return out
}

/** The same thing keyed by field, which is what a form holds in state. */
export function fieldErrors(error: ZodError | { issues: readonly Issue[] }, labels: FieldLabels = {}): FieldErrors {
  const out: FieldErrors = {}
  for (const { field, message } of friendlyIssues(error, labels)) out[field] = message
  return out
}

/**
 * The failure of a check, ready to hand to a form: either the parsed value or the messages.
 *
 * `validate(schema, value, labels)` replaces the hand-rolled `safeParse` + `issue.message` loop
 * every form used to carry.
 */
export function validate<T>(
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: ZodError } },
  value: unknown,
  labels: FieldLabels = {},
): { ok: true; data: T } | { ok: false; errors: FieldErrors } {
  const result = schema.safeParse(value)
  if (result.success) return { ok: true, data: result.data }
  return { ok: false, errors: fieldErrors(result.error, labels) }
}

/**
 * A rejected request turned into form errors.
 *
 * The error envelope deliberately carries no field paths and no rejected values, so a request the
 * server refused as invalid lands on the form as a whole; every other failure keeps its own
 * sentence from `describeError`.
 */
export function serverFieldErrors(error: unknown, labels: FieldLabels = {}, field: string = FORM_ERROR): FieldErrors {
  if (error instanceof ApiRequestError && error.code === 'INVALID_REQUEST') {
    const named = labels[field]
    const label = typeof named === 'string' ? named : named?.label
    return { [field]: label ? `Check the ${label}` : describeError(error) }
  }
  return { [field]: describeError(error) }
}

/**
 * Put the cursor in the first field the person has to fix.
 *
 * The field is found by the `aria-invalid` the `Field` primitives already set from the error they
 * were given, so no form has to keep a second list of its own inputs. Call it after the errors are
 * on screen. Nothing found is fine: focus is a help, never a requirement.
 */
export function focusFirstInvalid(root?: ParentNode | null): void {
  const scope = root ?? (typeof document === 'undefined' ? null : document)
  if (!scope) return
  const element = scope.querySelector<HTMLElement>('[aria-invalid="true"]')
  element?.focus()
}
