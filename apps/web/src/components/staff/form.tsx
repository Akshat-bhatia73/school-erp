/**
 * Field primitives for the staff screens plus the "add staff" draft.
 *
 * The draft holds strings because that is what inputs give back; `draftToCreateRequest` shapes it
 * and `StaffCreateRequest` from the contract is the only validator. Nothing here decides anything.
 */
import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { StaffCreateRequest } from '@erp/contracts'
import type { CreateStaffInput } from '@/lib/api/staff'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { employmentOptions, staffTypeOptions, type EmploymentTypeValue, type StaffTypeValue } from './shared'

export interface StaffDraft {
  firstName: string
  lastName: string
  gender: '' | 'male' | 'female' | 'other'
  dateOfBirth: string
  phone: string
  email: string
  staffType: StaffTypeValue
  designation: string
  department: string
  employmentType: EmploymentTypeValue
  joiningDate: string
  qualification: string
}

export const designationSuggestions = [
  'PRT English', 'PRT Hindi', 'TGT Mathematics', 'TGT Science', 'TGT Social Science',
  'PGT Physics', 'PGT Chemistry', 'PGT Biology', 'PGT Commerce', 'Principal',
  'Vice Principal', 'Office Clerk', 'Accountant', 'Librarian', 'Lab Assistant', 'Bus Driver', 'Security Guard',
]

export function emptyDraft(): StaffDraft {
  return {
    firstName: '', lastName: '', gender: '', dateOfBirth: '', phone: '', email: '',
    staffType: 'teaching', designation: '', department: '',
    employmentType: 'permanent', joiningDate: new Date().toISOString().slice(0, 10), qualification: '',
  }
}

const opt = (value: string) => (value.trim() === '' ? undefined : value.trim())

export function draftToCreateRequest(d: StaffDraft): unknown {
  return {
    firstName: d.firstName.trim(),
    lastName: opt(d.lastName),
    staffType: d.staffType,
    designation: d.designation.trim(),
    department: opt(d.department),
    employmentType: d.employmentType,
    joiningDate: d.joiningDate,
    phone: d.phone.trim(),
    email: opt(d.email),
    gender: d.gender === '' ? undefined : d.gender,
    dateOfBirth: opt(d.dateOfBirth),
    qualification: opt(d.qualification),
  }
}

export type FieldErrors = Record<string, string>

/** Zod issues keyed by field path, so each input can show its own message. */
export function fieldErrorsFrom(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): FieldErrors {
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form'
    if (!errors[key]) errors[key] = issue.message
  }
  return errors
}

/** Validate the draft with the contract request schema, never with a model schema. */
export function validateDraft(d: StaffDraft): { ok: true; value: CreateStaffInput } | { ok: false; errors: FieldErrors } {
  const parsed = StaffCreateRequest.safeParse(draftToCreateRequest(d))
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, errors: fieldErrorsFrom(parsed.error.issues) }
}

/** Same label/error wiring as the admission `Field`. */
export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) {
  const base = useId()
  const labelId = `${base}-label`
  const controlId = `${base}-control`
  const describedBy = error ? `${base}-error` : hint ? `${base}-hint` : undefined
  const injectable = isValidElement(children) && children.type === Input
  let control: ReactNode
  if (injectable) {
    const el = children as ReactElement<Record<string, unknown>>
    control = cloneElement(el, {
      id: el.props.id ?? controlId,
      'aria-invalid': el.props['aria-invalid'] ?? !!error,
      'aria-describedby': el.props['aria-describedby'] ?? describedBy,
    })
  } else {
    control = <div role="group" aria-labelledby={labelId} aria-describedby={describedBy}>{children}</div>
  }
  return (
    <div className={cn('min-w-0', className)}>
      <Label id={labelId} htmlFor={injectable ? controlId : undefined} className="mb-1.5 text-[12.5px] text-muted-foreground">{label}</Label>
      {control}
      {error ? <p id={`${base}-error`} className="mt-1 text-[12px] text-destructive">{error}</p> : hint ? <p id={`${base}-hint`} className="mt-1 text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export function TextField({ label, value, onChange, error, hint, placeholder, type, list, className }: {
  label: string; value: string; onChange: (v: string) => void; error?: string; hint?: string; placeholder?: string; type?: string; list?: string; className?: string
}) {
  return (
    <Field label={label} error={error} hint={hint} className={className}>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type} list={list} aria-invalid={!!error} />
    </Field>
  )
}

export function SelectField<T extends string>({ label, value, onChange, options, error, className }: {
  label: string; value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; error?: string; className?: string
}) {
  return (
    <Field label={label} error={error} className={className}>
      <Select value={value} onValueChange={(v) => onChange(v as T)}>
        <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </Field>
  )
}

export function Datalist({ id, values }: { id: string; values: string[] }) {
  return <datalist id={id}>{values.map((v) => <option key={v} value={v} />)}</datalist>
}

export function PersonalFields({ d, set, errors }: { d: StaffDraft; set: (p: Partial<StaffDraft>) => void; errors: FieldErrors }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <TextField label="First name" value={d.firstName} onChange={(v) => set({ firstName: v })} error={errors.firstName} placeholder="Anita" />
      <TextField label="Last name" value={d.lastName} onChange={(v) => set({ lastName: v })} error={errors.lastName} placeholder="Sharma" />
      <Field label="Gender" error={errors.gender}>
        <RadioGroup value={d.gender} onValueChange={(v) => set({ gender: v as StaffDraft['gender'] })} className="flex h-9 items-center gap-5">
          {(['female', 'male', 'other'] as const).map((g) => (
            <label key={g} className="flex cursor-pointer items-center gap-2 text-[13.5px] capitalize">
              <RadioGroupItem value={g} />{g}
            </label>
          ))}
        </RadioGroup>
      </Field>
      <TextField label="Date of birth" type="date" value={d.dateOfBirth} onChange={(v) => set({ dateOfBirth: v })} error={errors.dateOfBirth} />
      <TextField label="Phone" value={d.phone} onChange={(v) => set({ phone: v })} error={errors.phone} hint="Include the country code, like +919876543210" placeholder="+919876543210" />
      <TextField label="Email" value={d.email} onChange={(v) => set({ email: v })} error={errors.email} placeholder="anita@school.in" />
    </div>
  )
}

export function EmploymentFields({ d, set, errors, departments }: { d: StaffDraft; set: (p: Partial<StaffDraft>) => void; errors: FieldErrors; departments: string[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <SelectField label="Staff type" value={d.staffType} onChange={(v) => set({ staffType: v })} options={staffTypeOptions} error={errors.staffType} />
      <Field label="Designation" error={errors.designation}>
        <Input value={d.designation} onChange={(e) => set({ designation: e.target.value })} list="staff-designations" placeholder="PRT English" aria-invalid={!!errors.designation} />
        <Datalist id="staff-designations" values={designationSuggestions} />
      </Field>
      <Field label="Department" error={errors.department}>
        <Input value={d.department} onChange={(e) => set({ department: e.target.value })} list="staff-departments" placeholder="Science" aria-invalid={!!errors.department} />
        <Datalist id="staff-departments" values={departments} />
      </Field>
      <SelectField label="Employment type" value={d.employmentType} onChange={(v) => set({ employmentType: v })} options={employmentOptions} error={errors.employmentType} />
      <TextField label="Joining date" type="date" value={d.joiningDate} onChange={(v) => set({ joiningDate: v })} error={errors.joiningDate} />
      <TextField label="Qualification" value={d.qualification} onChange={(v) => set({ qualification: v })} error={errors.qualification} className="sm:col-span-2" placeholder="M.Sc, B.Ed" />
    </div>
  )
}
