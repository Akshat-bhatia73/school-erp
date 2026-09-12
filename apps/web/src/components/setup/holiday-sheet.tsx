import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { HolidayInput, HolidayType, type Holiday } from '@erp/shared'
import { api } from '@/api/client'
import { Field, validate, type FieldErrors } from '@/components/setup/field'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { humanize } from '@/lib/utils'

export function HolidaySheet({ open, onOpenChange, holiday, academicYearId }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  holiday?: Holiday
  academicYearId: string
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<HolidayInput>({ academicYearId, name: '', startDate: '', endDate: '', type: 'festival' })
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(holiday
      ? { academicYearId: holiday.academicYearId, name: holiday.name, startDate: holiday.startDate, endDate: holiday.endDate, type: holiday.type }
      : { academicYearId, name: '', startDate: '', endDate: '', type: 'festival' })
  }, [open, holiday, academicYearId])

  const save = useMutation({
    mutationFn: (input: HolidayInput) => (holiday ? api.holidays.update(holiday.id, input) : api.holidays.create(input)),
    onSuccess: (h) => { qc.invalidateQueries({ queryKey: ['holidays'] }); toast.success(holiday ? `Saved ${h.name}` : `Added ${h.name}`); onOpenChange(false) },
    onError: (e: Error) => toast.error(e.message),
  })

  const set = <K extends keyof HolidayInput>(k: K, v: HolidayInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  function submit() {
    const next = { ...form, endDate: form.endDate || form.startDate }
    const res = validate(HolidayInput, next)
    if (!res.ok) return setErrors(res.errors)
    if (res.data.endDate < res.data.startDate) return setErrors({ endDate: 'End date cannot be before the start date' })
    setErrors({})
    save.mutate(res.data)
  }

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={holiday ? `Edit ${holiday.name}` : 'Add holiday'} submitLabel={holiday ? 'Save changes' : 'Add holiday'} onSubmit={submit} busy={save.isPending}>
      <Field label="Holiday name" error={errors.name}><Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Diwali" /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" error={errors.startDate}><Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="End date" error={errors.endDate} hint="Same as start for a single day"><Input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} /></Field>
      </div>
      <Field label="Type" error={errors.type}>
        <Select value={form.type} onValueChange={(v) => set('type', v as HolidayInput['type'])}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{HolidayType.options.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </FormSheet>
  )
}
