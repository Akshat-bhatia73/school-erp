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
import { CHECK_FIELDS, fieldErrors, type FieldLabels } from '@/lib/validation'
import { useAcademicYear } from '@/lib/use-academic-year'
import { fullName } from '@/lib/utils'

const PROMOTE_LABELS: FieldLabels = {
  fromAcademicYearId: { label: 'year to promote from', kind: 'select' },
  toAcademicYearId: { label: 'year to promote into', kind: 'select' },
  fromSectionId: { label: 'section to promote from', kind: 'select' },
  toSectionId: { label: 'section to promote into', kind: 'select' },
  studentIds: { label: 'student to promote', kind: 'list' },
  detainedStudentIds: { label: 'student to detain', kind: 'list' },
  reason: 'reason for this change',
}

export const Route = createFileRoute('/_app/students/promote')({ component: Page })

/** A run failed after earlier runs had already moved people, so the count is worth saying. */
class PartialPromotion extends Error {
  readonly promoted: number
  readonly detained: number
  readonly cause: unknown

  constructor(promoted: number, detained: number, cause: unknown) {
    super('Some students were moved before this stopped')
    this.name = 'PartialPromotion'
    this.promoted = promoted
    this.detained = detained
    this.cause = cause
  }
}

/** 'leave' means the student is not sent at all, so nothing about them changes. */
type Decision = 'promote' | 'detain' | 'leave'

/** The preview is read a page at a time and a promotion is sent in runs of the same size. */
const PAGE_SIZE = 100

const DECISION_OPTIONS: Array<{ value: Decision; label: string }> = [
  { value: 'promote', label: 'Promote' },
  { value: 'detain', label: 'Detain' },
  { value: 'leave', label: 'Leave out' },
]

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

  // Every page of the cohort, so the table holds the whole section however big it is.
  const preview = useQuery({
    queryKey: qk.promotePreview(schoolId, previewParams),
    queryFn: async () => {
      const first = await api.students.promotePreview(schoolId, { ...previewParams, page: 1, pageSize: PAGE_SIZE })
      const students = [...first.students]
      for (let page = 2; students.length < first.total; page += 1) {
        const next = await api.students.promotePreview(schoolId, { ...previewParams, page, pageSize: PAGE_SIZE })
        if (next.students.length === 0) break
        students.push(...next.students)
      }
      return { ...first, students }
    },
    enabled: canPromote && ready,
  })

  const students = useMemo(() => preview.data?.students ?? [], [preview.data])
  useEffect(() => { setDecisions({}) }, [fromSectionId, toSectionId])

  const decisionOf = (id: string): Decision => decisions[id] ?? 'promote'
  const promoteIds = students.filter((student) => decisionOf(student.id) === 'promote').map((student) => student.id)
  const detainIds = students.filter((student) => decisionOf(student.id) === 'detain').map((student) => student.id)
  const leftOutCount = students.length - promoteIds.length - detainIds.length

  // Header buttons set every student in view at once.
  const setAll = (value: Decision) => {
    setDecisions(Object.fromEntries(students.map((student) => [student.id, value])))
  }

  // A request carries at most 100 ids on each side, so a big section goes in runs. A run that fails
  // stops the rest: the runs before it are already done, and the preview reloads without them.
  const promote = useMutation({
    mutationFn: async (runs: Array<Parameters<typeof api.students.promote>[1]>) => {
      let promoted = 0
      let detained = 0
      for (const run of runs) {
        try {
          const outcome = await api.students.promote(schoolId, run)
          promoted += outcome.promoted
          detained += outcome.detained
        } catch (failure) {
          throw new PartialPromotion(promoted, detained, failure)
        }
      }
      return { promoted, detained }
    },
    onSuccess: (outcome) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      setResult(outcome)
      setDecisions({})
      toast.success('Students promoted')
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      setDecisions({})
      if (error instanceof PartialPromotion) {
        setResult({ promoted: error.promoted, detained: error.detained })
        toast.error(`${error.promoted + error.detained} students were moved, then this stopped: ${describeError(error.cause)}`)
        return
      }
      toast.error(describeError(error))
    },
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
      header: () => (
        <span className="flex items-center gap-2">
          <span>Decision</span>
          <span className="flex items-center gap-1">
            {DECISION_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setAll(option.value)}
                className="rounded-md border border-dashed px-1.5 py-0.5 text-[11.5px] font-normal text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                All {option.label.toLowerCase()}
              </button>
            ))}
          </span>
        </span>
      ),
      size: 250,
      cell: ({ row }) => (
        <Segmented
          value={decisionOf(row.original.id)}
          options={DECISION_OPTIONS}
          onChange={(value) => setDecisions((old) => ({ ...old, [row.original.id]: value }))}
        />
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [decisions, students])

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
    // Each run takes the next 100 of each list, so every run is a request the contract accepts.
    // At least one run, so choosing nobody is still refused by the contract with its own sentence.
    const runCount = Math.max(1, Math.ceil(promoteIds.length / PAGE_SIZE), Math.ceil(detainIds.length / PAGE_SIZE))
    const runs: Array<Parameters<typeof api.students.promote>[1]> = []
    for (let i = 0; i < runCount; i += 1) {
      const parsed = PromoteStudentsRequest.safeParse({
        fromAcademicYearId: fromYearId,
        toAcademicYearId: toYearId,
        fromSectionId,
        toSectionId,
        studentIds: promoteIds.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE),
        detainedStudentIds: detainIds.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE),
        reason: reason.trim(),
      })
      if (!parsed.success) {
        const errors = fieldErrors(parsed.error, PROMOTE_LABELS)
        setReasonError(errors.reason)
        toast.error(errors.reason ?? Object.values(errors)[0] ?? CHECK_FIELDS)
        return
      }
      runs.push(parsed.data)
    }
    setReasonError(undefined)
    promote.mutate(runs)
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
                  footer={<span>{students.length} students in view · {promoteIds.length} to promote, {detainIds.length} to detain, {leftOutCount} left out</span>}
            />
          )}
        </div>
        <PromoteSummary
          total={students.length}
          promoteCount={promoteIds.length}
          detainCount={detainIds.length}
          leftOutCount={leftOutCount}
          fromLabel={fromLabel}
          toLabel={toLabel}
          fromYear={years.find((year) => year.id === fromYearId)?.name ?? '—'}
          toYear={years.find((year) => year.id === toYearId)?.name ?? '—'}
          reason={reason}
          onReasonChange={setReason}
          reasonError={reasonError}
          result={result}
          disabled={!ready || promoteIds.length + detainIds.length === 0}
          disabledReason={!ready ? 'Pick both years and both sections first.' : promoteIds.length + detainIds.length === 0 ? 'Every student is left out, so there is nothing to do.' : undefined}
          isPending={promote.isPending}
          onConfirm={confirm}
        />
      </div>
    </>
  )
}
