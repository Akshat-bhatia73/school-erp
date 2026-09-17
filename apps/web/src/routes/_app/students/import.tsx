import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CheckCircle2, Lock } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ImportReview } from '@/components/admission/import-review'
import { ImportUpload } from '@/components/admission/import-upload'
import { mapSheetRows, readSpreadsheet, sampleRows, type SheetProblem } from '@/components/admission/import-utils'
import { StepBar } from '@/components/admission/step-rail'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import type { ImportPreview } from '@/lib/api/students'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'

export const Route = createFileRoute('/_app/students/import')({ component: Page })

const STEPS = ['Upload', 'Check', 'Done']

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { currentYearId } = useAcademicYear()
  const [step, setStep] = useState(0)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [problems, setProblems] = useState<SheetProblem[]>([])
  const [created, setCreated] = useState(0)

  const canImport = hasPermission('students.import')

  const sections = useQuery({
    queryKey: qk.sections(schoolId, { academicYearId: currentYearId ?? undefined }),
    queryFn: () => api.setup.sections(schoolId, { academicYearId: currentYearId ?? undefined }),
    enabled: canImport && Boolean(currentYearId) && hasPermission('sections.read'),
  })
  const grades = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: canImport && hasPermission('grades.read'),
  })

  // Sample rows must name a class and a section that really exist, or every row fails the check.
  const sampleTarget = useMemo(() => {
    const section = (sections.data ?? [])[0]
    const grade = (grades.data ?? []).find((candidate) => candidate.id === section?.gradeId)
    return { grade: grade?.name ?? 'Class 6', section: section?.name ?? 'A' }
  }, [sections.data, grades.data])

  const check = useMutation({
    mutationFn: (rows: ReturnType<typeof mapSheetRows>) =>
      api.students.importPreview(schoolId, { academicYearId: currentYearId!, rows: rows.rows }),
    onSuccess: (result) => { setPreview(result); setStep(1) },
    onError: (error) => toast.error(describeError(error)),
  })

  const commit = useMutation({
    mutationFn: () => api.students.importCommit(schoolId, { previewId: preview!.id, expectedVersion: preview!.version }),
    onSuccess: (result) => {
      setCreated(result.created)
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      toast.success('Students imported')
      setStep(2)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  if (!canImport) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students' }, { label: 'Import students' }]} />
        <EmptyState icon={<Lock />} title="You cannot import students" description="Ask your school office for permission to import students." />
      </>
    )
  }

  const submitRows = (sheetRows: Record<string, unknown>[]) => {
    if (!currentYearId) {
      toast.error('We do not know which academic year to import into yet.')
      return
    }
    const mapped = mapSheetRows(sheetRows)
    setProblems(mapped.problems)
    if (mapped.rows.length === 0) {
      // Nothing in the file could even be described, so there is nothing to ask the server about.
      setPreview(null)
      setStep(1)
      return
    }
    check.mutate(mapped)
  }

  const handleFile = async (file: File) => {
    try {
      const rows = await readSpreadsheet(file)
      if (rows.length === 0) { toast.error('That file has no rows under the header'); return }
      submitRows(rows)
    } catch {
      toast.error('We could not read that file. Use the template as a starting point.')
    }
  }

  const reset = () => { setPreview(null); setProblems([]); setCreated(0); setStep(0) }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Students', to: '/students' }, { label: 'Import students' }]}
        actions={<Button variant="outline" size="sm" onClick={() => void navigate({ to: '/students' })}>Cancel</Button>}
      />
      <Toolbar><StepBar steps={STEPS} current={step} /></Toolbar>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-4xl p-3 md:p-5">
          {step === 0 && (
            <ImportUpload
              isBusy={check.isPending}
              onFile={handleFile}
              onSample={() => submitRows(sampleRows(sampleTarget.grade, sampleTarget.section))}
            />
          )}
          {step === 1 && (
            <ImportReview
              preview={preview}
              problems={problems}
              onBack={() => setStep(0)}
              onImport={() => commit.mutate()}
              isImporting={commit.isPending}
            />
          )}
          {step === 2 && (
            <Panel>
              <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                <div className="flex size-10 items-center justify-center rounded-xl border bg-muted/50 text-tag-green">
                  <CheckCircle2 className="size-5" />
                </div>
                <p className="text-[15px] font-medium">{created} students added</p>
                <p className="max-w-sm text-[13px] text-muted-foreground">They are enrolled in the classes named in your file. Roll numbers can be edited later.</p>
                <div className="mt-3 flex items-center gap-2">
                  <Button onClick={() => void navigate({ to: '/students' })}>View students</Button>
                  <Button variant="outline" onClick={reset}>Import another file</Button>
                </div>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </>
  )
}
