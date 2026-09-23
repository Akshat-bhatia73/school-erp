/** Setting one exam's dates: its first and last day and the day re-checks close. */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExamCreateRequest, ExamUpdateRequest, type ExamKind } from '@erp/contracts'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Field, FORM_ERROR, validate, type FieldErrors } from '@/components/setup/field'
import { FormSheet } from '@/components/setup/form-sheet'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { ExamScheduleRecord } from '@/lib/api/exams'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { examLabel } from './labels'

const LABELS = { startsOn: 'First day', endsOn: 'Last day', recheckDeadline: 'Re-check deadline' }

export function ExamDatesSheet({ open, onOpenChange, academicYearId, kind, exam }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  academicYearId: string
  kind: ExamKind
  /** The exam when it is already set up; absent to create it. */
  exam?: ExamScheduleRecord
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ startsOn: '', endsOn: '', recheckDeadline: '' })
  const [errors, setErrors] = useState<FieldErrors>({})

  useEffect(() => {
    if (!open) return
    setForm({ startsOn: exam?.startsOn ?? '', endsOn: exam?.endsOn ?? '', recheckDeadline: exam?.recheckDeadline ?? '' })
    setErrors({})
  }, [open, exam])

  const save = useMutation({
    mutationFn: async () => {
      if (exam) {
        const checked = validate(ExamUpdateRequest, { expectedVersion: exam.version, ...form }, LABELS)
        if (!checked.ok) throw checked.errors
        return api.exams.update(schoolId, exam.id, checked.data)
      }
      const checked = validate(ExamCreateRequest, { academicYearId, kind, ...form }, LABELS)
      if (!checked.ok) throw checked.errors
      return api.exams.create(schoolId, checked.data)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'exams'] })
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
      toast.success(exam ? 'Exam dates saved' : 'Exam set up')
      onOpenChange(false)
    },
    onError: (failure) => {
      if (failure && typeof failure === 'object' && !(failure instanceof Error)) {
        setErrors(failure as FieldErrors)
        return
      }
      setErrors({ [FORM_ERROR]: describeError(failure) })
    },
  })

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={exam ? `Change dates: ${examLabel(kind)}` : `Set up ${examLabel(kind)}`}
      description="Marks can be entered from the first day until the end of the re-check deadline."
      submitLabel={exam ? 'Save changes' : 'Set up exam'}
      onSubmit={() => save.mutate()}
      busy={save.isPending}
      formError={errors[FORM_ERROR]}
    >
      <Field label={LABELS.startsOn} error={errors.startsOn}><Input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} /></Field>
      <Field label={LABELS.endsOn} error={errors.endsOn}><Input type="date" value={form.endsOn} onChange={(e) => setForm({ ...form, endsOn: e.target.value })} /></Field>
      <Field label={LABELS.recheckDeadline} error={errors.recheckDeadline}><Input type="date" value={form.recheckDeadline} onChange={(e) => setForm({ ...form, recheckDeadline: e.target.value })} /></Field>
    </FormSheet>
  )
}
