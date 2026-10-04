/**
 * Homework: the items this person may read, by due date.
 *
 * Staff see the items of their classes and subjects (the office every class) with how far the
 * checking has got; a parent sees their children's items with each child's status, and picks a
 * child when they have more than one; a pupil sees their own. The server bounds the list; the
 * chips narrow what is asked for, and the search box only narrows the list already loaded.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { NotebookText, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { todayIso } from '@/components/attendance/month-chip'
import { HomeworkSheet, useClassOptions } from '@/components/homework/homework-sheet'
import { addDays, classLabel, GENERAL_LABEL, PupilStatusTag, subjectLabel } from '@/components/homework/labels'
import { HomeworkTabs } from '@/components/homework/tabs'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { HomeworkListParams, HomeworkRow } from '@/lib/api/homework'
import { describeError } from '@/lib/api-errors'
import { useSchoolDashboardView } from '@/lib/dashboard-view'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatDate, fullName } from '@/lib/utils'

const STATUSES = ['upcoming', 'past', 'to_check', 'removed', 'all'] as const
type StatusChoice = (typeof STATUSES)[number]
const WHEN = ['today', 'tomorrow', 'next_7', 'last_7', 'last_30'] as const
type When = (typeof WHEN)[number]

/** The subject chip's value for general homework. */
const GENERAL = 'general'

const searchSchema = z.object({
  status: z.enum(STATUSES).optional().catch(undefined),
  when: z.enum(WHEN).optional().catch(undefined),
  sectionId: z.string().optional().catch(undefined),
  subjectId: z.string().optional().catch(undefined),
  studentId: z.string().optional().catch(undefined),
  academicYearId: z.string().optional().catch(undefined),
})
type Search = z.infer<typeof searchSchema>

export const Route = createFileRoute('/_app/homework/')({ component: Page, validateSearch: searchSchema })

const STATUS_LABEL: Record<StatusChoice, string> = {
  upcoming: 'Upcoming',
  past: 'Past',
  to_check: 'To check',
  removed: 'Removed',
  all: 'All',
}

const WHEN_OPTIONS: Array<{ value: When; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'next_7', label: 'Next 7 days' },
  { value: 'last_7', label: 'Last 7 days' },
  { value: 'last_30', label: 'Last 30 days' },
]

/** The due-date range a "Due" choice asks the server for. */
function rangeFor(when: When | undefined): Pick<HomeworkListParams, 'from' | 'to'> {
  const today = todayIso()
  switch (when) {
    case 'today': return { from: today, to: today }
    case 'tomorrow': return { from: addDays(today, 1), to: addDays(today, 1) }
    case 'next_7': return { from: today, to: addDays(today, 6) }
    case 'last_7': return { from: addDays(today, -7), to: addDays(today, -1) }
    case 'last_30': return { from: addDays(today, -30), to: addDays(today, -1) }
    default: return {}
  }
}

/** "Due today" stands out; any other day is just its date. */
function DueCell({ dueOn, today }: { dueOn: string; today: string }) {
  if (dueOn === today) return <span className="font-medium">Today</span>
  if (dueOn === addDays(today, 1)) return <span>Tomorrow</span>
  return <span className="tabular-nums">{formatDate(dueOn)}</span>
}

function plural(count: number) {
  return `${count} homework ${count === 1 ? 'item' : 'items'} in view`
}

function Page() {
  const { ownStudentId } = useSchoolContext()
  const { view } = useSchoolDashboardView()
  const family = Boolean(ownStudentId) || view === 'parent' || view === 'student'
  return family ? <FamilyHomework pupil={Boolean(ownStudentId)} /> : <StaffHomework />
}

function useSearchState() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const set = (patch: Partial<Search>) => void navigate({ search: (prev: Search) => ({ ...prev, ...patch }), replace: true })
  return { search, set }
}

// ---------- staff ----------

function StaffHomework() {
  const { schoolId, hasPermission } = useSchoolContext()
  const { search, set } = useSearchState()
  const { years, currentYearId } = useAcademicYear()
  const [q, setQ] = useState('')
  const [setting, setSetting] = useState(false)
  const navigate = useNavigate()
  const subjectsQuery = useQuery({
    queryKey: qk.subjects(schoolId),
    queryFn: () => api.setup.subjects(schoolId),
    enabled: hasPermission('subjects.read'),
  })

  const status = search.status ?? 'upcoming'
  const yearId = search.academicYearId ?? currentYearId ?? undefined
  // The Class chip lists the chosen year's sections, not always this year's.
  const classes = useClassOptions(true, yearId)
  const params: HomeworkListParams = {
    academicYearId: yearId,
    sectionId: search.sectionId,
    ...(search.subjectId === GENERAL ? { general: 'true' as const } : { subjectId: search.subjectId }),
    ...(status === 'all' ? {} : { status }),
    ...rangeFor(search.when),
  }
  const listQuery = useQuery({
    queryKey: qk.homework.list(schoolId, params),
    queryFn: () => api.homework.list(schoolId, params),
    enabled: hasPermission('homework.read'),
  })
  const today = listQuery.data?.today ?? todayIso()
  const needle = q.trim().toLowerCase()
  // A person who is also a parent may get their children's entries too; this view is the staff one.
  const rows = (listQuery.data?.items ?? []).filter((item) =>
    item.child === undefined &&
    (!needle || `${item.title} ${subjectLabel(item.subject)} ${classLabel(item.grade, item.section)} ${item.setBy ?? ''}`.toLowerCase().includes(needle)))

  const subjectOptions = [
    ...(subjectsQuery.data ?? []).map((subject) => ({ value: subject.id, label: subject.name })).sort((a, b) => a.label.localeCompare(b.label)),
    { value: GENERAL, label: GENERAL_LABEL },
  ]
  const statusOptions = STATUSES.map((value) => ({ value, label: STATUS_LABEL[value] }))
  const canSet = hasPermission('homework.set')

  const columns = useMemo<ColumnDef<HomeworkRow, unknown>[]>(() => [
    { id: 'due', header: 'Due', size: 120, cell: ({ row }) => <DueCell dueOn={row.original.dueOn} today={today} /> },
    { id: 'class', header: 'Class', size: 120, cell: ({ row }) => classLabel(row.original.grade, row.original.section) },
    { id: 'subject', header: 'Subject', size: 150, cell: ({ row }) => (row.original.subject ? row.original.subject.name : <Tag>{GENERAL_LABEL}</Tag>) },
    {
      id: 'title', header: 'Homework', size: 300,
      cell: ({ row }) => <EntityCell name={row.original.title} sub={row.original.attachmentCount > 0 ? `${row.original.attachmentCount} ${row.original.attachmentCount === 1 ? 'file' : 'files'}` : undefined} />,
    },
    { id: 'setBy', header: 'Set by', size: 160, cell: ({ row }) => row.original.setBy ?? <span className="text-muted-foreground">—</span> },
    {
      id: 'checked', header: 'Checked', size: 150,
      cell: ({ row }) => {
        const item = row.original
        if (item.removedAt) return <Tag color="grey">Removed</Tag>
        if (item.dueOn > today) return <span className="text-muted-foreground">Not due yet</span>
        if (!item.progress) return <span className="text-muted-foreground">—</span>
        const checked = item.progress.pupils - item.progress.notChecked
        return <span className="tabular-nums">{checked} of {item.progress.pupils}</span>
      },
    },
  ], [today])

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Homework', icon: <NotebookText /> }]}
        actions={canSet ? <Button size="sm" onClick={() => setSetting(true)}><Plus />Set homework</Button> : undefined}
      />
      <HomeworkTabs />
      <Toolbar search={<Input placeholder="Search homework" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-full md:w-60" />}>
        {years.length > 1 && yearId && (
          <FilterChip label="Year" value={yearId} options={years.map((year) => ({ value: year.id, label: year.name }))} onChange={(value) => set({ academicYearId: value, sectionId: undefined })} clearable={false} />
        )}
        <FilterChip label="Class" value={search.sectionId} options={classes.options} onChange={(value) => set({ sectionId: value })} />
        <FilterChip label="Subject" value={search.subjectId} options={subjectOptions} onChange={(value) => set({ subjectId: value })} />
        <FilterChip label="Status" value={status} options={statusOptions} onChange={(value) => set({ status: value ?? 'upcoming' })} clearable={false} />
        <FilterChip label="Due" value={search.when} options={WHEN_OPTIONS} onChange={(value) => set({ when: value })} allLabel="Any day" />
      </Toolbar>
      {listQuery.isError ? (
        <EmptyState icon={<NotebookText />} title="Homework is not available" description={describeError(listQuery.error)} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={listQuery.isLoading}
          getRowId={(row) => row.id}
          rowLink={(row) => `/homework/${row.id}`}
          mobileRow={(row) => ({
            title: row.title,
            subtitle: `${subjectLabel(row.subject)} · ${classLabel(row.grade, row.section)} · due ${formatDate(row.dueOn)}`,
            trailing: row.removedAt ? <Tag color="grey">Removed</Tag> : row.progress && row.dueOn <= today
              ? <span className="text-[12px] tabular-nums text-muted-foreground">{row.progress.pupils - row.progress.notChecked} of {row.progress.pupils}</span>
              : undefined,
          })}
          emptyState={<EmptyState icon={<NotebookText />} title="No homework here" description={canSet ? 'Homework you set appears here.' : 'Homework set for your classes appears here.'} />}
          footer={<span>{plural(rows.length)}{listQuery.data?.truncated ? '. Narrow the filters to see the rest.' : ''}</span>}
        />
      )}
      {canSet && <HomeworkSheet open={setting} onOpenChange={setSetting} onCreated={(id) => void navigate({ to: '/homework/$homeworkId', params: { homeworkId: id } })} />}
    </>
  )
}

// ---------- families ----------

function FamilyHomework({ pupil }: { pupil: boolean }) {
  const { schoolId } = useSchoolContext()
  const { search, set } = useSearchState()
  const [q, setQ] = useState('')
  const childParams = { status: 'active' as const, pageSize: 50 }
  const childrenQuery = useQuery({
    queryKey: qk.students(schoolId, childParams),
    queryFn: () => api.students.list(schoolId, childParams),
    enabled: !pupil,
  })
  const children = childrenQuery.data?.items ?? []
  const status = search.status === 'upcoming' || search.status === 'past' || search.status === 'all' ? search.status : 'upcoming'
  const params: HomeworkListParams = {
    ...(pupil ? {} : { studentId: search.studentId }),
    ...(status === 'all' ? {} : { status }),
    ...rangeFor(search.when),
  }
  const listQuery = useQuery({ queryKey: qk.homework.list(schoolId, params), queryFn: () => api.homework.list(schoolId, params) })
  const today = listQuery.data?.today ?? todayIso()
  const needle = q.trim().toLowerCase()
  const rows = (listQuery.data?.items ?? []).filter((item) =>
    item.child !== undefined && (!needle || `${item.title} ${subjectLabel(item.subject)}`.toLowerCase().includes(needle)))
  // Siblings in different classes: name the child on each row.
  const showChild = !pupil && new Set(rows.map((row) => row.child?.student.id)).size > 1

  const columns = useMemo<ColumnDef<HomeworkRow, unknown>[]>(() => [
    { id: 'due', header: 'Due', size: 120, cell: ({ row }) => <DueCell dueOn={row.original.dueOn} today={today} /> },
    { id: 'subject', header: 'Subject', size: 150, cell: ({ row }) => (row.original.subject ? row.original.subject.name : <Tag>{GENERAL_LABEL}</Tag>) },
    {
      id: 'title', header: 'Homework', size: 320,
      cell: ({ row }) => <EntityCell name={row.original.title} sub={row.original.attachmentCount > 0 ? `${row.original.attachmentCount} ${row.original.attachmentCount === 1 ? 'file' : 'files'}` : undefined} />,
    },
    ...(showChild ? [{ id: 'child', header: 'Child', size: 160, cell: ({ row }: { row: { original: HomeworkRow } }) => row.original.child?.student.name ?? '' } satisfies ColumnDef<HomeworkRow, unknown>] : []),
    { id: 'status', header: 'Status', size: 130, cell: ({ row }) => (row.original.child ? <PupilStatusTag status={row.original.child.status} /> : null) },
  ], [today, showChild])

  const statusOptions = (['upcoming', 'past', 'all'] as const).map((value) => ({ value, label: STATUS_LABEL[value] }))

  return (
    <>
      <PageHeader crumbs={[{ label: 'Homework', icon: <NotebookText /> }]} />
      <Toolbar search={<Input placeholder="Search homework" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-full md:w-60" />}>
        {!pupil && children.length > 1 && (
          <FilterChip
            label="Child"
            value={search.studentId}
            options={children.map((child) => ({ value: child.id, label: fullName(child) }))}
            onChange={(value) => set({ studentId: value })}
            allLabel="All children"
          />
        )}
        <FilterChip label="Status" value={status} options={statusOptions} onChange={(value) => set({ status: value ?? 'upcoming' })} clearable={false} />
        <FilterChip label="Due" value={search.when} options={WHEN_OPTIONS} onChange={(value) => set({ when: value })} allLabel="Any day" />
      </Toolbar>
      {listQuery.isError ? (
        <EmptyState icon={<NotebookText />} title="Homework is not available" description={describeError(listQuery.error)} />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={listQuery.isLoading}
          getRowId={(row) => `${row.id}-${row.child?.student.id ?? ''}`}
          rowLink={(row) => `/homework/${row.id}`}
          mobileRow={(row) => ({
            title: row.title,
            subtitle: [subjectLabel(row.subject), showChild ? row.child?.student.name : undefined, `due ${formatDate(row.dueOn)}`].filter(Boolean).join(' · '),
            trailing: row.child ? <PupilStatusTag status={row.child.status} /> : undefined,
          })}
          emptyState={<EmptyState icon={<NotebookText />} title="No homework here" description="Homework the teachers set appears here." />}
          footer={<span>{plural(rows.length)}{listQuery.data?.truncated ? '. Narrow the filters to see the rest.' : ''}</span>}
        />
      )}
    </>
  )
}
