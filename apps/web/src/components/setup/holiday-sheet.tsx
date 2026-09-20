import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { HolidayInput, SetupHolidayUpdateRequest } from '@erp/contracts'
import { Field, FORM_ERROR, validate, type FieldErrors } from '@/components/setup/field'
import { focusFirstInvalid, type FieldLabels } from '@/lib/validation'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { HolidayRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { humanize } from '@/lib/utils'

export const HOLIDAY_TYPES = ['national', 'festival', 'school', 'vacation'] as const

interface Form { academicYearId: string; name: string; startDate: string; endDate: string; type: (typeof HOLIDAY_TYPES)[number] }

const LABELS: FieldLabels = {
  name: 'holiday name',
  startDate: 'start date',
  endDate: 'end date',
  type: { label: 'holiday type', kind: 'select' },
}

export function HolidaySheet({ open, onOpenChange, holiday, academicYearId }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  holiday?: HolidayRecord
  academicYearId: string
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Form>({ academicYearId, name: '', startDate: '', endDate: '', type: 'festival' })
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(holiday
      ? { academicYearId: holiday.academicYearId, name: holiday.name, startDate: holiday.startDate, endDate: holiday.endDate, type: holiday.type }
      : { academicYearId, name: '', startDate: '', endDate: '', type: 'festival' })
  }, [open, holiday, academicYearId])

  const save = useMutation({
    mutationFn: (input: Form) =>
      holiday
        ? api.setup.updateHoliday(schoolId, holiday.id, { ...input, expectedVersion: holiday.version })
        : api.setup.createHoliday(schoolId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'holidays'] })
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  function submit() {
    const next = { ...form, endDate: form.endDate || form.startDate }
    const checked = holiday
      ? validate(SetupHolidayUpdateRequest, { ...next, expectedVersion: holiday.version }, LABELS)
      : validate(HolidayInput, next, LABELS)
    if (!checked.ok) {
      setErrors(checked.errors)
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(next)
  }

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={holiday ? `Edit ${holiday.name}` : 'Add holiday'}
      submitLabel={holiday ? 'Save changes' : 'Add holiday'}
      onSubmit={submit}
      busy={save.isPending}
      formError={errors[FORM_ERROR]}
    >
      <Field label="Holiday name" error={errors.name}><Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Diwali" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" error={errors.startDate}><Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="End date" error={errors.endDate} hint="Same as start for a single day"><Input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} /></Field>
      </div>
      <Field label="Type" error={errors.type}>
        <Select value={form.type} onValueChange={(v) => set('type', v as Form['type'])}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{HOLIDAY_TYPES.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </FormSheet>
  )
}
