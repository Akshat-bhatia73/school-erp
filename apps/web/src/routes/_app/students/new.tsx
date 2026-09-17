import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ClassStep } from '@/components/admission/class-step'
import { GuardiansStep } from '@/components/admission/guardians-step'
import { ReviewStep } from '@/components/admission/review-step'
import { StepProgress, StepRail } from '@/components/admission/step-rail'
import { StudentStep } from '@/components/admission/student-step'
import {
  emptyDraft, errorsForStep, stepOfError, toAdmitRequest, validateDraft,
  type AdmitDraft,
} from '@/components/admission/admit-state'
import type { Errors } from '@/components/admission/fields'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'

export const Route = createFileRoute('/_app/students/new')({ component: Page })

const STEPS = ['Student details', 'Parents / guardians', 'Class & admission', 'Review']

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { current, currentYearId } = useAcademicYear()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<AdmitDraft>(emptyDraft)
  const [errors, setErrors] = useState<Errors>({})

  const canCreate = hasPermission('students.create')

  const admit = useMutation({
    mutationFn: () => api.students.create(schoolId, toAdmitRequest(draft)),
    onSuccess: (student) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      // The number comes back on the created record; the office never types it.
      toast.success(`Student admitted as ${student.admissionNumber}`)
      void navigate({ to: '/students/$studentId', params: { studentId: student.id } })
    },
    onError: (error) => toast.error(describeError(error)),
  })

  if (!canCreate) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students' }, { label: 'Admit student' }]} />
        <EmptyState icon={<Lock />} title="You cannot admit students" description="Ask your school office for permission to admit students." />
      </>
    )
  }

  const set = (patch: Partial<AdmitDraft>) => setDraft((old) => ({ ...old, ...patch }))

  const next = () => {
    const found = validateDraft(draft)
    setErrors(found)
    const onThisStep = errorsForStep(step, found)
    if (Object.keys(onThisStep).length === 0) setStep((current) => Math.min(current + 1, STEPS.length - 1))
  }

  const submit = () => {
    const found = validateDraft(draft)
    setErrors(found)
    const paths = Object.keys(found)
    if (paths.length > 0) {
      setStep(Math.min(...paths.map(stepOfError)))
      toast.error('Some details are still missing')
      return
    }
    admit.mutate()
  }

  const stepErrors = errorsForStep(step, errors)

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Students', to: '/students' }, { label: 'Admit student' }]}
        actions={<Button variant="outline" size="sm" onClick={() => void navigate({ to: '/students' })}>Cancel</Button>}
      />
      <StepProgress steps={STEPS} current={step} />
      <div className="flex min-h-0 flex-1">
        <StepRail steps={STEPS} current={step} onGo={(index) => { setErrors({}); setStep(index) }} />
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto max-w-3xl p-3 md:p-5">
            <h1 className="mb-4 hidden text-[16px] font-semibold md:block">{STEPS[step]}</h1>
            {step === 0 && <StudentStep draft={draft} set={set} errors={stepErrors} />}
            {step === 1 && <GuardiansStep draft={draft} set={set} errors={stepErrors} canAttachExisting={hasPermission('students.manage_guardians')} />}
            {step === 2 && <ClassStep draft={draft} set={set} errors={stepErrors} academicYearId={currentYearId} yearName={current?.name ?? 'This year'} />}
            {step === 3 && <ReviewStep draft={draft} onEdit={setStep} academicYearId={currentYearId} yearName={current?.name ?? 'This year'} />}

            {/* Sticky on mobile so Next is always in reach on a long form */}
            <div className="sticky bottom-0 -mx-3 mt-5 flex items-center justify-between gap-3 border-t bg-card px-3 py-3 md:static md:mx-0 md:bg-transparent md:px-0 md:pt-4 md:pb-0">
              <Button variant="outline" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}>Back</Button>
              {step < STEPS.length - 1 ? (
                <Button onClick={next} className="min-w-28">Next</Button>
              ) : (
                <Button onClick={submit} disabled={admit.isPending} className="min-w-28">{admit.isPending ? 'Admitting…' : 'Admit student'}</Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
