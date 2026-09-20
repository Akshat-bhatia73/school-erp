import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { GradeInput, SetupGradeUpdateRequest } from '@erp/contracts'
import { Field, FORM_ERROR, validate, type FieldErrors } from '@/components/setup/field'
import { focusFirstInvalid, type FieldLabels } from '@/lib/validation'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { GradeRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const NONE = '__none__'
const STREAMS = ['science', 'commerce', 'arts'] as const

interface Form { name: string; shortName: string; order: number; stream?: (typeof STREAMS)[number] }

const LABELS: FieldLabels = {
  name: 'class name',
  shortName: 'short name',
  order: { label: 'order', kind: 'number' },
  stream: { label: 'stream', kind: 'select' },
}

export function GradeSheet({ open, onOpenChange, grade, nextOrder }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  grade?: GradeRecord
  nextOrder: number
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Form>({ name: '', shortName: '', order: nextOrder })
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(grade
      ? { name: grade.name, shortName: grade.shortName, order: grade.order, stream: grade.stream }
      : { name: '', shortName: '', order: nextOrder })
  }, [open, grade, nextOrder])

  const save = useMutation({
    mutationFn: (input: Form) =>
      grade
        ? api.setup.updateGrade(schoolId, grade.id, { ...input, expectedVersion: grade.version })
        : api.setup.createGrade(schoolId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.grades(schoolId) })
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  function submit() {
    const checked = grade
      ? validate(SetupGradeUpdateRequest, { ...form, expectedVersion: grade.version }, LABELS)
      : validate(GradeInput, form, LABELS)
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
      title={grade ? `Edit ${grade.name}` : 'Add class'}
      description="Classes are ordered from Nursery upwards."
      submitLabel={grade ? 'Save changes' : 'Add class'}
      onSubmit={submit}
      busy={save.isPending}
      formError={errors[FORM_ERROR]}
    >
      <Field label="Class name" error={errors.name} hint="Like Class 6"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Short name" error={errors.shortName} hint="Like 6"><Input value={form.shortName} onChange={(e) => set('shortName', e.target.value)} /></Field>
        <Field label="Order" error={errors.order}><Input inputMode="numeric" value={form.order} onChange={(e) => set('order', Number(e.target.value) || 0)} /></Field>
      </div>
      <Field label="Stream" error={errors.stream} hint="Only for Class 11 and 12">
        <Select value={form.stream ?? NONE} onValueChange={(v) => set('stream', v === NONE ? undefined : (v as Form['stream']))}>
          <SelectTrigger className="w-full"><SelectValue placeholder="None" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>None</SelectItem>
            {STREAMS.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
    </FormSheet>
  )
}
