import { Panel } from '@/components/shared/page'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { humanize } from '@/lib/utils'
import { Field, SelectField, TextField, type Errors } from './fields'
import type { AdmitDraft } from './admit-state'

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'unknown']
const CATEGORY = ['general', 'obc', 'sc', 'st', 'ews', 'other']
const GENDERS = ['male', 'female', 'other'] as const

export function StudentStep({ draft, set, errors }: { draft: AdmitDraft; set: (p: Partial<AdmitDraft>) => void; errors: Errors }) {
  return (
    <div className="space-y-4">
      <Panel title="Student details" description="Name and date of birth go on every report card, so check the spelling.">
        <div className="grid grid-cols-2 gap-4">
          <TextField label="First name" required value={draft.firstName} onChange={(v) => set({ firstName: v })} error={errors.firstName} />
          <TextField label="Last name" value={draft.lastName} onChange={(v) => set({ lastName: v })} error={errors.lastName} />
          <TextField label="Date of birth" required type="date" value={draft.dateOfBirth} onChange={(v) => set({ dateOfBirth: v })} error={errors.dateOfBirth} />
          <Field label="Gender" required error={errors.gender}>
            <RadioGroup value={draft.gender} onValueChange={(v) => set({ gender: v as AdmitDraft['gender'] })} className="flex h-9 items-center gap-5">
              {GENDERS.map((g) => (
                <div key={g} className="flex items-center gap-2">
                  <RadioGroupItem value={g} id={`gender-${g}`} />
                  <Label htmlFor={`gender-${g}`} className="text-[13.5px] font-normal">{humanize(g)}</Label>
                </div>
              ))}
            </RadioGroup>
          </Field>
          <SelectField label="Blood group" value={draft.bloodGroup} onChange={(v) => set({ bloodGroup: v as AdmitDraft['bloodGroup'] })} error={errors.bloodGroup} options={BLOOD.map((b) => ({ value: b, label: b === 'unknown' ? 'Not known' : b }))} />
          <SelectField label="Category" value={draft.category} onChange={(v) => set({ category: v as AdmitDraft['category'] })} error={errors.category} options={CATEGORY.map((c) => ({ value: c, label: c === 'obc' || c === 'sc' || c === 'st' || c === 'ews' ? c.toUpperCase() : humanize(c) }))} />
        </div>
      </Panel>

      <Panel title="Other details" description="Optional, but useful for government records.">
        <div className="grid grid-cols-2 gap-4">
          <TextField label="Religion" value={draft.religion} onChange={(v) => set({ religion: v })} error={errors.religion} />
          <TextField label="Mother tongue" value={draft.motherTongue} onChange={(v) => set({ motherTongue: v })} error={errors.motherTongue} />
          <TextField label="Aadhaar last 4 digits" value={draft.aadhaarLast4} onChange={(v) => set({ aadhaarLast4: v.replace(/\D/g, '').slice(0, 4) })} error={errors.aadhaarLast4} placeholder="1234" hint="We only keep the last 4 digits." />
          <TextField label="Photo URL" value={draft.photoUrl} onChange={(v) => set({ photoUrl: v })} error={errors.photoUrl} placeholder="https://…" />
        </div>
      </Panel>
    </div>
  )
}
