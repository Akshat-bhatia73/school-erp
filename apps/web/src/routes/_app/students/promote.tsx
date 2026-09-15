import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { Info, Lock } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { PromoteStudentsRequest } from '@erp/contracts'
import { PromoteSummary } from '@/components/admission/promote-summary'
import { Segmented } from '@/components/admission/segmented'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { useSectionOptions } from '@/components/students/use-section-options'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import type { StudentSummary } from '@/lib/api/students'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { fullName } from '@/lib/utils'

export const Route = createFileRoute('/_app/students/promote')({ component: Page })

type Decision = 'promote' | 'detain'

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const { years, current } = useAcademicYear()
  const [fromYearId, setFromYearId] = useState<string>()
  const [toYearId, setToYearId] = useState<string>()
  const [fromSectionId, setFromSectionId] = useState<string>()
  const [toSectionId, setToSectionId] = useState<string>()
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [reason, setReason] = useState('End of year promotion')
  const [reasonError, setReasonError] = useState<string>()
  const [result, setResult] = useState<{ promoted: number; detained: number }>()

  const canPromote = hasPermission('students.promote')

  // Defaults: this year moves into the next one.
  useEffect(() => {
    if (years.length === 0 || fromYearId) return
    const from = current ?? years[years.length - 1]
    const to = years.find((year) => year.status === 'upcoming') ?? years.find((year) => from && year.startDate > from.startDate)
    setFromYearId(from?.id)
    setToYearId(to?.id ?? from?.id)
  }, [years, current, fromYearId])

  const fromSections = useSectionOptions(fromYearId)
  const toSections = useSectionOptions(toYearId)

  const previewParams = {
    fromAcademicYearId: fromYearId ?? '',
    toAcademicYearId: toYearId ?? '',
    fromSectionId: fromSectionId ?? '',
    toSectionId: toSectionId ?? '',
  }
  const ready = Boolean(fromYearId && toYearId && fromSectionId && toSectionId)

  const preview = useQuery({
    queryKey: qk.promotePreview(schoolId, previewParams),
    queryFn: () => api.students.promotePreview(schoolId, previewParams),
    enabled: canPromote && ready,
  })

  const students = useMemo(() => preview.data?.students ?? [], [preview.data])
  useEffect(() => { setDecisions({}) }, [fromSectionId, toSectionId])

  const decisionOf = (id: string): Decision => decisions[id] ?? 'promote'
  const promoteIds = students.filter((student) => decisionOf(student.id) === 'promote').map((student) => student.id)
  const detainIds = students.filter((student) => decisionOf(student.id) === 'detain').map((student) => student.id)

  const promote = useMutation({
    mutationFn: (body: Parameters<typeof api.students.promote>[1]) => api.students.promote(schoolId, body),
    onSuccess: (outcome) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      setResult(outcome)
      setDecisions({})
      toast.success('Students promoted')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const columns = useMemo<ColumnDef<StudentSummary, unknown>[]>(() => [
    { id: 'roll', header: 'Roll', size: 70, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.enrollment?.rollNumber ?? '—'}</span> },
    {
      id: 'name',
      header: 'Name',
      cell: ({ row }) => <EntityCell avatar={<UserAvatar name={fullName(row.original)} size="sm" />} name={fullName(row.original)} sub={row.original.admissionNumber} />,
    },
    {
      id: 'decision',
      header: 'Decision',
      size: 170,
      cell: ({ row }) => (
        <Segmented
          value={decisionOf(row.original.id)}
          options={[{ value: 'promote', label: 'Promote' }, { value: 'detain', label: 'Detain' }]}
          onChange={(value) => setDecisions((old) => ({ ...old, [row.original.id]: value }))}
        />
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [decisions])

  if (!canPromote) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students' }, { label: 'Promote students' }]} />
        <EmptyState icon={<Lock />} title="You cannot promote students" description="Ask your school office for permission to promote students." />
      </>
    )
  }

  const yearOptions = years.map((year) => ({ value: year.id, label: year.name }))
  const fromLabel = fromSections.options.find((option) => option.value === fromSectionId)?.label ?? '—'
  const toLabel = preview.data?.targetSection.name ?? toSections.options.find((option) => option.value === toSectionId)?.label ?? '—'

  const confirm = () => {
    // The request carries at most 100 ids on each side, but a section may hold more than that.
    if (promoteIds.length > 100 || detainIds.length > 100) {
      const message = 'This section has more than 100 students. Promoting a group this large is not built yet, so ask the school office.'
      setReasonError(undefined)
      toast.error(message)
      return
    }
    const parsed = PromoteStudentsRequest.safeParse({
      fromAcademicYearId: fromYearId,
      toAcademicYearId: toYearId,
      fromSectionId,
      toSectionId,
      studentIds: promoteIds,
      detainedStudentIds: detainIds,
      reason: reason.trim(),
    })
    if (!parsed.success) {
      const reasonIssue = parsed.error.issues.find((issue) => issue.path[0] === 'reason')
      const message = reasonIssue?.message ?? parsed.error.issues[0]?.message ?? 'Check the details and try again.'
      setReasonError(reasonIssue?.message)
      toast.error(message)
      return
    }
    setReasonError(undefined)
    promote.mutate(parsed.data)
  }

  return (
    <>
      <PageHeader crumbs={[{ label: 'Students', to: '/students' }, { label: 'Promote students' }]} />
      <Toolbar>
        <FilterChip label="From year" clearable={false} value={fromYearId} options={yearOptions} onChange={setFromYearId} />
        <FilterChip label="To year" clearable={false} value={toYearId} options={yearOptions} onChange={setToYearId} />
        <span className="mx-1 h-5 w-px bg-border" />
        <FilterChip
          label="From section" clearable={false} value={fromSectionId}
          options={fromSections.options.map((option) => ({ value: option.value, label: option.label }))}
          onChange={setFromSectionId}
          allLabel="Pick a section"
        />
        <FilterChip
          label="To section" clearable={false} value={toSectionId}
          options={toSections.options.map((option) => ({ value: option.value, label: option.label }))}
          onChange={setToSectionId}
          allLabel="Pick a section"
        />
      </Toolbar>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b bg-card px-3 py-2 md:px-4 md:py-3">
            <Alert>
              <Info />
              <AlertTitle>Promotion creates a new enrolment in the next year</AlertTitle>
              <AlertDescription>The current year's record is kept for history, so old records stay where they are.</AlertDescription>
            </Alert>
          </div>
          {preview.isError ? (
            <EmptyState title="This cohort is not available" description={describeError(preview.error)} />
          ) : (
            <DataTable
              dense
              columns={columns}
              data={students}
              isLoading={preview.isFetching}
              getRowId={(row) => row.id}
              emptyState={<EmptyState title="No students to promote" description="Pick the year and the sections to move students between." />}
              footer={<span>{students.length} students in view</span>}
            />
          )}
        </div>
        <PromoteSummary
          total={students.length}
          promoteCount={promoteIds.length}
          detainCount={detainIds.length}
          fromLabel={fromLabel}
          toLabel={toLabel}
          fromYear={years.find((year) => year.id === fromYearId)?.name ?? '—'}
          toYear={years.find((year) => year.id === toYearId)?.name ?? '—'}
          reason={reason}
          onReasonChange={setReason}
          reasonError={reasonError}
          result={result}
          disabled={!ready || promoteIds.length === 0}
          disabledReason={!ready ? 'Pick both years and both sections first.' : promoteIds.length === 0 ? 'Nobody is set to move up yet.' : undefined}
          isPending={promote.isPending}
          onConfirm={confirm}
        />
      </div>
    </>
  )
}
