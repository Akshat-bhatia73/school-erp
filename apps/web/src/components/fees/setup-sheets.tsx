/**
 * Fee setup: what the school charges, and how much.
 *
 * Who a fee applies to and how often it is charged are fixed once it exists, because changing
 * either would silently change what every pupil already owes, so an edit only offers the name,
 * the category and whether it is still in use.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  FeeHeadCreateRequest,
  FeeHeadUpdateRequest,
  FeeStructureCreateRequest,
  FeeStructureUpdateRequest,
  type FeeAppliesTo,
  type FeeFrequency,
  type FeeHeadCategory,
} from '@erp/contracts'
import { Field, RupeeInput, paiseToRupeeText } from '@/components/fees/fee-form'
import {
  APPLIES_TO, APPLIES_TO_LABEL, FREQUENCIES, FREQUENCY_LABEL,
  HEAD_CATEGORIES, HEAD_CATEGORY_LABEL,
} from '@/components/fees/labels'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import type { FeeHeadRecord, FeeStructureRecord } from '@/lib/api/fees'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { rupeesToPaise } from '@/lib/utils'
import { FORM_ERROR, fieldErrors, focusFirstInvalid, type FieldLabels } from '@/lib/validation'

const HEAD_LABELS: FieldLabels = {
  name: 'name',
  category: { label: 'category', kind: 'select' },
  appliesTo: { label: 'who pays it', kind: 'select' },
  frequency: { label: 'how often', kind: 'select' },
}

function useFeeInvalidate() {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  return () => void queryClient.invalidateQueries({ queryKey: [schoolId, 'fees'] })
}

export function FeeHeadSheet({ open, onOpenChange, head }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  head?: FeeHeadRecord
}) {
  const { schoolId } = useSchoolContext()
  const invalidate = useFeeInvalidate()
  const [name, setName] = useState(head?.name ?? '')
  const [category, setCategory] = useState<FeeHeadCategory>(head?.category ?? 'tuition')
  const [appliesTo, setAppliesTo] = useState<FeeAppliesTo>(head?.appliesTo ?? 'class')
  const [frequency, setFrequency] = useState<FeeFrequency>(head?.frequency ?? 'monthly')
  const [active, setActive] = useState(head?.active ?? true)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      head
        ? api.fees.updateHead(schoolId, head.id, body as Parameters<typeof api.fees.updateHead>[2])
        : api.fees.createHead(schoolId, body as Parameters<typeof api.fees.createHead>[1]),
    onSuccess: () => {
      invalidate()
      toast.success(head ? 'Saved changes' : 'Fee added')
      onOpenChange(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const parsed = head
      ? FeeHeadUpdateRequest.safeParse({ name: name.trim(), category, active, expectedVersion: head.version })
      : FeeHeadCreateRequest.safeParse({ name: name.trim(), category, appliesTo, frequency })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, HEAD_LABELS))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data as Record<string, unknown>)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{head ? `Edit ${head.name}` : 'Add fee'}</SheetTitle>
          <SheetDescription>The school's own name for something it charges, such as Tuition or Bus.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 content-start gap-3 overflow-y-auto px-4 scrollbar-thin">
          <Field label="Name" error={errors.name}>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="Category" error={errors.category}>
            <Select value={category} onValueChange={(value) => setCategory(value as FeeHeadCategory)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{HEAD_CATEGORIES.map((key) => <SelectItem key={key} value={key}>{HEAD_CATEGORY_LABEL[key]}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {head ? (
            <>
              <p className="text-[12.5px] text-muted-foreground">
                {APPLIES_TO_LABEL[head.appliesTo]} · {FREQUENCY_LABEL[head.frequency]}. Neither can change once pupils have been charged.
              </p>
              <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
                <span className="text-[13.5px]">Still in use</span>
                <Switch checked={active} onCheckedChange={setActive} aria-label="Still in use" />
              </div>
            </>
          ) : (
            <>
              <Field label="Who pays it" error={errors.appliesTo}>
                <Select value={appliesTo} onValueChange={(value) => setAppliesTo(value as FeeAppliesTo)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{APPLIES_TO.map((key) => <SelectItem key={key} value={key}>{APPLIES_TO_LABEL[key]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="How often" error={errors.frequency}>
                <Select value={frequency} onValueChange={(value) => setFrequency(value as FeeFrequency)}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{FREQUENCIES.map((key) => <SelectItem key={key} value={key}>{FREQUENCY_LABEL[key]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </>
          )}
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

const STRUCTURE_LABELS: FieldLabels = {
  feeHeadId: { label: 'fee', kind: 'select' },
  gradeId: { label: 'class', kind: 'select' },
  amountPaise: { label: 'amount', kind: 'number' },
}

/** How much one fee costs, for every class or for one. The amount is per instalment. */
export function FeeStructureSheet({ open, onOpenChange, academicYearId, structure }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  academicYearId: string
  structure?: FeeStructureRecord
}) {
  const { schoolId, hasPermission } = useSchoolContext()
  const invalidate = useFeeInvalidate()
  const [feeHeadId, setFeeHeadId] = useState('')
  const [gradeId, setGradeId] = useState('')
  const [amount, setAmount] = useState(structure ? paiseToRupeeText(structure.amountPaise) : '')
  const [errors, setErrors] = useState<Record<string, string>>({})

  const { data: heads = [] } = useQuery({
    queryKey: qk.feeHeads(schoolId),
    queryFn: () => api.fees.heads(schoolId),
    enabled: open && structure === undefined,
  })
  const { data: grades = [] } = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: open && structure === undefined && hasPermission('grades.read'),
  })

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      structure
        ? api.fees.updateStructure(schoolId, structure.id, body as Parameters<typeof api.fees.updateStructure>[2])
        : api.fees.createStructure(schoolId, body as Parameters<typeof api.fees.createStructure>[1]),
    onSuccess: () => {
      invalidate()
      toast.success('Amount saved')
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
    const parsed = structure
      ? FeeStructureUpdateRequest.safeParse({ amountPaise, expectedVersion: structure.version })
      : FeeStructureCreateRequest.safeParse({
          academicYearId,
          feeHeadId,
          gradeId: gradeId === '' ? undefined : gradeId,
          amountPaise,
        })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, STRUCTURE_LABELS))
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(parsed.data as Record<string, unknown>)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{structure ? `Edit ${structure.head.name}` : 'Set amount'}</SheetTitle>
          <SheetDescription>What one instalment of this fee costs in this academic year.</SheetDescription>
        </SheetHeader>
        <div className="grid flex-1 content-start gap-3 overflow-y-auto px-4 scrollbar-thin">
          {structure ? (
            <p className="text-[13px] text-muted-foreground">
              {structure.head.name} · {structure.grade?.name ?? 'Every class'} · {FREQUENCY_LABEL[structure.frequency]}
            </p>
          ) : (
            <>
              <Field label="Fee" error={errors.feeHeadId}>
                <Select value={feeHeadId || undefined} onValueChange={setFeeHeadId}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Choose a fee" /></SelectTrigger>
                  <SelectContent>{heads.filter((head) => head.active).map((head) => <SelectItem key={head.id} value={head.id}>{head.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Class" hint="Leave empty to charge every class the same." error={errors.gradeId}>
                <Select value={gradeId || undefined} onValueChange={setGradeId}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="Every class" /></SelectTrigger>
                  <SelectContent>{grades.map((grade) => <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </>
          )}
          <RupeeInput label="Amount per instalment" value={amount} error={errors.amountPaise} onChange={setAmount} />
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
