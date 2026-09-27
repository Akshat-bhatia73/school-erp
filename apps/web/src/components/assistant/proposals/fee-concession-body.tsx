/**
 * A concession inside a change card: the pupil and the fee (or every fee) are fixed; the kind of
 * concession, a percentage or a fixed amount off each instalment, and the value are edited here,
 * with roughly what it takes off this year and the concessions the pupil has already. The reason
 * the route needs is asked under this, as a correction's is.
 */
import type { FeeConcessionPreview } from '@erp/contracts'
import { useState } from 'react'
import { paiseToRupeeText } from '@/components/fees/fee-form'
import { CONCESSION_CATEGORIES, CONCESSION_CATEGORY_LABEL } from '@/components/fees/labels'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { FieldErrors } from '@/lib/validation'
import { formatPaise, rupeesToPaise } from '@/lib/utils'
import { bpToPercentText, concessionEstimate, percentToBp } from './model'
import { FIELD_LABEL, FieldError, PupilLine } from './parts'

type Proposed = FeeConcessionPreview['proposed']
type Kind = Proposed['kind']

const KIND_LABEL: Record<Kind, string> = { percent: 'Percentage', amount: 'Fixed amount per instalment' }

/** "Sibling: 10% off Tuition" or "Staff child: ₹500 off each instalment of every fee". */
function existingText(row: FeeConcessionPreview['existing'][number]): string {
  const what = row.kind === 'percent' && row.percentBp !== null
    ? `${bpToPercentText(row.percentBp)}% off`
    : row.amountPaise !== null ? `${formatPaise(row.amountPaise)} off each instalment of` : 'off'
  return `${CONCESSION_CATEGORY_LABEL[row.category]}: ${what} ${row.headName ?? 'every fee'}`
}

export function FeeConcessionBody({ preview, onChange, errors, readOnly, idBase }: {
  preview: FeeConcessionPreview
  onChange: (next: FeeConcessionPreview) => void
  errors: FieldErrors
  readOnly: boolean
  /** Unique to the card, so two cards on one answer never share a label target. */
  idBase: string
}) {
  const { proposed } = preview
  // The boxes keep what was typed; the preview holds basis points or paise, or null while it is not a value yet.
  const [percentText, setPercentText] = useState(() => (proposed.percentBp !== null ? bpToPercentText(proposed.percentBp) : ''))
  const [amountText, setAmountText] = useState(() => (proposed.amountPaise !== null && proposed.amountPaise > 0 ? paiseToRupeeText(proposed.amountPaise) : ''))
  const ids = { category: `${idBase}-category`, kind: `${idBase}-kind`, value: `${idBase}-value` }
  const setProposed = (change: Partial<Proposed>) => onChange({ ...preview, proposed: { ...proposed, ...change } })

  const percentFrom = (text: string) => percentToBp(text)
  const amountFrom = (text: string) => {
    const paise = rupeesToPaise(text)
    return paise !== null && paise > 0 ? paise : null
  }
  // A fixed amount is only ever off a named fee; a percentage may cover every fee.
  const kinds: Kind[] = preview.head ? ['percent', 'amount'] : ['percent']
  const chooseKind = (kind: Kind) => {
    if (kind === 'percent') setProposed({ kind, percentBp: percentFrom(percentText), amountPaise: null })
    else setProposed({ kind, percentBp: null, amountPaise: amountFrom(amountText) })
  }

  const valueError = proposed.kind === 'percent' ? errors['proposed.percentBp'] : errors['proposed.amountPaise']
  const estimate = concessionEstimate(preview)
  const value = proposed.kind === 'percent'
    ? (proposed.percentBp !== null ? `${bpToPercentText(proposed.percentBp)}%` : '—')
    : (proposed.amountPaise !== null ? formatPaise(proposed.amountPaise) : '—')

  return (
    <div>
      <PupilLine label={preview.studentLabel} year={preview.academicYearName}>
        <span className="text-muted-foreground">{preview.head ? preview.head.name : 'Every fee'}</span>
      </PupilLine>

      <div className="grid gap-3 px-3.5 py-3 sm:grid-cols-3">
        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.category} className={FIELD_LABEL}>Kind of concession</Label>
          <Select value={proposed.category} disabled={readOnly} onValueChange={(next) => setProposed({ category: next as Proposed['category'] })}>
            <SelectTrigger id={ids.category} size="sm" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CONCESSION_CATEGORIES.map((key) => <SelectItem key={key} value={key}>{CONCESSION_CATEGORY_LABEL[key]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.kind} className={FIELD_LABEL}>How it is worked out</Label>
          {kinds.length === 1 ? (
            <p id={ids.kind} className="flex h-8 items-center text-[13.5px]">{KIND_LABEL[proposed.kind]}</p>
          ) : (
            <Select value={proposed.kind} disabled={readOnly} onValueChange={(next) => chooseKind(next as Kind)}>
              <SelectTrigger id={ids.kind} size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {kinds.map((kind) => <SelectItem key={kind} value={kind}>{KIND_LABEL[kind]}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.value} className={FIELD_LABEL}>{proposed.kind === 'percent' ? 'Percentage' : 'Amount off each instalment'}</Label>
          {readOnly ? (
            <p id={ids.value} className="text-[13.5px] font-medium tabular-nums">{value}</p>
          ) : (
            <div className="relative">
              <span aria-hidden className={`pointer-events-none absolute inset-y-0 flex items-center text-[13px] text-muted-foreground ${proposed.kind === 'percent' ? 'right-2.5' : 'left-2.5'}`}>
                {proposed.kind === 'percent' ? '%' : '₹'}
              </span>
              <Input
                id={ids.value}
                inputMode="decimal"
                placeholder={proposed.kind === 'percent' ? '25' : '0'}
                value={proposed.kind === 'percent' ? percentText : amountText}
                aria-invalid={!!valueError || undefined}
                aria-describedby={valueError ? `${ids.value}-error` : undefined}
                onChange={(event) => {
                  const text = event.target.value
                  if (proposed.kind === 'percent') {
                    setPercentText(text)
                    setProposed({ percentBp: percentFrom(text) })
                  } else {
                    setAmountText(text)
                    setProposed({ amountPaise: amountFrom(text) })
                  }
                }}
                className={`h-8 text-[13.5px] tabular-nums ${proposed.kind === 'percent' ? 'pr-6' : 'pl-6'}`}
              />
            </div>
          )}
          <FieldError id={`${ids.value}-error`} text={valueError} />
        </div>
      </div>

      <div className="grid gap-1.5 border-t px-3.5 py-2.5 text-[13px]">
        <p>
          {estimate > 0 ? <>About <span className="font-medium tabular-nums">{formatPaise(estimate)}</span> off this year.</> : <span className="text-muted-foreground">Enter a value to see what it takes off this year.</span>}
        </p>
        {preview.existing.length > 0 && (
          <div className="text-muted-foreground">
            <p>Already has {preview.existing.length === 1 ? 'a concession' : `${preview.existing.length} concessions`}; they add up:</p>
            <ul className="mt-1 grid gap-0.5 pl-4 [list-style:disc]">
              {preview.existing.map((row, i) => <li key={i}>{existingText(row)}</li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
