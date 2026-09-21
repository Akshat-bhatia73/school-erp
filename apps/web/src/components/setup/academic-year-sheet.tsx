import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AcademicYearInput, SetupAcademicYearUpdateRequest } from '@erp/contracts'
import { Field, FORM_ERROR, validate, type FieldErrors } from '@/components/setup/field'
import { focusFirstInvalid, type FieldLabels } from '@/lib/validation'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { AcademicYearRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { humanize } from '@/lib/utils'

const STATUSES = ['upcoming', 'current', 'closed'] as const

interface Form { name: string; startDate: string; endDate: string; status: (typeof STATUSES)[number] }

const LABELS: FieldLabels = {
  name: 'academic year name',
  startDate: 'start date',
  endDate: 'end date',
  status: { label: 'status', kind: 'select' },
}

function blank(): Form {
  const year = new Date().getFullYear()
  return { name: `${year}-${String((year + 1) % 100).padStart(2, '0')}`, startDate: `${year}-04-01`, endDate: `${year + 1}-03-31`, status: 'upcoming' }
}

export function AcademicYearSheet({ open, onOpenChange, year }: { open: boolean; onOpenChange: (v: boolean) => void; year?: AcademicYearRecord }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Form>(blank)
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(year ? { name: year.name, startDate: year.startDate, endDate: year.endDate, status: year.status } : blank())
  }, [open, year])

  const save = useMutation({
    mutationFn: (input: Form & { expectedVersion?: number }) =>
      year
        ? api.setup.updateAcademicYear(schoolId, year.id, { ...input, expectedVersion: year.version })
        : api.setup.createAcademicYear(schoolId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.academicYears(schoolId) })
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  function submit() {
    const checked = year
      ? validate(SetupAcademicYearUpdateRequest, { ...form, expectedVersion: year.version }, LABELS)
      : validate(AcademicYearInput, form, LABELS)
    if (!checked.ok) {
      setErrors(checked.errors)
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(form)
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
      formError={errors[FORM_ERROR]}
    >
      <Field label="Name" error={errors.name} hint="Like 2027-28">
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="2027-28" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start date" error={errors.startDate}><Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>
        <Field label="End date" error={errors.endDate}><Input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} /></Field>
      </div>
      <Field label="Status" error={errors.status}>
        <Select value={form.status} onValueChange={(v) => set('status', v as Form['status'])}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUSES.map((s) => <SelectItem key={s} value={s}>{humanize(s)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </FormSheet>
  )
}
