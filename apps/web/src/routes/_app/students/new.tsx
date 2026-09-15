import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Lock } from 'lucide-react'
import { api } from '@/api/client'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { StepProgress, StepRail } from '@/components/admission/step-rail'
import { StudentStep } from '@/components/admission/student-step'
import { GuardiansStep } from '@/components/admission/guardians-step'
import { ClassStep } from '@/components/admission/class-step'
import { ReviewStep } from '@/components/admission/review-step'
import { emptyDraft, suggestAdmissionNumber, toStudentInput, validateStep, type AdmitDraft } from '@/components/admission/admit-state'
import type { Errors } from '@/components/admission/fields'

export const Route = createFileRoute('/_app/students/new')({ component: Page })

const STEPS = ['Student details', 'Parents / guardians', 'Class & admission', 'Review']

function Page() {
  const { school, can } = useSession()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<AdmitDraft>(emptyDraft)
  const [errors, setErrors] = useState<Errors>({})
  const suggested = useRef(false)

  const { data: years = [] } = useQuery({ queryKey: qk.academicYears, queryFn: () => api.academicYears.list() })
  const year = useMemo(() => years.find((y) => y.status === 'current'), [years])
  const { data: studentPage } = useQuery({ queryKey: qk.students({ pageSize: 1, status: 'all' }), queryFn: () => api.students.list({ pageSize: 1, status: 'all' }) })

  // Suggest an admission number once we know how many students the school has
  useEffect(() => {
    if (!studentPage || suggested.current) return
    suggested.current = true
    setDraft((d) => (d.admissionNumber ? d : { ...d, admissionNumber: suggestAdmissionNumber(school?.code ?? 'SCH', studentPage.total + 1) }))
  }, [studentPage, school?.code])

  const create = useMutation({
    mutationFn: () => api.students.create(toStudentInput(draft)),
    onSuccess: (student) => {
      qc.invalidateQueries({ queryKey: ['students'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      qc.invalidateQueries({ queryKey: ['sectionStrengths'] })
      qc.invalidateQueries({ queryKey: ['auditLogs'] })
      toast.success(`Admitted ${[draft.firstName, draft.lastName].filter(Boolean).join(' ')}`)
      navigate({ to: '/students/$studentId', params: { studentId: student.id } })
    },
    onError: (e: Error) => toast.error(e.message || 'Could not admit the student'),
  })

  if (!can('students', 'create')) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students' }, { label: 'Admit student' }]} />
        <EmptyState icon={<Lock />} title="You cannot admit students" description="Ask an admin for the students create permission." />
      </>
    )
  }

  const set = (patch: Partial<AdmitDraft>) => setDraft((d) => ({ ...d, ...patch }))

  const next = () => {
    const found = validateStep(step, draft)
    setErrors(found)
    if (Object.keys(found).length === 0) setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  const submit = () => {
    for (let s = 0; s < 3; s++) {
      const found = validateStep(s, draft)
      if (Object.keys(found).length) {
        setErrors(found)
        setStep(s)
        toast.error('Some details are still missing')
        return
      }
    }
    setErrors({})
    create.mutate()
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Students', to: '/students' }, { label: 'Admit student' }]}
        actions={<Button variant="outline" size="sm" onClick={() => navigate({ to: '/students' })}>Cancel</Button>}
      />
      <StepProgress steps={STEPS} current={step} />
      <div className="flex min-h-0 flex-1">
        <StepRail steps={STEPS} current={step} onGo={(i) => { setErrors({}); setStep(i) }} />
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
          <div className="mx-auto max-w-3xl p-3 md:p-5">
            <h1 className="mb-4 hidden text-[16px] font-semibold md:block">{STEPS[step]}</h1>
            {step === 0 && <StudentStep draft={draft} set={set} errors={errors} />}
            {step === 1 && <GuardiansStep draft={draft} set={set} errors={errors} />}
            {step === 2 && <ClassStep draft={draft} set={set} errors={errors} yearId={year?.id ?? ''} yearName={year?.name ?? '—'} />}
            {step === 3 && <ReviewStep draft={draft} onEdit={setStep} yearId={year?.id ?? ''} yearName={year?.name ?? '—'} />}

            {/* Sticky on mobile so Next is always in reach on a long form */}
            <div className="sticky bottom-0 -mx-3 mt-5 flex items-center justify-between gap-3 border-t bg-card px-3 py-3 md:static md:mx-0 md:bg-transparent md:px-0 md:pt-4 md:pb-0">
              <Button variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>Back</Button>
              {step < STEPS.length - 1 ? (
                <Button onClick={next} className="min-w-28">Next</Button>
              ) : (
                <Button onClick={submit} disabled={create.isPending} className="min-w-28">{create.isPending ? 'Admitting…' : 'Admit student'}</Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
