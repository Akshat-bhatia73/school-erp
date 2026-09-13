import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Lock } from 'lucide-react'
import type { ImportPreview, StudentImportRow } from '@erp/shared'
import { api } from '@/api/client'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { StepBar } from '@/components/admission/step-rail'
import { ImportUpload } from '@/components/admission/import-upload'
import { ImportReview } from '@/components/admission/import-review'
import { readSpreadsheet, sampleRows } from '@/components/admission/import-utils'

export const Route = createFileRoute('/_app/students/import')({ component: Page })

const STEPS = ['Upload', 'Check', 'Done']

function Page() {
  const { can } = useSession()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [created, setCreated] = useState(0)

  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const { data: years = [] } = useQuery({ queryKey: qk.academicYears, queryFn: () => api.academicYears.list() })
  const yearId = years.find((y) => y.status === 'current')?.id
  const { data: sections = [] } = useQuery({ queryKey: qk.sections({ academicYearId: yearId }), queryFn: () => api.sections.list({ academicYearId: yearId }), enabled: !!yearId })

  // Sample rows must name a class and section that really exist, or every row would fail the check
  const sampleTarget = useMemo(() => {
    const section = sections.find((s) => grades.some((g) => g.id === s.gradeId && g.order >= 8)) ?? sections[0]
    const grade = grades.find((g) => g.id === section?.gradeId)
    return { grade: grade?.name ?? 'Class 6', section: section?.name ?? 'A' }
  }, [sections, grades])

  const previewMut = useMutation({
    mutationFn: (rows: Record<string, unknown>[]) => api.students.importPreview(rows),
    onSuccess: (p) => { setPreview(p); setStep(1) },
    onError: (e: Error) => toast.error(e.message || 'Could not read that file'),
  })

  const commit = useMutation({
    mutationFn: (rows: StudentImportRow[]) => api.students.importCommit(rows),
    onSuccess: (r) => {
      setCreated(r.created)
      qc.invalidateQueries({ queryKey: ['students'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      qc.invalidateQueries({ queryKey: ['sectionStrengths'] })
      qc.invalidateQueries({ queryKey: ['auditLogs'] })
      toast.success(`Imported ${r.created} students`)
      setStep(2)
    },
    onError: (e: Error) => toast.error(e.message || 'Import failed'),
  })

  if (!can('students', 'create')) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students' }, { label: 'Import students' }]} />
        <EmptyState icon={<Lock />} title="You cannot import students" description="Ask an admin for the students create permission." />
      </>
    )
  }

  const handleFile = async (file: File) => {
    try {
      const rows = await readSpreadsheet(file)
      if (rows.length === 0) { toast.error('That file has no rows under the header'); return }
      previewMut.mutate(rows)
    } catch {
      toast.error('We could not read that file. Use the template as a starting point.')
    }
  }

  const reset = () => { setPreview(null); setCreated(0); setStep(0) }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Students', to: '/students' }, { label: 'Import students' }]}
        actions={<Button variant="outline" size="sm" onClick={() => navigate({ to: '/students' })}>Cancel</Button>}
      />
      <Toolbar><StepBar steps={STEPS} current={step} /></Toolbar>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="mx-auto max-w-4xl p-3 md:p-5">
          {step === 0 && (
            <ImportUpload
              isBusy={previewMut.isPending}
              onFile={handleFile}
              onSample={() => previewMut.mutate(sampleRows(sampleTarget.grade, sampleTarget.section))}
            />
          )}
          {step === 1 && preview && (
            <ImportReview
              preview={preview}
              onBack={() => setStep(0)}
              onImport={() => commit.mutate(preview.validRows)}
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
                <p className="max-w-sm text-[13px] text-muted-foreground">They are enrolled in the classes named in your file. Roll numbers and photos can be edited later.</p>
                <div className="mt-3 flex items-center gap-2">
                  <Button onClick={() => navigate({ to: '/students' })}>View students</Button>
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
