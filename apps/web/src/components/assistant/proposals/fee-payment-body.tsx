/**
 * A fee payment inside a change card: the pupil and year (fixed), a warning when a payment was
 * already recorded for them today, the amount, method, reference and who paid, and how the amount
 * splits across what is due, oldest due first, with the balance before and after. The split is
 * worked out here from the amount on every change, and again by the server on Confirm.
 */
import { splitFeePayment, type FeePaymentMode, type FeePaymentPreview } from '@erp/contracts'
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { paiseToRupeeText } from '@/components/fees/fee-form'
import { PAYMENT_MODE_LABEL, PAYMENT_MODES } from '@/components/fees/labels'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { FieldErrors } from '@/lib/validation'
import { cn, formatDate, formatPaise, rupeesToPaise } from '@/lib/utils'
import { overDueText } from './model'
import { CHANGED_ROW, FIELD_LABEL, FieldError, PupilLine } from './parts'

/** The counter screen's hint for each method's reference. */
const REFERENCE_HINT: Partial<Record<FeePaymentMode, string>> = { cheque: 'Cheque number', upi: 'UPI transaction id' }

/** "receipt R0042 for ₹5,000", joined for more than one. */
function paidTodayText(paid: FeePaymentPreview['paidToday']): string {
  const each = paid.map((row) => `receipt ${row.receiptNumber} for ${formatPaise(row.amountPaise)}`)
  return each.length <= 1 ? (each[0] ?? '') : `${each.slice(0, -1).join(', ')} and ${each.at(-1)}`
}

export function FeePaymentBody({ preview, onChange, errors, readOnly, idBase }: {
  preview: FeePaymentPreview
  onChange: (next: FeePaymentPreview) => void
  errors: FieldErrors
  readOnly: boolean
  /** Unique to the card, so two cards on one answer never share a label target. */
  idBase: string
}) {
  const { proposed } = preview
  // The box keeps what was typed; the preview holds paise, or 0 while it is not an amount yet.
  const [amountText, setAmountText] = useState(() => (proposed.amountPaise > 0 ? paiseToRupeeText(proposed.amountPaise) : ''))
  const ids = { amount: `${idBase}-amount`, mode: `${idBase}-mode`, reference: `${idBase}-reference`, payer: `${idBase}-payer` }
  const setProposed = (change: Partial<FeePaymentPreview['proposed']>) => onChange({ ...preview, proposed: { ...proposed, ...change } })

  const amount = proposed.amountPaise > 0 ? proposed.amountPaise : 0
  const split = amount > 0 ? splitFeePayment(amount, preview.dues) : []
  const share = new Map((split ?? []).map((line) => [line.feeHeadId, line.amountPaise]))
  // Too much is said as soon as it is typed, not only on Confirm.
  const amountError = errors['proposed.amountPaise'] ?? (split === null ? overDueText(preview) : undefined)
  const referenceError = errors['proposed.reference']
  const referenceHint = REFERENCE_HINT[proposed.mode]

  return (
    <div>
      <PupilLine label={preview.studentLabel} year={preview.academicYearName} />

      {preview.paidToday.length > 0 && (
        <div className="px-3.5 pt-3">
          <Alert className="py-2.5">
            <TriangleAlert className="text-tag-orange" />
            <AlertDescription className="text-[13px] text-foreground">
              Already recorded today: {paidTodayText(preview.paidToday)}. Check this is not the same payment.
            </AlertDescription>
          </Alert>
        </div>
      )}

      <div className="grid gap-3 px-3.5 py-3 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.amount} className={FIELD_LABEL}>Amount</Label>
          {readOnly ? (
            <p id={ids.amount} className="text-[13.5px] font-medium tabular-nums">{formatPaise(amount)}</p>
          ) : (
            <div className="relative">
              <span aria-hidden className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-[13px] text-muted-foreground">₹</span>
              <Input
                id={ids.amount}
                inputMode="decimal"
                placeholder="0"
                value={amountText}
                aria-invalid={!!amountError || undefined}
                aria-describedby={amountError ? `${ids.amount}-error` : undefined}
                onChange={(event) => {
                  const text = event.target.value
                  setAmountText(text)
                  const paise = rupeesToPaise(text)
                  setProposed({ amountPaise: paise !== null && paise > 0 ? paise : 0 })
                }}
                className="h-8 pl-6 text-[13.5px] tabular-nums"
              />
            </div>
          )}
          <FieldError id={`${ids.amount}-error`} text={amountError} />
        </div>

        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.mode} className={FIELD_LABEL}>Method</Label>
          <Select value={proposed.mode} disabled={readOnly} onValueChange={(value) => setProposed({ mode: value as FeePaymentMode })}>
            <SelectTrigger id={ids.mode} size="sm" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PAYMENT_MODES.map((mode) => <SelectItem key={mode} value={mode}>{PAYMENT_MODE_LABEL[mode]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.reference} className={FIELD_LABEL}>{proposed.mode === 'cash' ? 'Reference (optional)' : 'Reference'}</Label>
          {readOnly ? (
            <p id={ids.reference} className="text-[13.5px] break-words">{proposed.reference ?? '—'}</p>
          ) : (
            <Input
              id={ids.reference}
              maxLength={80}
              value={proposed.reference ?? ''}
              aria-invalid={!!referenceError || undefined}
              aria-describedby={referenceError ? `${ids.reference}-error` : referenceHint ? `${ids.reference}-hint` : undefined}
              onChange={(event) => setProposed({ reference: event.target.value.trim() === '' ? null : event.target.value })}
              className="h-8 text-[13.5px]"
            />
          )}
          {referenceError
            ? <FieldError id={`${ids.reference}-error`} text={referenceError} />
            : referenceHint && !readOnly && <p id={`${ids.reference}-hint`} className="text-[12px] text-muted-foreground">{referenceHint}</p>}
        </div>

        <div className="grid content-start gap-1.5">
          <Label htmlFor={ids.payer} className={FIELD_LABEL}>Paid by</Label>
          {readOnly ? (
            <p id={ids.payer} className="text-[13.5px] break-words">{proposed.payerName ?? '—'}</p>
          ) : (
            <Input
              id={ids.payer}
              maxLength={120}
              placeholder="Who handed it over"
              value={proposed.payerName ?? ''}
              onChange={(event) => setProposed({ payerName: event.target.value.trim() === '' ? null : event.target.value })}
              className="h-8 text-[13.5px]"
            />
          )}
        </div>
      </div>

      <table className="w-full border-separate border-spacing-0 border-t text-[13.5px]" aria-label="How the payment is split">
        <thead>
          <tr>
            <th className="h-9 border-b px-3 text-left text-[12px] font-medium text-muted-foreground">Fee</th>
            <th className="h-9 border-b border-l px-3 text-right text-[12px] font-medium text-muted-foreground">Due</th>
            <th className="h-9 border-b border-l px-3 text-right text-[12px] font-medium text-muted-foreground">This payment</th>
          </tr>
        </thead>
        <tbody>
          {preview.dues.map((due) => {
            const paid = share.get(due.feeHeadId) ?? 0
            return (
              <tr key={due.feeHeadId} className={cn(paid > 0 && CHANGED_ROW)}>
                <td className="h-10 border-b px-3">
                  <div className="min-w-0 truncate font-medium">{due.name}</div>
                  {due.oldestDueOn && <div className="truncate text-[12px] text-muted-foreground">Due since {formatDate(due.oldestDueOn)}</div>}
                </td>
                <td className="h-10 border-b border-l px-3 text-right tabular-nums">{formatPaise(due.balancePaise)}</td>
                <td className="h-10 border-b border-l px-3 text-right tabular-nums">{paid > 0 ? formatPaise(paid) : <span className="text-muted-foreground/60">—</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 px-3.5 py-2.5 text-[13px]">
        <dt className="text-muted-foreground">Balance before</dt>
        <dd className="text-right tabular-nums">{formatPaise(preview.balancePaise)}</dd>
        <dt className="text-muted-foreground">Balance after this payment</dt>
        <dd className="text-right font-medium tabular-nums">{formatPaise(preview.balancePaise - amount)}</dd>
      </dl>
    </div>
  )
}
