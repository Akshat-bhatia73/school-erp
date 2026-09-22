/**
 * The writes that belong to one pupil's fee account: an optional fee, a concession and an
 * adjustment. Each one asks for exactly what the contract carries and nothing more; a reason
 * somebody types goes to the audit note and is stored nowhere else.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  FeeAdjustmentRequest,
  FeeConcessionCreateRequest,
  FeeConcessionRemoveRequest,
  FeeOptInCreateRequest,
  FeeOptInUpdateRequest,
} from '@erp/contracts'
import { Field, RupeeInput, paiseToRupeeText, todayIso } from '@/components/fees/fee-form'
import { CONCESSION_CATEGORIES, CONCESSION_CATEGORY_LABEL, type ConcessionCategoryKey } from '@/components/fees/labels'
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
import type { FeeConcessionRecord, FeeOptInRecord } from '@/lib/api/fees'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { rupeesToPaise } from '@/lib/utils'
import { FORM_ERROR, fieldErrors, focusFirstInvalid, type FieldLabels } from '@/lib/validation'

type Errors = Record<string, string>

/** Everything a fee write changes: the statement, the dues list, the ledger and the dashboard. */
function useFeeInvalidate() {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'fees'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
  }
}

/** The heads a screen may offer, read only while a sheet that needs them is open. */
function useHeadOptions(enabled: boolean) {
  const { schoolId } = useSchoolContext()
  const { data } = useQuery({
    queryKey: qk.feeHeads(schoolId),
    queryFn: () => api.fees.heads(schoolId),
    enabled,
  })
  return data ?? []
}

// ---------------------------------------------------------------------------

const OPT_IN_LABELS: FieldLabels = {
  feeHeadId: { label: 'fee', kind: 'select' },
  amountPaise: { label: 'amount', kind: 'number' },
  startsOn: { label: 'start date', kind: 'date' },
  endsOn: { label: 'end date', kind: 'date' },
}

/** Adding an optional fee to one pupil, or changing the one they already have. */
export function OptInSheet({ open, onOpenChange, studentId, academicYearId, optIn }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  studentId: string
  academicYearId: string
  /** Given when an existing optional fee is being changed. */
  optIn?: FeeOptInRecord
}) {
  const { schoolId } = useSchoolContext()
  const invalidate = useFeeInvalidate()
  const heads = useHeadOptions(open && optIn === undefined)
  const [feeHeadId, setFeeHeadId] = useState('')
  const [amount, setAmount] = useState(optIn?.amountPaise !== undefined ? paiseToRupeeText(optIn.amountPaise) : '')
  const [startsOn, setStartsOn] = useState(optIn?.startsOn ?? todayIso())
  const [endsOn, setEndsOn] = useState(optIn?.endsOn ?? '')
  const [errors, setErrors] = useState<Errors>({})

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      optIn
        ? api.fees.updateOptIn(schoolId, optIn.id, body as Parameters<typeof api.fees.updateOptIn>[2])
        : api.fees.addOptIn(schoolId, studentId, body as Parameters<typeof api.fees.addOptIn>[2]),
    onSuccess: () => {
      invalidate()
      toast.success(optIn ? 'Optional fee updated' : 'Optional fee added')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    let amountPaise: number | undefined
    if (amount.trim() !== '') {
      const parsedAmount = rupeesToPaise(amount)
      if (parsedAmount === null || parsedAmount <= 0) {
        setErrors({ amountPaise: 'Enter an amount in rupees' })
        requestAnimationFrame(() => focusFirstInvalid())
        return
      }
      amountPaise = parsedAmount
    }
    const parsed = optIn
      ? FeeOptInUpdateRequest.safeParse({
          amountPaise: amountPaise ?? null,
          endsOn: endsOn === '' ? null : endsOn,
          expectedVersion: optIn.version,
        })
      : FeeOptInCreateRequest.safeParse({
          academicYearId,
          feeHeadId,
          amountPaise,
          startsOn,
          endsOn: endsOn === '' ? undefined : endsOn,
        })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, OPT_IN_LABELS))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data as Record<string, unknown>)
  }

  const optional = heads.filter((head) => head.appliesTo === 'opt_in' && head.active)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{optIn ? `Edit ${optIn.head.name}` : 'Add optional fee'}</SheetTitle>
          <SheetDescription>A fee only this pupil is charged, such as transport or hostel.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 content-start gap-3 overflow-y-auto px-4 scrollbar-thin">
          {optIn ? (
            <p className="text-[13px] text-muted-foreground">{optIn.head.name}, from {optIn.startsOn}.</p>
          ) : (
            <Field label="Fee" error={errors.feeHeadId}>
              <Select value={feeHeadId || undefined} onValueChange={setFeeHeadId}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Choose a fee" /></SelectTrigger>
                <SelectContent>{optional.map((head) => <SelectItem key={head.id} value={head.id}>{head.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
          )}
          <RupeeInput
            label="Amount for this pupil"
            hint="Leave empty to charge the class amount."
            value={amount}
            error={errors.amountPaise}
            onChange={setAmount}
          />
          {!optIn && (
            <Field label="Starts on" error={errors.startsOn}>
              <Input type="date" value={startsOn} onChange={(event) => setStartsOn(event.target.value)} />
            </Field>
          )}
          <Field label="Ends on" hint="Leave empty while the pupil still takes it." error={errors.endsOn}>
            <Input type="date" value={endsOn} onChange={(event) => setEndsOn(event.target.value)} />
          </Field>
          {errors[FORM_ERROR] && <p className="text-[12px] text-destructive">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------

const CONCESSION_LABELS: FieldLabels = {
  feeHeadId: { label: 'fee', kind: 'select' },
  category: { label: 'kind of concession', kind: 'select' },
  percentBp: { label: 'percentage', kind: 'number' },
  amountPaise: { label: 'amount', kind: 'number' },
  reason: 'reason',
}

/** A discount on what this pupil is charged: a percentage, or a fixed amount off one fee. */
export function ConcessionSheet({ open, onOpenChange, studentId, academicYearId }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  studentId: string
  academicYearId: string
}) {
  const { schoolId } = useSchoolContext()
  const invalidate = useFeeInvalidate()
  const heads = useHeadOptions(open)
  const [kind, setKind] = useState<'percent' | 'amount'>('percent')
  const [feeHeadId, setFeeHeadId] = useState('')
  const [category, setCategory] = useState<ConcessionCategoryKey>('sibling')
  const [percent, setPercent] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Errors>({})

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.fees.addConcession>[2]) => api.fees.addConcession(schoolId, studentId, body),
    onSuccess: () => {
      invalidate()
      toast.success('Concession added')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    // A percentage is entered the way a person says it and travels as basis points.
    const percentBp = kind === 'percent' ? Math.round(Number(percent.replace(/[\s%]/g, '')) * 100) : undefined
    if (kind === 'percent' && (!Number.isFinite(percentBp) || percentBp === undefined || percentBp <= 0 || percentBp > 10_000)) {
      setErrors({ percentBp: 'Enter a percentage between 1 and 100' })
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    const amountPaise = kind === 'amount' ? rupeesToPaise(amount) : undefined
    if (kind === 'amount' && (amountPaise === null || amountPaise === undefined || amountPaise <= 0)) {
      setErrors({ amountPaise: 'Enter an amount in rupees' })
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    const parsed = FeeConcessionCreateRequest.safeParse({
      academicYearId,
      feeHeadId: feeHeadId === '' ? undefined : feeHeadId,
      category,
      kind,
      percentBp,
      amountPaise,
      reason: reason.trim(),
    })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, CONCESSION_LABELS))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add concession</SheetTitle>
          <SheetDescription>What this family is charged less. An amount concession is always off one fee.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 content-start gap-3 overflow-y-auto px-4 scrollbar-thin">
          <Field label="How it is worked out">
            <Select value={kind} onValueChange={(value) => setKind(value as 'percent' | 'amount')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="percent">A percentage off</SelectItem>
                <SelectItem value="amount">A fixed amount off</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={kind === 'amount' ? 'Fee' : 'Fee (optional)'}
            error={errors.feeHeadId}
            hint={kind === 'percent' ? 'Leave empty to take it off every fee.' : undefined}
          >
            <Select value={feeHeadId || undefined} onValueChange={setFeeHeadId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Every fee" /></SelectTrigger>
              <SelectContent>{heads.map((head) => <SelectItem key={head.id} value={head.id}>{head.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {kind === 'percent' ? (
            <Field label="Percentage" error={errors.percentBp}>
              <Input inputMode="decimal" placeholder="25" value={percent} onChange={(event) => setPercent(event.target.value)} />
            </Field>
          ) : (
            <RupeeInput label="Amount off each instalment" value={amount} error={errors.amountPaise} onChange={setAmount} />
          )}
          <Field label="Kind of concession" error={errors.category}>
            <Select value={category} onValueChange={(value) => setCategory(value as ConcessionCategoryKey)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{CONCESSION_CATEGORIES.map((key) => <SelectItem key={key} value={key}>{CONCESSION_CATEGORY_LABEL[key]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Reason" hint="Kept in the audit log only." error={errors.reason}>
            <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {errors[FORM_ERROR] && <p className="text-[12px] text-destructive">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Add concession'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

/** Taking a concession away. The reason is required and goes to the audit note. */
export function RemoveConcessionDialog({ concession, onClose }: {
  concession: FeeConcessionRecord | null
  onClose: () => void
}) {
  const { schoolId } = useSchoolContext()
  const invalidate = useFeeInvalidate()
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const remove = useMutation({
    mutationFn: (body: Parameters<typeof api.fees.removeConcession>[2]) =>
      api.fees.removeConcession(schoolId, (concession as FeeConcessionRecord).id, body),
    onSuccess: () => {
      invalidate()
      toast.success('Concession removed')
      onClose()
    },
    onError: (failure) => setError(describeError(failure)),
  })

  const submit = () => {
    if (!concession) return
    const parsed = FeeConcessionRemoveRequest.safeParse({ reason: reason.trim(), expectedVersion: concession.version })
    if (!parsed.success) {
      setError('Say why this concession is being removed.')
      return
    }
    setError(null)
    remove.mutate(parsed.data)
  }

  return (
    <AlertDialog open={concession !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this concession?</AlertDialogTitle>
          <AlertDialogDescription>What has already been charged does not change. From now on the full fee applies.</AlertDialogDescription>
        </AlertDialogHeader>
        <Field label="Reason" error={error ?? undefined}>
          <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <Button variant="destructive" disabled={remove.isPending} onClick={submit}>Remove</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------

const ADJUSTMENT_LABELS: FieldLabels = {
  lines: { label: 'fee', kind: 'list' },
  reason: 'reason',
}

/** Waiving part of a fee, or adding a charge such as a fine. No money moves either way. */
export function AdjustmentSheet({ open, onOpenChange, studentId, academicYearId, heads: available }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  studentId: string
  academicYearId: string
  /** The fees this pupil is charged, named from their own statement. */
  heads: Array<{ id: string; name: string }>
}) {
  const { schoolId } = useSchoolContext()
  const invalidate = useFeeInvalidate()
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit')
  const [feeHeadId, setFeeHeadId] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState<Errors>({})

  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.fees.adjust>[2]) => api.fees.adjust(schoolId, studentId, body),
    onSuccess: () => {
      invalidate()
      toast.success(direction === 'credit' ? 'Waiver recorded' : 'Charge added')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const amountPaise = rupeesToPaise(amount)
    if (amountPaise === null || amountPaise <= 0) {
      setErrors({ amountPaise: 'Enter an amount in rupees' })
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    const parsed = FeeAdjustmentRequest.safeParse({
      academicYearId,
      direction,
      lines: feeHeadId === '' ? [] : [{ feeHeadId, amountPaise }],
      reason: reason.trim(),
    })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, ADJUSTMENT_LABELS))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Adjust what is due</SheetTitle>
          <SheetDescription>No money changes hands. This only changes what the family owes.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 content-start gap-3 overflow-y-auto px-4 scrollbar-thin">
          <Field label="What this does">
            <Select value={direction} onValueChange={(value) => setDirection(value as 'credit' | 'debit')}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="credit">Waive part of a fee</SelectItem>
                <SelectItem value="debit">Add a charge</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Fee" error={errors.lines}>
            <Select value={feeHeadId || undefined} onValueChange={setFeeHeadId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Choose a fee" /></SelectTrigger>
              <SelectContent>{available.map((head) => <SelectItem key={head.id} value={head.id}>{head.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <RupeeInput label="Amount" value={amount} error={errors.amountPaise} onChange={setAmount} />
          <Field label="Reason" hint="Kept in the audit log only." error={errors.reason}>
            <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
          </Field>
          {errors[FORM_ERROR] && <p className="text-[12px] text-destructive">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save'}</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
