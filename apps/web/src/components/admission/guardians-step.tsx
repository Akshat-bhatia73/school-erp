import { Plus, Trash2 } from 'lucide-react'
import { Panel } from '@/components/shared/page'
import { cleanPan, groupAadhaar } from '@/components/students/identity-fields'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Switch } from '@/components/ui/switch'
import { humanize } from '@/lib/utils'
import { SelectField, TextField, type Errors } from './fields'
import { emptyGuardian, type AdmitDraft, type GuardianDraft, type GuardianRelation } from './admit-state'

const RELATIONS: GuardianRelation[] = ['father', 'mother', 'guardian', 'grandparent', 'sibling', 'other']

export function GuardiansStep({ draft, set, errors, canAttachExisting }: {
  draft: AdmitDraft
  set: (p: Partial<AdmitDraft>) => void
  errors: Errors
  /** Only somebody who may manage guardians can point at a record this school already holds. */
  canAttachExisting: boolean
}) {
  const update = (index: number, patch: Partial<GuardianDraft>) => {
    set({ guardians: draft.guardians.map((guardian, i) => (i === index ? { ...guardian, ...patch } : guardian)) })
  }
  const remove = (index: number) => {
    const guardians = draft.guardians.filter((_, i) => i !== index)
    set({ guardians, primaryIndex: draft.primaryIndex >= guardians.length ? 0 : draft.primaryIndex })
  }
  const err = (index: number, field: string) =>
    errors[`guardians.${index}.guardian.${field}`] ?? errors[`guardians.${index}.${field}`]

  return (
    <div className="space-y-4">
      {errors.guardians && <p className="text-[12.5px] text-destructive">{errors.guardians}</p>}
      {draft.guardians.map((guardian, index) => (
        <Panel
          key={index}
          title={draft.primaryIndex === index ? `${humanize(guardian.relation)} · primary contact` : humanize(guardian.relation)}
          description="The phone number is how the school reaches this family."
          actions={draft.guardians.length > 1 ? <Button variant="ghost" size="sm" onClick={() => remove(index)}><Trash2 /> Remove</Button> : undefined}
        >
          <div className="grid grid-cols-2 gap-4">
            <SelectField
              label="Relation" required value={guardian.relation}
              onChange={(v) => update(index, { relation: v as GuardianRelation })}
              error={err(index, 'relation')}
              options={RELATIONS.map((relation) => ({ value: relation, label: humanize(relation) }))}
            />
            {canAttachExisting ? (
              <SelectField
                label="Guardian record" value={guardian.mode}
                onChange={(v) => update(index, { mode: v as GuardianDraft['mode'] })}
                options={[{ value: 'new', label: 'Add a new guardian' }, { value: 'existing', label: 'Use a guardian already on file' }]}
              />
            ) : (
              <div />
            )}

            {guardian.mode === 'existing' ? (
              <TextField
                label="Guardian id" required className="col-span-2"
                value={guardian.guardianId}
                onChange={(v) => update(index, { guardianId: v })}
                error={err(index, 'guardianId')}
                hint="Copy the id from the other child's guardian record."
              />
            ) : (
              <>
                <TextField label="First name" required value={guardian.firstName} onChange={(v) => update(index, { firstName: v })} error={err(index, 'firstName')} />
                <TextField label="Last name" value={guardian.lastName} onChange={(v) => update(index, { lastName: v })} error={err(index, 'lastName')} />
                <TextField
                  label="Phone" required value={guardian.phone} placeholder="9876543210"
                  onChange={(v) => update(index, { phone: v.replace(/\D/g, '').slice(0, 10) })}
                  error={err(index, 'phone') ? 'Write the 10 digit mobile number.' : undefined}
                />
                <TextField label="Occupation" value={guardian.occupation} onChange={(v) => update(index, { occupation: v })} error={err(index, 'occupation')} />
                <TextField label="Address" className="col-span-2" value={guardian.address} onChange={(v) => update(index, { address: v })} error={err(index, 'address')} />
                <TextField
                  label="Office address" className="col-span-2" hint="Optional"
                  value={guardian.officeAddress}
                  onChange={(v) => update(index, { officeAddress: v })}
                  error={err(index, 'officeAddress')}
                />
                <TextField
                  label="PAN" hint="Optional" placeholder="AAAAA9999A"
                  value={guardian.pan}
                  onChange={(v) => update(index, { pan: cleanPan(v) })}
                  error={err(index, 'pan')}
                />
                <TextField
                  label="Aadhaar number" hint="Optional" placeholder="1234 5678 9012"
                  value={guardian.aadhaar}
                  onChange={(v) => update(index, { aadhaar: groupAadhaar(v) })}
                  error={err(index, 'aadhaar')}
                />
              </>
            )}

            <div className="col-span-2 flex flex-wrap items-center justify-between gap-4">
              <RadioGroup value={String(draft.primaryIndex)} onValueChange={(v) => set({ primaryIndex: Number(v) })} className="flex items-center">
                <div className="flex items-center gap-2">
                  <RadioGroupItem value={String(index)} id={`primary-${index}`} />
                  <Label htmlFor={`primary-${index}`} className="text-[13.5px] font-normal">Primary contact</Label>
                </div>
              </RadioGroup>
              <label className="flex items-center gap-2 text-[13.5px]">
                Gets messages from the school
                <Switch checked={guardian.receivesNotifications} onCheckedChange={(v) => update(index, { receivesNotifications: v })} />
              </label>
            </div>
          </div>
        </Panel>
      ))}

      {draft.guardians.length < 5 && (
        <Button
          variant="outline"
          onClick={() => set({ guardians: [...draft.guardians, emptyGuardian(draft.guardians[0]?.relation === 'father' ? 'mother' : 'father')] })}
        >
          <Plus /> Add another guardian
        </Button>
      )}
    </div>
  )
}
