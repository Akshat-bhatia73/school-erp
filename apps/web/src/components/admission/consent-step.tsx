import { CONSENT_PURPOSES, ConsentMethod, type ConsentPurpose } from '@erp/contracts'
import { Panel } from '@/components/shared/page'
import { Checkbox } from '@/components/ui/checkbox'
import { METHOD_LABEL, PURPOSE_DESCRIPTION, PURPOSE_LABEL } from '@/lib/consent'
import { humanize } from '@/lib/utils'
import { SelectField, TextField, type Errors } from './fields'
import type { AdmitDraft, GuardianDraft } from './admit-state'

const METHODS = ConsentMethod.options

/**
 * What each guardian agreed to at admission. Nothing is ticked by default: an untouched box is
 * the honest answer when nobody asked the family.
 */
export function ConsentStep({ draft, set, errors }: {
  draft: AdmitDraft
  set: (p: Partial<AdmitDraft>) => void
  errors: Errors
}) {
  const update = (index: number, patch: Partial<GuardianDraft>) => {
    set({ guardians: draft.guardians.map((guardian, i) => (i === index ? { ...guardian, ...patch } : guardian)) })
  }
  const toggle = (index: number, purpose: ConsentPurpose) => {
    const current = draft.guardians[index]?.consentPurposes ?? []
    update(index, {
      consentPurposes: current.includes(purpose) ? current.filter((p) => p !== purpose) : [...current, purpose],
    })
  }

  const guardianName = (guardian: GuardianDraft) =>
    [guardian.firstName, guardian.lastName].filter(Boolean).join(' ') || humanize(guardian.relation)

  return (
    <div className="space-y-4">
      {errors.consents && <p className="text-[12.5px] text-destructive">{errors.consents}</p>}
      {draft.guardians.map((guardian, index) => (
        <Panel
          key={index}
          title={guardianName(guardian)}
          description="Tick only what this guardian agreed to. You can record or withdraw consent later."
        >
          <div className="grid gap-2.5">
            {CONSENT_PURPOSES.map((purpose) => (
              <label key={purpose} className="flex items-start gap-2.5 rounded-lg border p-2.5">
                <Checkbox
                  className="mt-0.5"
                  checked={guardian.consentPurposes.includes(purpose)}
                  onCheckedChange={() => toggle(index, purpose)}
                  aria-label={`${PURPOSE_LABEL[purpose]} for ${guardianName(guardian)}`}
                />
                <span className="min-w-0">
                  <span className="block text-[13.5px]">{PURPOSE_LABEL[purpose]}</span>
                  <span className="block text-[12.5px] text-muted-foreground">{PURPOSE_DESCRIPTION[purpose]}</span>
                </span>
              </label>
            ))}
          </div>
          {guardian.consentPurposes.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <SelectField
                label="How was it given" value={guardian.consentMethod}
                onChange={(v) => update(index, { consentMethod: v as GuardianDraft['consentMethod'] })}
                options={METHODS.map((method) => ({ value: method, label: METHOD_LABEL[method] }))}
              />
              <TextField
                label="Evidence reference" value={guardian.consentEvidence}
                onChange={(v) => update(index, { consentEvidence: v })}
                hint="Form number or file reference, if there is one."
              />
            </div>
          )}
        </Panel>
      ))}
    </div>
  )
}
