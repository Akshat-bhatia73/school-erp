/**
 * An optional fee, such as transport, inside a change card: the pupil, the fee and how often it is
 * charged are fixed, with what the pupil's class is charged for it when the school set that. The
 * pupil's own amount (needed only when the class has none) and the start and end are edited here.
 */
import type { FeeOptInPreview } from '@erp/contracts'
import { useState } from 'react'
import { paiseToRupeeText } from '@/components/fees/fee-form'
import { FREQUENCY_LABEL } from '@/components/fees/labels'
import { Facts } from '@/components/shared/page'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { FieldErrors } from '@/lib/validation'
import { formatDate, formatPaise, rupeesToPaise } from '@/lib/utils'
import { FIELD_LABEL, FieldError, PupilLine } from './parts'

type Proposed = FeeOptInPreview['proposed']

export function FeeOptInBody({ preview, onChange, errors, readOnly, idBase }: {
  preview: FeeOptInPreview
  onChange: (next: FeeOptInPreview) => void
  errors: FieldErrors
  readOnly: boolean
  /** Unique to the card, so two cards on one answer never share a label target. */
  idBase: string
}) {
  const { proposed } = preview
  // The box keeps what was typed; the preview holds paise, null for the class's amount, or 0 while it is not an amount.
  const [amountText, setAmountText] = useState(() => (proposed.amountPaise !== null && proposed.amountPaise > 0 ? paiseToRupeeText(proposed.amountPaise) : ''))
  const ids = { amount: `${idBase}-amount`, starts: `${idBase}-starts`, ends: `${idBase}-ends` }
  const setProposed = (change: Partial<Proposed>) => onChange({ ...preview, proposed: { ...proposed, ...change } })
  const err = { amount: errors['proposed.amountPaise'], starts: errors['proposed.startsOn'], ends: errors['proposed.endsOn'] }
  const classAmount = preview.structureAmountPaise
  const amountHint = classAmount === null
    ? 'The class has no amount set for this fee, so enter one.'
    : 'Leave empty to charge what the class is charged.'

  return (
    <div>
      <PupilLine label={preview.studentLabel} year={preview.academicYearName} />

      <div className="px-3.5 pt-3">
        <Facts
          items={[
            { label: 'Fee', value: preview.head.name },
            { label: 'Charged', value: FREQUENCY_LABEL[preview.frequency] },
            { label: 'Class amount', value: classAmount === null ? 'Not set' : `${formatPaise(classAmount)} per instalment` },
          ]}
        />
      </div>

      <div className="grid gap-3 px-3.5 py-3 sm:grid-cols-3">
        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.amount} className={FIELD_LABEL}>{classAmount === null ? 'Amount per instalment' : 'Own amount (optional)'}</Label>
          {readOnly ? (
            <p id={ids.amount} className="text-[13.5px] tabular-nums">
              {proposed.amountPaise !== null ? formatPaise(proposed.amountPaise) : 'The class amount'}
            </p>
          ) : (
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[13px] text-muted-foreground">₹</span>
              <Input
                id={ids.amount}
                inputMode="decimal"
                placeholder={classAmount === null ? '0' : paiseToRupeeText(classAmount)}
                value={amountText}
                aria-invalid={!!err.amount || undefined}
                aria-describedby={err.amount ? `${ids.amount}-error` : `${ids.amount}-hint`}
                onChange={(event) => {
                  const text = event.target.value
                  setAmountText(text)
                  const paise = rupeesToPaise(text)
                  setProposed({ amountPaise: text.trim() === '' ? null : paise !== null && paise > 0 ? paise : 0 })
                }}
                className="h-8 pl-6 text-[13.5px] tabular-nums"
              />
            </div>
          )}
          {err.amount
            ? <FieldError id={`${ids.amount}-error`} text={err.amount} />
            : !readOnly && <p id={`${ids.amount}-hint`} className="text-[12px] text-muted-foreground">{amountHint}</p>}
        </div>

        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.starts} className={FIELD_LABEL}>Starts on</Label>
          {readOnly ? (
            <p id={ids.starts} className="text-[13.5px]">{formatDate(proposed.startsOn)}</p>
          ) : (
            <Input
              id={ids.starts}
              type="date"
              min={preview.yearStartsOn}
              max={preview.yearEndsOn}
              value={proposed.startsOn}
              aria-invalid={!!err.starts || undefined}
              aria-describedby={err.starts ? `${ids.starts}-error` : undefined}
              onChange={(event) => setProposed({ startsOn: event.target.value })}
              className="h-8 text-[13px]"
            />
          )}
          <FieldError id={`${ids.starts}-error`} text={err.starts} />
        </div>

        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.ends} className={FIELD_LABEL}>Ends on (optional)</Label>
          {readOnly ? (
            <p id={ids.ends} className="text-[13.5px]">{proposed.endsOn ? formatDate(proposed.endsOn) : 'End of the year'}</p>
          ) : (
            <Input
              id={ids.ends}
              type="date"
              min={proposed.startsOn || preview.yearStartsOn}
              max={preview.yearEndsOn}
              value={proposed.endsOn ?? ''}
              aria-invalid={!!err.ends || undefined}
              aria-describedby={err.ends ? `${ids.ends}-error` : undefined}
              onChange={(event) => setProposed({ endsOn: event.target.value === '' ? null : event.target.value })}
              className="h-8 text-[13px]"
            />
          )}
          <FieldError id={`${ids.ends}-error`} text={err.ends} />
        </div>
      </div>
    </div>
  )
}
