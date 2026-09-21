import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { SectionInput, SetupSectionUpdateRequest } from '@erp/contracts'
import { Field, FORM_ERROR, validate, type FieldErrors } from '@/components/setup/field'
import { focusFirstInvalid, type FieldLabels } from '@/lib/validation'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { api } from '@/lib/api'
import type { SectionRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const NONE = '__none__'

interface Form {
  gradeId: string
  academicYearId: string
  name: string
  classTeacherId?: string
  roomNumber?: string
  capacity?: number
}

const LABELS: FieldLabels = {
  name: 'section name',
  roomNumber: 'room',
  capacity: { label: 'capacity', kind: 'number' },
  classTeacherId: { label: 'class teacher', kind: 'select' },
}

export function SectionSheet({ open, onOpenChange, section, gradeId, academicYearId }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  section?: SectionRecord
  gradeId: string
  academicYearId: string
}) {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Form>({ gradeId, academicYearId, name: '' })
  const [errors, setErrors] = useState<FieldErrors>({})
  const canReadDirectory = hasPermission('staff.read_directory')

  const teacherParams = { page: 1, pageSize: 100 as const, sort: 'name' as const }
  const { data: staff } = useQuery({
    queryKey: qk.staff(schoolId, teacherParams),
    queryFn: () => api.staff.list(schoolId, teacherParams),
    enabled: open && canReadDirectory,
  })

  useEffect(() => {
    if (!open) return
    setErrors({})
    setForm(section
      ? { gradeId: section.gradeId, academicYearId: section.academicYearId, name: section.name, roomNumber: section.roomNumber, capacity: section.capacity, classTeacherId: section.classTeacherId }
      : { gradeId, academicYearId, name: '', capacity: 40 })
  }, [open, section, gradeId, academicYearId])

  const save = useMutation({
    mutationFn: (input: Form) =>
      section
        ? api.setup.updateSection(schoolId, section.id, { ...input, expectedVersion: section.version })
        : api.setup.createSection(schoolId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'sections'] })
      toast.success('Saved changes')
      onOpenChange(false)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))

  function submit() {
    const checked = section
      ? validate(SetupSectionUpdateRequest, { ...form, expectedVersion: section.version }, LABELS)
      : validate(SectionInput, form, LABELS)
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
      title={section ? `Edit section ${section.name}` : 'Add section'}
      submitLabel={section ? 'Save changes' : 'Add section'}
      onSubmit={submit}
      busy={save.isPending}
      formError={errors[FORM_ERROR]}
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Section name" error={errors.name} hint="Like A"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Room" error={errors.roomNumber}><Input value={form.roomNumber ?? ''} onChange={(e) => set('roomNumber', e.target.value || undefined)} /></Field>
      </div>
      <Field label="Capacity" error={errors.capacity}>
        <Input inputMode="numeric" value={form.capacity ?? ''} onChange={(e) => set('capacity', e.target.value ? Number(e.target.value) : undefined)} />
      </Field>
      {canReadDirectory ? (
        <Field label="Class teacher" error={errors.classTeacherId} hint="The first 100 staff by name">
          <Select value={form.classTeacherId ?? NONE} onValueChange={(v) => set('classTeacherId', v === NONE ? undefined : v)}>
            <SelectTrigger className="w-full"><SelectValue placeholder="Not set" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not set</SelectItem>
              {form.classTeacherId && !(staff?.items ?? []).some((person) => person.id === form.classTeacherId)
                ? <SelectItem value={form.classTeacherId}>Assigned teacher</SelectItem>
                : null}
              {(staff?.items ?? []).map((person) => <SelectItem key={person.id} value={person.id}>{person.displayName} · {person.designation}</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      ) : null}
    </FormSheet>
  )
}
