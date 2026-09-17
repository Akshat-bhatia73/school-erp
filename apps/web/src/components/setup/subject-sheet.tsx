import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SetupSubjectUpdateRequest, SubjectInput } from '@erp/contracts'
import { Field, FORM_ERROR, validate, type FieldErrors } from '@/components/setup/field'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { SubjectRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { humanize } from '@/lib/utils'

export const SUBJECT_TYPES = ['scholastic', 'co_scholastic', 'language', 'elective'] as const

interface Form { name: string; code: string; type: (typeof SUBJECT_TYPES)[number] }

export function SubjectSheet({ open, onOpenChange, subject }: { open: boolean; onOpenChange: (v: boolean) => void; subject?: SubjectRecord }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Form>({ name: '', code: '', type: 'scholastic' })
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(subject ? { name: subject.name, code: subject.code, type: subject.type } : { name: '', code: '', type: 'scholastic' })
  }, [open, subject])

  const save = useMutation({
    mutationFn: (input: Form) =>
      subject
        ? api.setup.updateSubject(schoolId, subject.id, { ...input, expectedVersion: subject.version })
        : api.setup.createSubject(schoolId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'subjects'] })
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  function submit() {
    const checked = subject
      ? validate(SetupSubjectUpdateRequest, { ...form, expectedVersion: subject.version })
      : validate(SubjectInput, form)
    if (!checked.ok) return setErrors(checked.errors)
    setErrors({})
    save.mutate(form)
  }

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={subject ? `Edit ${subject.name}` : 'Add subject'}
      submitLabel={subject ? 'Save changes' : 'Add subject'}
      onSubmit={submit}
      busy={save.isPending}
      formError={errors[FORM_ERROR]}
    >
      <Field label="Subject name" error={errors.name}><Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Mathematics" /></Field>
      <Field label="Code" error={errors.code} hint="Short code used on report cards">
        <Input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="MATH" className="font-mono" />
      </Field>
      <Field label="Type" error={errors.type}>
        <Select value={form.type} onValueChange={(v) => set('type', v as Form['type'])}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{SUBJECT_TYPES.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </FormSheet>
  )
}
