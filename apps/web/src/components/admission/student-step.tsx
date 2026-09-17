import { Panel } from '@/components/shared/page'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { humanize } from '@/lib/utils'
import { Field, SelectField, TextField, type Errors } from './fields'
import type { AdmitDraft } from './admit-state'

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
              {GENDERS.map((gender) => (
                <div key={gender} className="flex items-center gap-2">
                  <RadioGroupItem value={gender} id={`gender-${gender}`} />
                  <Label htmlFor={`gender-${gender}`} className="text-[13.5px] font-normal">{humanize(gender)}</Label>
                </div>
              ))}
            </RadioGroup>
          </Field>
          <SelectField
            label="Category"
            value={draft.category}
            onChange={(v) => set({ category: v })}
            error={errors.category}
            options={CATEGORY.map((c) => ({ value: c, label: ['obc', 'sc', 'st', 'ews'].includes(c) ? c.toUpperCase() : humanize(c) }))}
          />
        </div>
      </Panel>
    </div>
  )
}
