import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { GradeInput } from '@erp/shared'
import { api } from '@/api/client'
import { Field, validate, type FieldErrors } from '@/components/setup/field'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { qk } from '@/lib/query'

const NONE = '__none__'
const STREAMS = ['science', 'commerce', 'arts'] as const

export function GradeSheet({ open, onOpenChange, nextOrder }: { open: boolean; onOpenChange: (v: boolean) => void; nextOrder: number }) {
  const qc = useQueryClient()
  const [form, setForm] = useState<GradeInput>({ name: '', shortName: '', order: nextOrder })
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => { if (open) { setErrors({}); setForm({ name: '', shortName: '', order: nextOrder }) } }, [open, nextOrder])

  const save = useMutation({
    mutationFn: (input: GradeInput) => api.grades.create(input),
    onSuccess: (g) => { qc.invalidateQueries({ queryKey: qk.grades }); toast.success(`Added ${g.name}`); onOpenChange(false) },
    onError: (e: Error) => toast.error(e.message),
  })

  const set = <K extends keyof GradeInput>(k: K, v: GradeInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  function submit() {
    const res = validate(GradeInput, form)
    if (!res.ok) return setErrors(res.errors)
    setErrors({})
    save.mutate(res.data)
  }

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title="Add class" description="Classes are ordered from Nursery upwards." submitLabel="Add class" onSubmit={submit} busy={save.isPending}>
      <Field label="Class name" error={errors.name} hint="Like Class 6"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Short name" error={errors.shortName} hint="Like 6"><Input value={form.shortName} onChange={(e) => set('shortName', e.target.value)} /></Field>
        <Field label="Order" error={errors.order}><Input inputMode="numeric" value={form.order} onChange={(e) => set('order', Number(e.target.value) || 0)} /></Field>
      </div>
      <Field label="Stream" error={errors.stream} hint="Only for Class 11 and 12">
        <Select value={form.stream ?? NONE} onValueChange={(v) => set('stream', v === NONE ? undefined : (v as GradeInput['stream']))}>
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
