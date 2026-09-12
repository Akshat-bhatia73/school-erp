import { useQuery } from '@tanstack/react-query'
import type { AdmissionType } from '@erp/shared'
import { Panel } from '@/components/shared/page'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/api/client'
import { qk } from '@/lib/query'
import { humanize } from '@/lib/utils'
import { Field, SelectField, TextField, type Errors } from './fields'
import type { AdmitDraft } from './admit-state'

const ADMISSION_TYPES: AdmissionType[] = ['regular', 'rte', 'staff_ward', 'scholarship']

export function ClassStep({ draft, set, errors, yearId, yearName }: { draft: AdmitDraft; set: (p: Partial<AdmitDraft>) => void; errors: Errors; yearId: string; yearName: string }) {
  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const { data: sections = [] } = useQuery({ queryKey: qk.sections({ academicYearId: yearId }), queryFn: () => api.sections.list({ academicYearId: yearId }), enabled: !!yearId })
  const { data: strengths = {} } = useQuery({ queryKey: qk.sectionStrengths(yearId), queryFn: () => api.sections.strengths(yearId), enabled: !!yearId })

  const gradeSections = sections.filter((s) => s.gradeId === draft.gradeId)

  return (
    <div className="space-y-4">
      <Panel title="Class and admission" description="Which class the student joins, and the paperwork around it.">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Academic year">
            <Input value={yearName} readOnly disabled className="h-9" />
          </Field>
          <div />
          <SelectField
            label="Class" required value={draft.gradeId} error={errors.gradeId}
            onChange={(v) => set({ gradeId: v, sectionId: '' })}
            options={grades.map((g) => ({ value: g.id, label: g.name }))}
          />
          <SelectField
            label="Section" required value={draft.sectionId} error={errors.sectionId}
            disabled={!draft.gradeId}
            placeholder={draft.gradeId ? 'Select a section' : 'Pick a class first'}
            onChange={(v) => set({ sectionId: v })}
            options={gradeSections.map((s) => ({ value: s.id, label: `${s.name} · ${strengths[s.id] ?? 0}/${s.capacity ?? 40}` }))}
          />
          <TextField label="Roll number" type="number" value={draft.rollNumber} onChange={(v) => set({ rollNumber: v })} error={errors.rollNumber} />
          <TextField label="Admission number" required value={draft.admissionNumber} onChange={(v) => set({ admissionNumber: v })} error={errors.admissionNumber} hint="Suggested for you. Change it if your school numbers differently." />
          <TextField label="Admission date" required type="date" value={draft.admissionDate} onChange={(v) => set({ admissionDate: v })} error={errors.admissionDate} />
          <SelectField label="Admission type" value={draft.admissionType} onChange={(v) => set({ admissionType: v as AdmissionType })} error={errors.admissionType} options={ADMISSION_TYPES.map((t) => ({ value: t, label: t === 'rte' ? 'RTE' : humanize(t) }))} />
          <TextField label="Previous school" value={draft.previousSchool} onChange={(v) => set({ previousSchool: v })} error={errors.previousSchool} className="col-span-2" />
        </div>
      </Panel>

      <Panel title="Home address">
        <div className="grid grid-cols-2 gap-4">
          <TextField label="Address line 1" required value={draft.address.line1} onChange={(v) => set({ address: { ...draft.address, line1: v } })} error={errors['address.line1']} />
          <TextField label="Address line 2" value={draft.address.line2} onChange={(v) => set({ address: { ...draft.address, line2: v } })} error={errors['address.line2']} />
          <TextField label="City" required value={draft.address.city} onChange={(v) => set({ address: { ...draft.address, city: v } })} error={errors['address.city']} />
          <TextField label="State" required value={draft.address.state} onChange={(v) => set({ address: { ...draft.address, state: v } })} error={errors['address.state']} />
          <TextField label="PIN code" required value={draft.address.pincode} onChange={(v) => set({ address: { ...draft.address, pincode: v.replace(/\D/g, '').slice(0, 6) } })} error={errors['address.pincode']} />
        </div>
      </Panel>

      <Panel title="Transport and health">
        <div className="space-y-4">
          <label className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
            <span>
              <span className="block text-[13.5px] font-medium">Uses school transport</span>
              <span className="block text-[12.5px] text-muted-foreground">Turn this on if the student takes a school bus or van.</span>
            </span>
            <Switch checked={draft.usesTransport} onCheckedChange={(v) => set({ usesTransport: v })} />
          </label>
          <Field label="Medical notes" hint="Allergies, medicines, anything the class teacher should know.">
            <Textarea value={draft.medicalNotes} onChange={(e) => set({ medicalNotes: e.target.value })} rows={3} />
          </Field>
        </div>
      </Panel>
    </div>
  )
}
