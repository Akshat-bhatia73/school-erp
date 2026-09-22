/**
 * The two things that can happen to a payment after it is taken.
 *
 * A receipt is never edited. Sending money back is a refund, and a payment that never really
 * happened is cancelled; both are new entries in the ledger that point at the original.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import { FeeCancelRequest, FeeRefundRequest, type FeePaymentMode } from '@erp/contracts'
import { Field, RupeeInput, paiseToRupeeText, todayIso } from '@/components/fees/fee-form'
import { PAYMENT_MODES, PAYMENT_MODE_LABEL } from '@/components/fees/labels'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { FeeReceiptDetailRecord } from '@/lib/api/fees'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { formatPaise, rupeesToPaise } from '@/lib/utils'
import { FORM_ERROR, fieldErrors, focusFirstInvalid, type FieldLabels } from '@/lib/validation'

const REFUND_LABELS: FieldLabels = {
  mode: { label: 'refund mode', kind: 'select' },
  reference: 'reference number',
  refundedOn: { label: 'date', kind: 'date' },
  reason: 'reason',
}

function useFeeInvalidate() {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'fees'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
  }
}

/** Sending money back. Each line is capped at what the payment itself carried. */
export function RefundSheet({ open, onOpenChange, receipt }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  receipt: FeeReceiptDetailRecord
}) {
  const { schoolId } = useSchoolContext()
  const invalidate = useFeeInvalidate()
  const [amounts, setAmounts] = useState<string[]>(() => receipt.lines.map((line) => paiseToRupeeText(line.amountPaise)))
  const [mode, setMode] = useState<FeePaymentMode>(receipt.mode ?? 'cash')
  const [reference, setReference] = useState('')
  const [refundedOn, setRefundedOn] = useState(todayIso())
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const refund = useMutation({
    mutationFn: (body: Parameters<typeof api.fees.refund>[2]) => api.fees.refund(schoolId, receipt.id, body),
    onSuccess: (created) => {
      invalidate()
      toast.success(`Refund ${created.receiptNumber} saved`)
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const found: Record<string, string> = {}
    const lines: Array<{ feeHeadId: string; amountPaise: number }> = []
    receipt.lines.forEach((line, index) => {
      const text = amounts[index] ?? ''
      if (text.trim() === '') return
      const paise = rupeesToPaise(text)
      if (paise === null || paise <= 0) {
        found[`line-${index}`] = 'Enter an amount in rupees'
        return
      }
      if (paise > line.amountPaise) {
        found[`line-${index}`] = `At most ${formatPaise(line.amountPaise)}`
        return
      }
      lines.push({ feeHeadId: line.head.id, amountPaise: paise })
    })
    if (lines.length === 0 && Object.keys(found).length === 0) found[FORM_ERROR] = 'Enter at least one amount to refund.'
    if (mode !== 'cash' && reference.trim() === '') found.reference = 'Enter the reference number'
    if (Object.keys(found).length > 0) {
      setErrors(found)
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }

    const parsed = FeeRefundRequest.safeParse({
      lines,
      mode,
      reference: reference.trim() === '' ? undefined : reference.trim(),
      refundedOn,
      reason: reason.trim(),
    })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, REFUND_LABELS))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    refund.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Refund {receipt.receiptNumber}</SheetTitle>
          <SheetDescription>A refund is a new entry. The original receipt is left exactly as it was.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 scrollbar-thin">
          <div className="flex flex-col gap-3">
            {receipt.lines.map((line, index) => (
              <RupeeInput
                key={line.head.id}
                label={`${line.head.name} (paid ${formatPaise(line.amountPaise)})`}
                value={amounts[index] ?? ''}
                error={errors[`line-${index}`]}
                onChange={(text) => setAmounts((old) => old.map((row, i) => (i === index ? text : row)))}
              />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="Refund mode" error={errors.mode}>
              <Select value={mode} onValueChange={(value) => setMode(value as FeePaymentMode)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{PAYMENT_MODES.map((option) => <SelectItem key={option} value={option}>{PAYMENT_MODE_LABEL[option]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Date" error={errors.refundedOn}>
              <Input type="date" value={refundedOn} onChange={(event) => setRefundedOn(event.target.value)} />
            </Field>
            <Field label={mode === 'cash' ? 'Reference (optional)' : 'Reference'} error={errors.reference}>
              <Input value={reference} onChange={(event) => setReference(event.target.value)} />
            </Field>
            <Field label="Reason" className="col-span-2" hint="Kept in the audit log only." error={errors.reason}>
              <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
            </Field>
          </div>
          {errors[FORM_ERROR] && <p className="mt-3 text-[12px] text-destructive">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={refund.isPending}>{refund.isPending ? 'Saving…' : 'Save refund'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** A payment that never really happened: a bounced cheque, or a slip of the hand. */
export function CancelReceiptDialog({ open, onOpenChange, receipt }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  receipt: FeeReceiptDetailRecord
}) {
  const { schoolId } = useSchoolContext()
  const invalidate = useFeeInvalidate()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const cancel = useMutation({
    mutationFn: (body: Parameters<typeof api.fees.cancel>[2]) => api.fees.cancel(schoolId, receipt.id, body),
    onSuccess: () => {
      invalidate()
      toast.success('Receipt cancelled')
      onOpenChange(false)
    },
    onError: (failure) => setError(describeError(failure)),
  })

  const submit = () => {
    const parsed = FeeCancelRequest.safeParse({ reason: reason.trim() })
    if (!parsed.success) {
      setError('Say why this receipt is being cancelled.')
      return
    }
    setError(null)
    cancel.mutate(parsed.data)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel receipt {receipt.receiptNumber}?</AlertDialogTitle>
          <AlertDialogDescription>
            The receipt stays in the ledger and a cancellation entry is written against it. What was paid goes back to being due.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field label="Reason" error={error ?? undefined}>
          <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <Button variant="destructive" disabled={cancel.isPending} onClick={submit}>Cancel receipt</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
