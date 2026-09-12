import { Plus, Trash2 } from 'lucide-react'
import type { GuardianRelation } from '@erp/shared'
import { Panel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { humanize } from '@/lib/utils'
import { SelectField, TextField, type Errors } from './fields'
import { emptyGuardian, type AdmitDraft, type GuardianDraft } from './admit-state'

const RELATIONS: GuardianRelation[] = ['father', 'mother', 'guardian', 'grandparent', 'sibling', 'other']

export function GuardiansStep({ draft, set, errors }: { draft: AdmitDraft; set: (p: Partial<AdmitDraft>) => void; errors: Errors }) {
  const update = (i: number, patch: Partial<GuardianDraft>) => {
    const guardians = draft.guardians.map((g, idx) => (idx === i ? { ...g, ...patch } : g))
    set({ guardians })
  }
  const remove = (i: number) => {
    const guardians = draft.guardians.filter((_, idx) => idx !== i)
    set({ guardians, primaryIndex: draft.primaryIndex >= guardians.length ? 0 : draft.primaryIndex })
  }
  const err = (i: number, field: string) => errors[`guardians.${i}.guardian.${field}`] ?? errors[`guardians.${i}.${field}`]

  return (
    <div className="space-y-4">
      {errors.guardians && <p className="text-[12.5px] text-destructive">{errors.guardians}</p>}
      {draft.guardians.map((g, i) => (
        <Panel
          key={i}
          title={draft.primaryIndex === i ? `${humanize(g.relation)} · primary contact` : humanize(g.relation)}
          description="The phone number is how this parent will log in and get fee and attendance messages."
          actions={draft.guardians.length > 1 ? (
            <Button variant="ghost" size="sm" onClick={() => remove(i)}><Trash2 /> Remove</Button>
          ) : undefined}
        >
          <div className="grid grid-cols-2 gap-4">
            <SelectField label="Relation" required value={g.relation} onChange={(v) => update(i, { relation: v as GuardianRelation })} error={err(i, 'relation')} options={RELATIONS.map((r) => ({ value: r, label: humanize(r) }))} />
            <div />
            <TextField label="First name" required value={g.firstName} onChange={(v) => update(i, { firstName: v })} error={err(i, 'firstName')} />
            <TextField label="Last name" value={g.lastName} onChange={(v) => update(i, { lastName: v })} error={err(i, 'lastName')} />
            <TextField label="Phone" required value={g.phone} onChange={(v) => update(i, { phone: v.replace(/\D/g, '').slice(0, 10) })} error={err(i, 'phone')} placeholder="9876543210" />
            <TextField label="Email" type="email" value={g.email} onChange={(v) => update(i, { email: v })} error={err(i, 'email')} />
            <TextField label="Occupation" value={g.occupation} onChange={(v) => update(i, { occupation: v })} error={err(i, 'occupation')} />
            <div className="flex items-end gap-5 pb-1">
              <RadioGroup value={String(draft.primaryIndex)} onValueChange={(v) => set({ primaryIndex: Number(v) })} className="flex items-center">
                <div className="flex items-center gap-2">
                  <RadioGroupItem value={String(i)} id={`primary-${i}`} />
                  <Label htmlFor={`primary-${i}`} className="text-[13.5px] font-normal">Primary contact</Label>
                </div>
              </RadioGroup>
              <label className="flex items-center gap-2 text-[13.5px]">
                <Checkbox checked={g.sameAddress} onCheckedChange={(v) => update(i, { sameAddress: !!v })} />
                Same address as student
              </label>
            </div>
          </div>
        </Panel>
      ))}

      {draft.guardians.length < 2 && (
        <Button variant="outline" onClick={() => set({ guardians: [...draft.guardians, emptyGuardian(draft.guardians[0]?.relation === 'father' ? 'mother' : 'father')] })}>
          <Plus /> Add another guardian
        </Button>
      )}
    </div>
  )
}
