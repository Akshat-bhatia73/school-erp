import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AcademicYearInput, AcademicYearStatus, type AcademicYear } from '@erp/shared'
import { api } from '@/api/client'
import { Field, validate, type FieldErrors } from '@/components/setup/field'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { qk } from '@/lib/query'
import { humanize } from '@/lib/utils'

function blank(): AcademicYearInput {
  const y = new Date().getFullYear()
  return { name: `${y}-${String((y + 1) % 100).padStart(2, '0')}`, startDate: `${y}-04-01`, endDate: `${y + 1}-03-31`, status: 'upcoming' }
}

export function AcademicYearSheet({ open, onOpenChange, year }: { open: boolean; onOpenChange: (v: boolean) => void; year?: AcademicYear }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<AcademicYearInput>(blank)
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(year ? { name: year.name, startDate: year.startDate, endDate: year.endDate, status: year.status } : blank())
  }, [open, year])

  const save = useMutation({
    mutationFn: (input: AcademicYearInput) => (year ? api.academicYears.update(year.id, input) : api.academicYears.create(input)),
    onSuccess: (y) => {
      qc.invalidateQueries({ queryKey: qk.academicYears })
      toast.success(year ? `Saved ${y.name}` : `Added academic year ${y.name}`)
      onOpenChange(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const set = <K extends keyof AcademicYearInput>(k: K, v: AcademicYearInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  function submit() {
    const res = validate(AcademicYearInput, form)
    if (!res.ok) return setErrors(res.errors)
    if (res.data.endDate <= res.data.startDate) return setErrors({ endDate: 'End date must be after the start date' })
    setErrors({})
    save.mutate(res.data)
  }

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={year ? `Edit ${year.name}` : 'Add academic year'}
      description="Indian academic years run April to March."
      submitLabel={year ? 'Save changes' : 'Add year'}
      onSubmit={submit}
      busy={save.isPending}
    >
      <Field label="Name" error={errors.name} hint="Like 2027-28">
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="2027-28" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" error={errors.startDate}><Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="End date" error={errors.endDate}><Input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} /></Field>
      </div>
      <Field label="Status" error={errors.status}>
        <Select value={form.status} onValueChange={(v) => set('status', v as AcademicYearInput['status'])}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{AcademicYearStatus.options.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </FormSheet>
  )
}
