import { Panel } from '@/components/shared/page'
import { useSectionOptions } from '@/components/students/use-section-options'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field, SelectField, TextField, type Errors } from './fields'
import type { AdmitDraft } from './admit-state'

const ADMISSION_TYPES = ['new', 'transfer', 'readmission']

export function ClassStep({ draft, set, errors, academicYearId, yearName }: {
  draft: AdmitDraft
  set: (p: Partial<AdmitDraft>) => void
  errors: Errors
  academicYearId: string | null
  yearName: string
}) {
  const { options } = useSectionOptions(academicYearId)

  return (
    <div className="space-y-4">
      <Panel title="Class and admission" description="Which class the student joins, and the paperwork around it.">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Academic year">
            <Input value={yearName} readOnly disabled className="h-9" />
          </Field>
          <div />
          <SelectField
            label="Class and section" required className="col-span-2"
            value={draft.sectionId}
            error={errors.sectionId}
            placeholder="Select a section"
            onChange={(v) => set({ sectionId: v })}
            options={options.map((option) => ({ value: option.value, label: option.label }))}
          />
          <TextField label="Roll number" type="number" value={draft.rollNumber} onChange={(v) => set({ rollNumber: v })} error={errors.rollNumber} hint="Optional." />
          <TextField label="Admission date" required type="date" value={draft.admissionDate} onChange={(v) => set({ admissionDate: v })} error={errors.admissionDate} />
          <SelectField
            label="Admission type" value={draft.admissionType} onChange={(v) => set({ admissionType: v })} error={errors.admissionType}
            options={ADMISSION_TYPES.map((type) => ({ value: type, label: type === 'new' ? 'New admission' : type === 'transfer' ? 'Transfer' : 'Readmission' }))}
          />
        </div>
      </Panel>

      <Panel title="Home address">
        <Field label="Address" error={errors.address} hint="House, street, city, state and PIN code in one box.">
          <Textarea value={draft.address} onChange={(e) => set({ address: e.target.value })} rows={3} />
        </Field>
      </Panel>
    </div>
  )
}
