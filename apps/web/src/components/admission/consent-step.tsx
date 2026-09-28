import { CONSENT_PURPOSES, ConsentMethod, type ConsentPurpose } from '@erp/contracts'
import { Panel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { METHOD_LABEL, PURPOSE_DESCRIPTION, PURPOSE_LABEL } from '@/lib/consent'
import { humanize } from '@/lib/utils'
import { SelectField, TextField, type Errors } from './fields'
import type { AdmitDraft, GuardianDraft } from './admit-state'

const METHODS = ConsentMethod.options

const guardianName = (guardian: GuardianDraft) =>
  [guardian.firstName, guardian.lastName].filter(Boolean).join(' ') || humanize(guardian.relation)

/**
 * Consent at admission, on the guardians step. Most families sign the consent section of the
 * admission form, so one tick records every purpose for the primary guardian as a signed form.
 * "Choose purposes one by one" opens the per-guardian controls instead. Nothing is ticked by
 * default: an untouched box is the honest answer when nobody asked the family.
 */
export function AdmissionConsent({ draft, set, errors }: {
  draft: AdmitDraft
  set: (p: Partial<AdmitDraft>) => void
  errors: Errors
}) {
  const primary = draft.guardians[draft.primaryIndex]
  // Every row the tick makes carries the same reference, so the first problem with it is enough.
  const referenceError = Object.entries(errors).find(([path]) => /^consents\.\d+\.evidenceReference$/.test(path))?.[1]

  if (draft.consentMode === 'each') {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[14px] font-semibold">Consent</h2>
          <Button variant="link" size="sm" className="h-auto p-0" onClick={() => set({ consentMode: 'form' })}>
            Use the signed admission form instead
          </Button>
        </div>
        <ConsentByGuardian draft={draft} set={set} errors={errors} />
      </div>
    )
  }

  return (
    <Panel title="Consent" description="What the family agreed to on the admission form. You can record or withdraw consent later.">
      {errors.consents && <p className="mb-3 text-[12.5px] text-destructive">{errors.consents}</p>}
      <label className="flex items-start gap-2.5 rounded-lg border p-2.5">
        <Checkbox
          className="mt-0.5"
          checked={draft.consentSigned}
          onCheckedChange={(checked) => set({ consentSigned: checked === true })}
          aria-label="The family signed the consent section of the admission form"
        />
        <span className="min-w-0">
          <span className="block text-[13.5px]">The family signed the consent section of the admission form</span>
          <span className="block text-[12.5px] text-muted-foreground">
            Records every purpose for {primary ? guardianName(primary) : 'the primary contact'} as a signed form.
          </span>
        </span>
      </label>
      {draft.consentSigned && (
        <div className="mt-4 grid grid-cols-2 gap-4">
          <TextField
            label="Form reference" value={draft.consentFormReference}
            onChange={(v) => set({ consentFormReference: v })}
            error={referenceError}
            hint="Optional. Form number or file reference."
          />
        </div>
      )}
      <Button variant="link" size="sm" className="mt-3 h-auto p-0" onClick={() => set({ consentMode: 'each' })}>
        Choose purposes one by one
      </Button>
    </Panel>
  )
}

/** What each guardian agreed to, purpose by purpose, with how it was given. */
export function ConsentByGuardian({ draft, set, errors }: {
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
