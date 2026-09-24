/** Exams: the office's exams for the year, a teacher's marks sheets, a parent's way to results. */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, Navigate, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { EXAM_KINDS, type ExamKind } from '@erp/contracts'
import { FileText, NotebookPen, Settings2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { ExamDatesSheet } from '@/components/exams/exam-sheet'
import { dateRange, EnteredBar, examLabel, PaperStatusTag } from '@/components/exams/labels'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { ExamPaperRecord, ExamScheduleRecord } from '@/lib/api/exams'
import { describeError } from '@/lib/api-errors'
import { useSchoolDashboardView } from '@/lib/dashboard-view'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatDate, fullName } from '@/lib/utils'

const searchSchema = z.object({ academicYearId: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/exams/')({ component: Page, validateSearch: searchSchema })

const crumbs = [{ label: 'Exams', icon: <NotebookPen /> }]

/** The year a screen works in: the one in the address, else the current one. */
function useYear() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { years, currentYearId, isLoading } = useAcademicYear()
  const yearId = search.academicYearId ?? currentYearId
  const chip = years.length > 1 && yearId ? (
    <FilterChip
      label="Year"
      value={yearId}
      options={years.map((year) => ({ value: year.id, label: year.name }))}
      onChange={(value) => void navigate({ search: { academicYearId: value }, replace: true })}
      clearable={false}
    />
  ) : null
  return { yearId, chip, isLoading }
}

// ---------- office ----------

interface ExamRow { kind: ExamKind; exam?: ExamScheduleRecord }

function OfficeExams() {
  const { schoolId, hasPermission } = useSchoolContext()
  const { yearId, chip, isLoading: yearLoading } = useYear()
  const [editing, setEditing] = useState<ExamRow | null>(null)
  const examsQuery = useQuery({
    queryKey: qk.exams(schoolId, { academicYearId: yearId }),
    queryFn: () => api.exams.list(schoolId, { academicYearId: yearId as string }),
    enabled: yearId !== null,
  })
  const rows: ExamRow[] = EXAM_KINDS.map((kind) => ({ kind, exam: examsQuery.data?.items.find((item) => item.kind === kind) }))
  const firstMissing = rows.find((row) => !row.exam)

  const columns = useMemo<ColumnDef<ExamRow, unknown>[]>(() => [
    { id: 'exam', header: 'Exam', size: 220, cell: ({ row }) => <EntityCell name={examLabel(row.original.kind)} sub={row.original.exam ? undefined : 'Not set up yet'} /> },
    { id: 'dates', header: 'Dates', size: 220, cell: ({ row }) => (row.original.exam ? dateRange(row.original.exam.startsOn, row.original.exam.endsOn) : <span className="text-muted-foreground">—</span>) },
    { id: 'recheck', header: 'Re-check deadline', size: 160, cell: ({ row }) => (row.original.exam ? formatDate(row.original.exam.recheckDeadline) : <span className="text-muted-foreground">—</span>) },
    { id: 'state', header: 'Marks', size: 110, cell: ({ row }) => (row.original.exam ? (row.original.exam.locked ? <Tag color="grey">Locked</Tag> : <Tag color="blue">Open</Tag>) : null) },
    {
      id: 'published', header: 'Published', size: 200,
      cell: ({ row }) => (row.original.exam ? <span className="tabular-nums text-muted-foreground">{row.original.exam.sectionsPublished} of {row.original.exam.sectionsTotal} sections published</span> : null),
    },
    {
      id: 'actions', header: '', size: 130,
      cell: ({ row }) => {
        const exam = row.original.exam
        if (exam && !allows(exam.allowedActions, 'exams.manage')) return null
        return (
          <Button size="sm" variant="ghost" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setEditing(row.original) }}>
            {exam ? 'Change dates' : 'Set up'}
          </Button>
        )
      },
    },
  ], [])

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        actions={
          <>
            {hasPermission('report_cards.read') && <Button asChild size="sm" variant="outline"><Link to="/exams/report-cards"><FileText />Report cards</Link></Button>}
            {hasPermission('exams.manage') && <Button asChild size="sm" variant="outline"><Link to="/exams/settings"><Settings2 />Settings</Link></Button>}
            {firstMissing && yearId && <Button size="sm" onClick={() => setEditing(firstMissing)}>Set up exams</Button>}
          </>
        }
      />
      <Toolbar>{chip}{examsQuery.data && <span className="text-[12.5px] text-muted-foreground">{examsQuery.data.academicYear.name}</span>}</Toolbar>
      {examsQuery.isError ? (
        <EmptyState icon={<NotebookPen />} title="Exams are not available" description={describeError(examsQuery.error)} />
      ) : !yearLoading && yearId === null ? (
        <EmptyState icon={<NotebookPen />} title="No academic year yet" description="Set up an academic year before its exams." />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={examsQuery.isLoading || yearLoading}
          getRowId={(row) => row.kind}
          onRowClick={(row) => (row.exam ? undefined : setEditing(row))}
          rowLink={(row) => (row.exam ? `/exams/${row.exam.id}` : '')}
          mobileRow={(row) => ({
            title: examLabel(row.kind),
            subtitle: row.exam ? dateRange(row.exam.startsOn, row.exam.endsOn) : 'Not set up yet',
            trailing: row.exam ? <span className="text-[12px] text-muted-foreground">{row.exam.sectionsPublished} of {row.exam.sectionsTotal}</span> : undefined,
          })}
          footer={<span>{rows.filter((row) => row.exam).length} of 4 exams set up</span>}
        />
      )}
      {editing && yearId && (
        <ExamDatesSheet open onOpenChange={(open) => { if (!open) setEditing(null) }} academicYearId={yearId} kind={editing.kind} exam={editing.exam} />
      )}
    </>
  )
}

// ---------- teacher ----------

function TeacherPapers() {
  const { schoolId, hasPermission } = useSchoolContext()
  const { yearId, chip, isLoading: yearLoading } = useYear()
  const [examKind, setExamKind] = useState<string | undefined>()
  const [sectionId, setSectionId] = useState<string | undefined>()
  const [q, setQ] = useState('')
  const papersQuery = useQuery({
    queryKey: qk.examPapers(schoolId, { academicYearId: yearId }),
    queryFn: () => api.exams.papers(schoolId, { academicYearId: yearId as string }),
    enabled: yearId !== null,
  })
  const all = papersQuery.data?.items ?? []
  const examOptions = EXAM_KINDS.filter((kind) => all.some((paper) => paper.exam.kind === kind)).map((kind) => ({ value: kind as string, label: examLabel(kind) }))
  const sectionOptions = [...new Map(all.map((paper) => [paper.section.id, `${paper.grade.name} - ${paper.section.name}`])).entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'en-IN', { numeric: true }))
  const needle = q.trim().toLowerCase()
  const rows = all.filter((paper) =>
    (!examKind || paper.exam.kind === examKind) &&
    (!sectionId || paper.section.id === sectionId) &&
    (!needle || `${paper.subject.name} ${paper.grade.name} ${paper.section.name} ${examLabel(paper.exam.kind)}`.toLowerCase().includes(needle)))

  const columns = useMemo<ColumnDef<ExamPaperRecord, unknown>[]>(() => [
    { id: 'exam', header: 'Exam', size: 170, cell: ({ row }) => examLabel(row.original.exam.kind) },
    { id: 'class', header: 'Class', size: 130, cell: ({ row }) => `${row.original.grade.name} - ${row.original.section.name}` },
    { id: 'subject', header: 'Subject', size: 180, cell: ({ row }) => <EntityCell name={row.original.subject.name} /> },
    { id: 'entered', header: 'Entered', size: 170, cell: ({ row }) => <EnteredBar entered={row.original.entered} expected={row.original.expected} /> },
    { id: 'deadline', header: 'Re-check deadline', size: 150, cell: ({ row }) => formatDate(row.original.exam.recheckDeadline) },
    { id: 'status', header: 'Status', size: 120, cell: ({ row }) => <PaperStatusTag state={row.original.window.state} published={row.original.published} /> },
  ], [])

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'My marks sheets', icon: <NotebookPen /> }]}
        actions={hasPermission('report_cards.read') ? <Button asChild size="sm" variant="outline"><Link to="/exams/report-cards"><FileText />Report cards</Link></Button> : undefined}
      />
      <Toolbar search={<Input placeholder="Search subject or class" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-full md:w-60" />}>
        {chip}
        <FilterChip label="Exam" value={examKind} options={examOptions} onChange={setExamKind} />
        <FilterChip label="Class" value={sectionId} options={sectionOptions} onChange={setSectionId} />
      </Toolbar>
      {papersQuery.isError ? (
        <EmptyState icon={<NotebookPen />} title="Marks sheets are not available" description={describeError(papersQuery.error)} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={papersQuery.isLoading || yearLoading}
          getRowId={(row) => row.id}
          rowLink={(row) => `/exams/papers/${row.id}`}
          mobileRow={(row) => ({
            title: `${row.subject.name} · ${row.grade.name} - ${row.section.name}`,
            subtitle: `${examLabel(row.exam.kind)} · ${row.entered} of ${row.expected} entered`,
            trailing: <PaperStatusTag state={row.window.state} published={row.published} />,
          })}
          emptyState={<EmptyState icon={<NotebookPen />} title="No marks sheets" description="Marks sheets appear here once the office sets up an exam for a class you teach." />}
          footer={<span>{rows.length} {rows.length === 1 ? 'marks sheet' : 'marks sheets'} in view</span>}
        />
      )}
    </>
  )
}

// ---------- parent ----------

function ParentChildren() {
  const { schoolId } = useSchoolContext()
  const params = { status: 'active' as const, pageSize: 50 }
  const childrenQuery = useQuery({ queryKey: qk.students(schoolId, params), queryFn: () => api.students.list(schoolId, params) })
  const children = childrenQuery.data?.items ?? []
  return (
    <>
      <PageHeader crumbs={[{ label: 'Results', icon: <NotebookPen /> }]} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
        {childrenQuery.isError ? (
          <EmptyState icon={<NotebookPen />} title="Results are not available" description={describeError(childrenQuery.error)} />
        ) : !childrenQuery.isLoading && children.length === 0 ? (
          <EmptyState icon={<NotebookPen />} title="Nothing to show yet" description="No child of yours is enrolled right now." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {children.map((child) => (
              <Link key={child.id} to="/exams/students/$studentId" params={{ studentId: child.id }} className="flex items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent">
                <UserAvatar name={fullName(child)} size="lg" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium">{fullName(child)}</span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">Results and report cards</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function Page() {
  const { hasPermission, ownStudentId } = useSchoolContext()
  const { view } = useSchoolDashboardView()
  // A pupil reads their own results and report cards, nothing else.
  if (ownStudentId) return <Navigate to="/exams/students/$studentId" params={{ studentId: ownStudentId }} replace />
  if (view === 'parent') return <ParentChildren />
  if (view === 'office' && hasPermission('exams.manage')) return <OfficeExams />
  if (hasPermission('exams.read')) return <TeacherPapers />
  if (hasPermission('report_cards.read')) {
    return (
      <>
        <PageHeader crumbs={crumbs} />
        <EmptyState icon={<FileText />} title="Report cards" action={<Button asChild size="sm"><Link to="/exams/report-cards">Open report cards</Link></Button>} />
      </>
    )
  }
  return <EmptyState icon={<NotebookPen />} title="Exams are not available" description="You do not have access to exams." />
}
