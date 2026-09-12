import { useEffect, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import type { RowSelectionState } from '@tanstack/react-table'
import { toast } from 'sonner'
import { Info, Lock } from 'lucide-react'
import { api, type StudentRow } from '@/api/client'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { fullName, humanize } from '@/lib/utils'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { FilterChip, ToolbarButton } from '@/components/shared/filter-chip'
import { Tag } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Segmented } from '@/components/admission/segmented'
import { PromoteSummary } from '@/components/admission/promote-summary'

export const Route = createFileRoute('/_app/students/promote')({ component: Page })

type Decision = 'promote' | 'detain'

function Page() {
  const { can } = useSession()
  const qc = useQueryClient()
  const [fromYearId, setFromYearId] = useState<string>()
  const [toYearId, setToYearId] = useState<string>()
  const [fromGradeId, setFromGradeId] = useState<string>()
  const [fromSectionId, setFromSectionId] = useState<string>()
  const [toGradeId, setToGradeId] = useState<string>()
  const [toSectionId, setToSectionId] = useState<string>()
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [selection, setSelection] = useState<RowSelectionState>({})

  const { data: years = [] } = useQuery({ queryKey: qk.academicYears, queryFn: () => api.academicYears.list() })
  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const { data: fromSections = [] } = useQuery({ queryKey: qk.sections({ academicYearId: fromYearId }), queryFn: () => api.sections.list({ academicYearId: fromYearId }), enabled: !!fromYearId })
  const { data: toSectionsForYear = [] } = useQuery({ queryKey: qk.sections({ academicYearId: toYearId }), queryFn: () => api.sections.list({ academicYearId: toYearId }), enabled: !!toYearId })
  // Classes for a year that has not started yet are usually not set up, so fall back to this year's classes
  const toSections = useMemo(() => (toSectionsForYear.length ? toSectionsForYear : fromSections), [toSectionsForYear, fromSections])
  const { data: toStrengths = {} } = useQuery({ queryKey: qk.sectionStrengths(toYearId ?? ''), queryFn: () => api.sections.strengths(toYearId!), enabled: !!toYearId })

  // Defaults: current year -> the upcoming one
  useEffect(() => {
    if (years.length === 0 || fromYearId) return
    const current = years.find((y) => y.status === 'current') ?? years[years.length - 1]
    const upcoming = years.find((y) => y.status === 'upcoming') ?? years.find((y) => current && y.startDate > current.startDate)
    setFromYearId(current?.id)
    setToYearId(upcoming?.id ?? current?.id)
  }, [years, fromYearId])

  // Default the from class/section to the first one that exists
  useEffect(() => {
    if (!fromGradeId && fromSections.length) {
      const first = fromSections[0]!
      setFromGradeId(first.gradeId)
      setFromSectionId(fromSections.filter((s) => s.gradeId === first.gradeId)[0]?.id)
    }
  }, [fromSections, fromGradeId])

  // Suggest the next class, same section letter
  useEffect(() => {
    if (!fromGradeId || !fromSectionId) return
    const fromGrade = grades.find((g) => g.id === fromGradeId)
    const fromSection = fromSections.find((s) => s.id === fromSectionId)
    if (!fromGrade || !fromSection) return
    const nextGrade = grades.filter((g) => g.order > fromGrade.order).sort((a, b) => a.order - b.order)[0] ?? fromGrade
    const match = toSections.find((s) => s.gradeId === nextGrade.id && s.name === fromSection.name) ?? toSections.find((s) => s.gradeId === nextGrade.id)
    setToGradeId(nextGrade.id)
    setToSectionId(match?.id)
  }, [fromGradeId, fromSectionId, grades, fromSections, toSections])

  const { data: page, isLoading } = useQuery({
    queryKey: qk.students({ sectionId: fromSectionId, academicYearId: fromYearId, pageSize: 200 }),
    queryFn: () => api.students.list({ sectionId: fromSectionId, academicYearId: fromYearId, pageSize: 200 }),
    enabled: !!fromSectionId,
  })
  const students = useMemo(() => page?.items ?? [], [page])

  useEffect(() => { setDecisions({}); setSelection({}) }, [fromSectionId])

  const decisionOf = (id: string): Decision => decisions[id] ?? 'promote'
  const promoteIds = students.filter((s) => decisionOf(s.id) === 'promote').map((s) => s.id)
  const detainIds = students.filter((s) => decisionOf(s.id) === 'detain').map((s) => s.id)

  const fromSection = fromSections.find((s) => s.id === fromSectionId)
  const toSection = toSections.find((s) => s.id === toSectionId)
  const label = (gradeId?: string, sectionName?: string) => {
    const g = grades.find((x) => x.id === gradeId)
    return g ? `${g.name} · ${sectionName ?? '—'}` : '—'
  }
  const fromLabel = label(fromSection?.gradeId, fromSection?.name)
  const toLabel = label(toSection?.gradeId, toSection?.name)

  const capacity = toSection?.capacity ?? 40
  const existing = toSection ? (toStrengths[toSection.id] ?? 0) : 0
  const capacityWarning = toSection && existing + promoteIds.length > capacity
    ? `${toLabel} already has ${existing} students and holds ${capacity}. Adding ${promoteIds.length} takes it to ${existing + promoteIds.length}.`
    : undefined

  const promote = useMutation({
    mutationFn: () => api.students.promote({
      fromAcademicYearId: fromYearId!,
      toAcademicYearId: toYearId!,
      fromSectionId: fromSectionId!,
      toSectionId: toSectionId!,
      studentIds: promoteIds,
      detainStudentIds: detainIds,
    }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['students'] })
      qc.invalidateQueries({ queryKey: ['sectionStrengths'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
      qc.invalidateQueries({ queryKey: ['auditLogs'] })
      toast.success(`Promoted ${r.promoted} students${r.detained ? `, detained ${r.detained}` : ''}`)
      setDecisions({})
      setSelection({})
    },
    onError: (e: Error) => toast.error(e.message || 'Could not promote these students'),
  })

  const columns = useMemo<ColumnDef<StudentRow, unknown>[]>(() => [
    { id: 'roll', header: 'Roll', size: 70, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.enrollment?.rollNumber ?? '—'}</span> },
    { id: 'name', header: 'Name', cell: ({ row }) => <EntityCell avatar={<UserAvatar name={fullName(row.original)} src={row.original.photoUrl} size="sm" />} name={fullName(row.original)} sub={row.original.admissionNumber} /> },
    { id: 'gender', header: 'Gender', size: 100, cell: ({ row }) => humanize(row.original.gender) },
    { id: 'attendance', header: 'Attendance %', size: 160, cell: () => <span className="flex items-center gap-2 text-muted-foreground">— <Tag color="grey">Phase 2</Tag></span> },
    {
      id: 'decision', header: 'Decision', size: 170,
      cell: ({ row }) => (
        <Segmented
          value={decisionOf(row.original.id)}
          options={[{ value: 'promote', label: 'Promote' }, { value: 'detain', label: 'Detain' }]}
          onChange={(v) => setDecisions((d) => ({ ...d, [row.original.id]: v }))}
        />
      ),
    },
  ], [decisions])

  if (!can('students', 'edit')) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students' }, { label: 'Promote students' }]} />
        <EmptyState icon={<Lock />} title="You cannot promote students" description="Ask an admin for the students edit permission." />
      </>
    )
  }

  const selectedIds = Object.keys(selection).filter((id) => selection[id])
  const yearOpts = years.map((y) => ({ value: y.id, label: y.name }))
  const gradeOpts = (secs: typeof fromSections) => grades.filter((g) => secs.some((s) => s.gradeId === g.id)).map((g) => ({ value: g.id, label: g.name }))
  const sectionOpts = (secs: typeof fromSections, gradeId?: string) => secs.filter((s) => s.gradeId === gradeId).map((s) => ({ value: s.id, label: s.name }))

  return (
    <>
      <PageHeader crumbs={[{ label: 'Students', to: '/students' }, { label: 'Promote students' }]} />
      <Toolbar
        right={
          <ToolbarButton onClick={() => setDecisions(Object.fromEntries(students.map((s) => [s.id, 'promote' as Decision])))}>
            Select all → Promote
          </ToolbarButton>
        }
      >
        <FilterChip label="From year" clearable={false} value={fromYearId} options={yearOpts} onChange={(v) => setFromYearId(v)} />
        <FilterChip label="To year" clearable={false} value={toYearId} options={yearOpts} onChange={(v) => setToYearId(v)} />
        <span className="mx-1 h-5 w-px bg-border" />
        <FilterChip label="From class" clearable={false} value={fromGradeId} options={gradeOpts(fromSections)} onChange={(v) => { setFromGradeId(v); setFromSectionId(sectionOpts(fromSections, v)[0]?.value) }} />
        <FilterChip label="Section" clearable={false} value={fromSectionId} options={sectionOpts(fromSections, fromGradeId)} onChange={(v) => setFromSectionId(v)} />
        <span className="mx-1 h-5 w-px bg-border" />
        <FilterChip label="To class" clearable={false} value={toGradeId} options={gradeOpts(toSections)} onChange={(v) => { setToGradeId(v); setToSectionId(sectionOpts(toSections, v)[0]?.value) }} />
        <FilterChip label="Section" clearable={false} value={toSectionId} options={sectionOpts(toSections, toGradeId)} onChange={(v) => setToSectionId(v)} />
      </Toolbar>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b bg-card px-4 py-3">
            <Alert>
              <Info />
              <AlertTitle>Promotion creates a new enrolment in the next year</AlertTitle>
              <AlertDescription>The current year's record is kept for history, so old report cards and attendance stay where they are.</AlertDescription>
            </Alert>
          </div>
          <DataTable
            dense
            selectable
            columns={columns}
            data={students}
            isLoading={isLoading}
            getRowId={(r) => r.id}
            rowSelection={selection}
            onRowSelectionChange={setSelection}
            emptyState={<EmptyState title="No students in this section" description="Pick another class and section from the toolbar." />}
            footer={
              <>
                <span>{students.length} students in view</span>
                {selectedIds.length > 0 && (
                  <button type="button" className="link-dotted" onClick={() => setDecisions((d) => ({ ...d, ...Object.fromEntries(selectedIds.map((id) => [id, 'detain' as Decision])) }))}>
                    Detain {selectedIds.length} selected
                  </button>
                )}
              </>
            }
          />
        </div>
        <PromoteSummary
          total={students.length}
          promoteCount={promoteIds.length}
          detainCount={detainIds.length}
          fromLabel={fromLabel}
          toLabel={toLabel}
          fromYear={years.find((y) => y.id === fromYearId)?.name ?? '—'}
          toYear={years.find((y) => y.id === toYearId)?.name ?? '—'}
          capacityWarning={capacityWarning}
          canPromote
          disabled={!toSectionId || !fromSectionId || promoteIds.length === 0 || fromSectionId === toSectionId}
          isPending={promote.isPending}
          onConfirm={() => promote.mutate()}
        />
      </div>
    </>
  )
}
