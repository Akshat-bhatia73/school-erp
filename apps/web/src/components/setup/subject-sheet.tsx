import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SubjectInput, SubjectType, type Subject } from '@erp/shared'
import { api } from '@/api/client'
import { Field, validate, type FieldErrors } from '@/components/setup/field'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { qk } from '@/lib/query'
import { humanize } from '@/lib/utils'

export function SubjectSheet({ open, onOpenChange, subject }: { open: boolean; onOpenChange: (v: boolean) => void; subject?: Subject }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<SubjectInput>({ name: '', code: '', type: 'scholastic' })
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(subject ? { name: subject.name, code: subject.code, type: subject.type } : { name: '', code: '', type: 'scholastic' })
  }, [open, subject])

  const save = useMutation({
    mutationFn: (input: SubjectInput) => (subject ? api.subjects.update(subject.id, input) : api.subjects.create(input)),
    onSuccess: (s) => { qc.invalidateQueries({ queryKey: qk.subjects }); toast.success(subject ? `Saved ${s.name}` : `Added ${s.name}`); onOpenChange(false) },
    onError: (e: Error) => toast.error(e.message),
  })

  const set = <K extends keyof SubjectInput>(k: K, v: SubjectInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  function submit() {
    const res = validate(SubjectInput, form)
    if (!res.ok) return setErrors(res.errors)
    setErrors({})
    save.mutate(res.data)
  }

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={subject ? `Edit ${subject.name}` : 'Add subject'} submitLabel={subject ? 'Save changes' : 'Add subject'} onSubmit={submit} busy={save.isPending}>
      <Field label="Subject name" error={errors.name}><Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="Mathematics" /></Field>
      <Field label="Code" error={errors.code} hint="Short code used on report cards">
        <Input value={form.code} onChange={(e) => set('code', e.target.value.toUpperCase())} placeholder="MATH" className="font-mono" />
      </Field>
      <Field label="Type" error={errors.type}>
        <Select value={form.type} onValueChange={(v) => set('type', v as SubjectInput['type'])}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{SubjectType.options.map((t) => <SelectItem key={t} value={t}>{humanize(t)}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
    </FormSheet>
  )
}
