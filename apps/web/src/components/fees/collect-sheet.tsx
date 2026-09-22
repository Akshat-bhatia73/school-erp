/**
 * Taking a fee payment.
 *
 * The sheet opens with one line per fee that still has a balance, because that is what an office
 * actually collects; a line can be changed or dropped. The receipt number is never sent: the
 * server takes the next one from the school's own counter for the academic year.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { FeeCollectRequest, type FeePaymentMode } from '@erp/contracts'
import { Field, RupeeInput, paiseToRupeeText, todayIso } from '@/components/fees/fee-form'
import { PAYMENT_MODES, PAYMENT_MODE_LABEL } from '@/components/fees/labels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { formatPaise, rupeesToPaise } from '@/lib/utils'
import { FORM_ERROR, fieldErrors, focusFirstInvalid, type FieldLabels } from '@/lib/validation'

const LABELS: FieldLabels = {
  mode: { label: 'payment mode', kind: 'select' },
  reference: 'reference number',
  receivedOn: { label: 'date', kind: 'date' },
  payerName: 'name of the person paying',
  lines: { label: 'fee', kind: 'list' },
}

export interface CollectableLine {
  feeHeadId: string
  name: string
  balancePaise: number
}

interface DraftLine {
  feeHeadId: string
  name: string
  /** Rupees as typed. */
  text: string
}

export function CollectSheet({ open, onOpenChange, studentId, studentName, academicYearId, lines }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  studentId: string
  studentName: string
  academicYearId: string
  lines: CollectableLine[]
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<DraftLine[]>(() =>
    lines.map((line) => ({ feeHeadId: line.feeHeadId, name: line.name, text: line.balancePaise > 0 ? paiseToRupeeText(line.balancePaise) : '' })),
  )
  const [mode, setMode] = useState<FeePaymentMode>('cash')
  const [reference, setReference] = useState('')
  const [receivedOn, setReceivedOn] = useState(todayIso())
  const [payerName, setPayerName] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const collect = useMutation({
    mutationFn: (body: Parameters<typeof api.fees.collect>[2]) => api.fees.collect(schoolId, studentId, body),
    onSuccess: (receipt) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'fees'] })
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
      toast.success(`Receipt ${receipt.receiptNumber} saved`)
      onOpenChange(false)
      void navigate({ to: '/fees/receipts/$receiptId', params: { receiptId: receipt.id } })
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const total = draft.reduce((sum, line) => sum + (rupeesToPaise(line.text) ?? 0), 0)

  const submit = () => {
    const found: Record<string, string> = {}
    const parsedLines: Array<{ feeHeadId: string; amountPaise: number }> = []
    draft.forEach((line, index) => {
      // A fee left blank is simply not being paid today.
      if (line.text.trim() === '') return
      const paise = rupeesToPaise(line.text)
      if (paise === null || paise <= 0) {
        found[`line-${index}`] = 'Enter an amount in rupees'
        return
      }
      parsedLines.push({ feeHeadId: line.feeHeadId, amountPaise: paise })
    })
    if (parsedLines.length === 0 && Object.keys(found).length === 0) found[FORM_ERROR] = 'Enter an amount against at least one fee.'
    // Cash needs nothing to look up later; every other mode leaves a trail the office must record.
    if (mode !== 'cash' && reference.trim() === '') found.reference = 'Enter the reference number'
    if (Object.keys(found).length > 0) {
      setErrors(found)
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }

    const parsed = FeeCollectRequest.safeParse({
      academicYearId,
      lines: parsedLines,
      mode,
      reference: reference.trim() === '' ? undefined : reference.trim(),
      receivedOn,
      payerName: payerName.trim() === '' ? undefined : payerName.trim(),
    })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, LABELS))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    collect.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Collect fee</SheetTitle>
          <SheetDescription>What {studentName} is paying today. The receipt number is added when it is saved.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 scrollbar-thin">
          {draft.length === 0 ? (
            <p className="text-[13.5px] text-muted-foreground">Nothing is due right now. Close this and use Adjust to add a charge first.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {draft.map((line, index) => (
                <div key={line.feeHeadId} className="flex items-end gap-2">
                  <RupeeInput
                    className="flex-1"
                    label={line.name}
                    value={line.text}
                    error={errors[`line-${index}`]}
                    onChange={(text) => setDraft((old) => old.map((row, i) => (i === index ? { ...row, text } : row)))}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${line.name}`}
                    onClick={() => setDraft((old) => old.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="Payment mode" error={errors.mode}>
              <Select value={mode} onValueChange={(value) => setMode(value as FeePaymentMode)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>{PAYMENT_MODES.map((option) => <SelectItem key={option} value={option}>{PAYMENT_MODE_LABEL[option]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Date" error={errors.receivedOn}>
              <Input type="date" value={receivedOn} onChange={(event) => setReceivedOn(event.target.value)} />
            </Field>
            <Field
              label={mode === 'cash' ? 'Reference (optional)' : 'Reference'}
              error={errors.reference}
              hint={mode === 'cheque' ? 'Cheque number' : mode === 'upi' ? 'UPI transaction id' : undefined}
            >
              <Input value={reference} onChange={(event) => setReference(event.target.value)} />
            </Field>
            <Field label="Paid by" error={errors.payerName}>
              <Input value={payerName} onChange={(event) => setPayerName(event.target.value)} placeholder="Who handed it over" />
            </Field>
          </div>
          {errors[FORM_ERROR] && <p className="mt-3 text-[12px] text-destructive">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row items-center justify-between gap-2">
          <span className="text-[13.5px]">Total <span className="font-semibold tabular-nums">{formatPaise(total)}</span></span>
          <span className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} disabled={collect.isPending || draft.length === 0}>{collect.isPending ? 'Saving…' : 'Save receipt'}</Button>
          </span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
