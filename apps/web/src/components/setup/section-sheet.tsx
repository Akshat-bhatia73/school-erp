import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SectionInput, type Section } from '@erp/shared'
import { api } from '@/api/client'
import { Field, validate, type FieldErrors } from '@/components/setup/field'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { qk } from '@/lib/query'
import { fullName } from '@/lib/utils'

const NONE = '__none__'

export function SectionSheet({ open, onOpenChange, section, gradeId, academicYearId }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  section?: Section
  gradeId: string
  academicYearId: string
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<SectionInput>({ gradeId, academicYearId, name: '' })
  const [errors, setErrors] = useState<FieldErrors>({})

  const { data: staff } = useQuery({
    queryKey: qk.staff({ staffType: 'teaching', pageSize: 500 }),
    queryFn: () => api.staff.list({ staffType: 'teaching', pageSize: 500 }),
    enabled: open,
  })

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(section
      ? { gradeId: section.gradeId, academicYearId: section.academicYearId, name: section.name, roomNumber: section.roomNumber, capacity: section.capacity, classTeacherId: section.classTeacherId }
      : { gradeId, academicYearId, name: '', capacity: 40 })
  }, [open, section, gradeId, academicYearId])

  const save = useMutation({
    mutationFn: (input: SectionInput) => (section ? api.sections.update(section.id, input) : api.sections.create(input)),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: ['sections'] })
      qc.invalidateQueries({ queryKey: ['sectionStrengths'] })
      toast.success(section ? `Saved section ${s.name}` : `Added section ${s.name}`)
      onOpenChange(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const set = <K extends keyof SectionInput>(k: K, v: SectionInput[K]) => setForm((f) => ({ ...f, [k]: v }))

  function submit() {
    const res = validate(SectionInput, form)
    if (!res.ok) return setErrors(res.errors)
    setErrors({})
    save.mutate(res.data)
  }

  return (
    <FormSheet open={open} onOpenChange={onOpenChange} title={section ? `Edit section ${section.name}` : 'Add section'} submitLabel={section ? 'Save changes' : 'Add section'} onSubmit={submit} busy={save.isPending}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Section name" error={errors.name} hint="Like A"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Room" error={errors.roomNumber}><Input value={form.roomNumber ?? ''} onChange={(e) => set('roomNumber', e.target.value || undefined)} /></Field>
      </div>
      <Field label="Capacity" error={errors.capacity}>
        <Input inputMode="numeric" value={form.capacity ?? ''} onChange={(e) => set('capacity', e.target.value ? Number(e.target.value) : undefined)} />
      </Field>
      <Field label="Class teacher" error={errors.classTeacherId}>
        <Select value={form.classTeacherId ?? NONE} onValueChange={(v) => set('classTeacherId', v === NONE ? undefined : v)}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Not assigned" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not assigned</SelectItem>
            {(staff?.items ?? []).map((s) => <SelectItem key={s.id} value={s.id}>{fullName(s)} · {s.designation}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
    </FormSheet>
  )
}
