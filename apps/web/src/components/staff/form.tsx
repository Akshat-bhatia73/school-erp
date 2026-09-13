import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react'
import { StaffInput } from '@erp/shared'
import type { BloodGroup, Staff } from '@erp/shared'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { employmentOptions, staffTypeOptions, statusOptions } from './shared'

export interface StaffDraft {
  firstName: string
  lastName: string
  gender: 'male' | 'female' | 'other'
  dateOfBirth: string
  bloodGroup: BloodGroup
  phone: string
  email: string
  photoUrl: string
  employeeCode: string
  staffType: Staff['staffType']
  designation: string
  department: string
  employmentType: Staff['employmentType']
  joiningDate: string
  leavingDate: string
  qualification: string
  experienceYears: string
  monthlySalary: string
  bankAccountLast4: string
  panLast4: string
  status: Staff['status']
  line1: string
  line2: string
  city: string
  district: string
  state: string
  pincode: string
}

export const bloodGroups: BloodGroup[] = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']

export const designationSuggestions = [
  'PRT English', 'PRT Hindi', 'TGT Mathematics', 'TGT Science', 'TGT Social Science',
  'PGT Physics', 'PGT Chemistry', 'PGT Biology', 'PGT Commerce', 'Principal',
  'Vice Principal', 'Office Clerk', 'Accountant', 'Librarian', 'Lab Assistant', 'Bus Driver', 'Security Guard',
]

export function emptyDraft(): StaffDraft {
  return {
    firstName: '', lastName: '', gender: 'female', dateOfBirth: '', bloodGroup: 'unknown', phone: '', email: '', photoUrl: '',
    employeeCode: '', staffType: 'teaching', designation: '', department: '', employmentType: 'permanent',
    joiningDate: new Date().toISOString().slice(0, 10), leavingDate: '', qualification: '', experienceYears: '',
    monthlySalary: '', bankAccountLast4: '', panLast4: '', status: 'active',
    line1: '', line2: '', city: '', district: '', state: '', pincode: '',
  }
}

export function draftFromStaff(s: Staff): StaffDraft {
  return {
    ...emptyDraft(),
    firstName: s.firstName, lastName: s.lastName ?? '', gender: s.gender, dateOfBirth: s.dateOfBirth ?? '',
    bloodGroup: s.bloodGroup, phone: s.phone, email: s.email ?? '', photoUrl: s.photoUrl ?? '',
    employeeCode: s.employeeCode, staffType: s.staffType, designation: s.designation, department: s.department ?? '',
    employmentType: s.employmentType, joiningDate: s.joiningDate, leavingDate: s.leavingDate ?? '',
    qualification: s.qualification ?? '', experienceYears: s.experienceYears?.toString() ?? '',
    monthlySalary: s.monthlySalary?.toString() ?? '', bankAccountLast4: s.bankAccountLast4 ?? '', panLast4: s.panLast4 ?? '',
    status: s.status,
    line1: s.address?.line1 ?? '', line2: s.address?.line2 ?? '', city: s.address?.city ?? '',
    district: s.address?.district ?? '', state: s.address?.state ?? '', pincode: s.address?.pincode ?? '',
  }
}

const opt = (v: string) => (v.trim() ? v.trim() : undefined)

/** Shape the draft into the object StaffInput expects */
export function draftToInput(d: StaffDraft): unknown {
  const hasAddress = d.line1.trim() || d.city.trim() || d.pincode.trim() || d.state.trim()
  return {
    firstName: d.firstName.trim(),
    lastName: opt(d.lastName),
    gender: d.gender,
    dateOfBirth: opt(d.dateOfBirth),
    bloodGroup: d.bloodGroup,
    phone: d.phone.trim(),
    email: opt(d.email),
    photoUrl: opt(d.photoUrl),
    address: hasAddress
      ? { line1: d.line1.trim(), line2: opt(d.line2), city: d.city.trim(), district: opt(d.district), state: d.state.trim(), pincode: d.pincode.trim() }
      : undefined,
    employeeCode: d.employeeCode.trim(),
    staffType: d.staffType,
    designation: d.designation.trim(),
    department: opt(d.department),
    employmentType: d.employmentType,
    joiningDate: d.joiningDate,
    leavingDate: opt(d.leavingDate),
    qualification: opt(d.qualification),
    experienceYears: d.experienceYears.trim() ? Number(d.experienceYears) : undefined,
    monthlySalary: d.monthlySalary.trim() ? Number(d.monthlySalary) : undefined,
    bankAccountLast4: opt(d.bankAccountLast4),
    panLast4: opt(d.panLast4),
    status: d.status,
  }
}

export type FieldErrors = Record<string, string>

/** Same label/error wiring as the admission `Field`: see the comment there for the three cases. */
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
    <div className="grid grid-cols-2 gap-4">
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
      <SelectField label="Blood group" value={d.bloodGroup} onChange={(v) => set({ bloodGroup: v })} options={bloodGroups.map((b) => ({ value: b, label: b === 'unknown' ? 'Not known' : b }))} error={errors.bloodGroup} />
      <TextField label="Phone" value={d.phone} onChange={(v) => set({ phone: v.replace(/\D/g, '').slice(0, 10) })} error={errors.phone} placeholder="9876543210" />
      <TextField label="Email" value={d.email} onChange={(v) => set({ email: v })} error={errors.email} placeholder="anita@school.in" />
      <TextField label="Photo URL" value={d.photoUrl} onChange={(v) => set({ photoUrl: v })} error={errors.photoUrl} placeholder="https://…" />
    </div>
  )
}

export function EmploymentFields({ d, set, errors, departments, codeHint }: { d: StaffDraft; set: (p: Partial<StaffDraft>) => void; errors: FieldErrors; departments: string[]; codeHint?: string }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <TextField label="Employee code" value={d.employeeCode} onChange={(v) => set({ employeeCode: v })} error={errors.employeeCode} hint={codeHint} placeholder="SVM-E001" />
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
      <TextField label="Qualification" value={d.qualification} onChange={(v) => set({ qualification: v })} error={errors.qualification} placeholder="M.Sc, B.Ed" />
      <TextField label="Years of experience" value={d.experienceYears} onChange={(v) => set({ experienceYears: v.replace(/[^\d]/g, '') })} error={errors.experienceYears} placeholder="8" />
    </div>
  )
}

export function StatusFields({ d, set, errors }: { d: StaffDraft; set: (p: Partial<StaffDraft>) => void; errors: FieldErrors }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <SelectField label="Status" value={d.status} onChange={(v) => set({ status: v })} options={statusOptions} error={errors.status} />
      <TextField label="Leaving date" type="date" value={d.leavingDate} onChange={(v) => set({ leavingDate: v })} error={errors.leavingDate} />
    </div>
  )
}

export function PayFields({ d, set, errors }: { d: StaffDraft; set: (p: Partial<StaffDraft>) => void; errors: FieldErrors }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <TextField label="Monthly salary (₹)" value={d.monthlySalary} onChange={(v) => set({ monthlySalary: v.replace(/[^\d]/g, '') })} error={errors.monthlySalary} placeholder="42000" />
      <TextField label="Bank account, last 4" value={d.bankAccountLast4} onChange={(v) => set({ bankAccountLast4: v.replace(/\D/g, '').slice(0, 4) })} error={errors.bankAccountLast4} placeholder="4821" />
      <TextField label="PAN, last 4" value={d.panLast4} onChange={(v) => set({ panLast4: v.toUpperCase().slice(0, 4) })} error={errors.panLast4} placeholder="7K2F" />
    </div>
  )
}

export function AddressFields({ d, set, errors }: { d: StaffDraft; set: (p: Partial<StaffDraft>) => void; errors: FieldErrors }) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <TextField label="Address line 1" value={d.line1} onChange={(v) => set({ line1: v })} error={errors['address.line1']} className="col-span-2" placeholder="House 12, Gandhi Road" />
      <TextField label="Address line 2" value={d.line2} onChange={(v) => set({ line2: v })} error={errors['address.line2']} className="col-span-2" />
      <TextField label="City" value={d.city} onChange={(v) => set({ city: v })} error={errors['address.city']} placeholder="Jaipur" />
      <TextField label="District" value={d.district} onChange={(v) => set({ district: v })} error={errors['address.district']} />
      <TextField label="State" value={d.state} onChange={(v) => set({ state: v })} error={errors['address.state']} placeholder="Rajasthan" />
      <TextField label="PIN code" value={d.pincode} onChange={(v) => set({ pincode: v.replace(/\D/g, '').slice(0, 6) })} error={errors['address.pincode']} placeholder="302001" />
    </div>
  )
}

/** Validate a draft with the shared StaffInput schema. Returns errors keyed by field path. */
export function validateDraft(d: StaffDraft): { ok: true; value: StaffInput } | { ok: false; errors: FieldErrors } {
  const parsed = StaffInput.safeParse(draftToInput(d))
  if (parsed.success) return { ok: true, value: parsed.data }
  const errors: FieldErrors = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path.join('.')
    if (!errors[key]) errors[key] = issue.message
  }
  return { ok: false, errors }
}
