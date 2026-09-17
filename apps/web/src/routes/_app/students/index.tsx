import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { RowSelectionState } from '@tanstack/react-table'
import { ArrowUpDown, Check, MoreHorizontal, Plus, Search, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { DataTable } from '@/components/shared/data-table'
import { FilterChip, ToolbarButton } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { colorFor, Tag } from '@/components/shared/tag'
import { StudentBulkBar } from '@/components/students/student-bulk-bar'
import { classLabel, studentColumns } from '@/components/students/student-columns'
import { useSectionOptions } from '@/components/students/use-section-options'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { fullName } from '@/lib/utils'

const searchSchema = z.object({
  q: z.string().max(100).optional().catch(undefined),
  sectionId: z.string().optional(),
  status: z.enum(['active', 'left', 'alumni', 'suspended']).default('active'),
  sort: z.enum(['name', 'admission', 'roll']).default('name'),
  page: z.number().int().min(1).default(1),
})
type StudentSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/_app/students/')({
  component: Page,
  validateSearch: searchSchema,
})

const PAGE_SIZE = 25
const SORT_LABEL: Record<StudentSearch['sort'], string> = { name: 'Name', admission: 'Admission no', roll: 'Roll number' }

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { schoolId, hasPermission } = useSchoolContext()
  const { currentYearId } = useAcademicYear()
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})

  const setSearch = (patch: Partial<StudentSearch>) => {
    setRowSelection({})
    void navigate({ search: (old) => ({ ...old, page: 1, ...patch }), replace: true })
  }
  const setPage = (page: number) => {
    setRowSelection({})
    void navigate({ search: (old) => ({ ...old, page }) })
  }

  const { options: sectionOptions } = useSectionOptions(currentYearId)

  // The server matches academicYearId against the student's CURRENT enrolment, so pinning the list
  // to the running year hides every student whose latest enrolment sits elsewhere (and every
  // student who has left). The section chip already implies a year, so that is the only narrowing.
  const params = {
    page: search.page,
    pageSize: PAGE_SIZE,
    search: search.q,
    sectionId: search.sectionId,
    status: search.status,
    sort: search.sort,
  }

  const roster = useQuery({
    queryKey: qk.students(schoolId, params),
    queryFn: () => api.students.list(schoolId, params),
  })

  const rows = roster.data?.items ?? []
  const selectedIds = useMemo(() => Object.keys(rowSelection).filter((id) => rowSelection[id]), [rowSelection])
  const hasFilters = Boolean(search.q || search.sectionId || search.status !== 'active')
  const clearFilters = () => void navigate({ search: { status: 'active', sort: search.sort, page: 1 } })

  const header = (
    <PageHeader
      crumbs={[{ label: 'Students', icon: <Users /> }]}
      badge={roster.data ? <Tag className="ml-2">{roster.data.total}</Tag> : undefined}
      actions={
        <>
          {hasPermission('students.import') && <Button variant="outline" size="sm" onClick={() => void navigate({ to: '/students/import' })}>Import</Button>}
          {hasPermission('students.promote') && <Button variant="outline" size="sm" onClick={() => void navigate({ to: '/students/promote' })}>Promote</Button>}
          {hasPermission('students.create') && <Button size="sm" onClick={() => void navigate({ to: '/students/new' })}>Admit student</Button>}
        </>
      }
      mobileActions={
        <>
          {hasPermission('students.create') && (
            <Button size="sm" onClick={() => void navigate({ to: '/students/new' })} className="h-9"><Plus />Admit</Button>
          )}
          {(hasPermission('students.import') || hasPermission('students.promote')) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" aria-label="More student actions" className="size-9 p-0"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {hasPermission('students.import') && <DropdownMenuItem onClick={() => void navigate({ to: '/students/import' })}>Import from Excel</DropdownMenuItem>}
                {hasPermission('students.promote') && <DropdownMenuItem onClick={() => void navigate({ to: '/students/promote' })}>Promote students</DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      }
    />
  )

  if (roster.isError) {
    return (
      <>
        {header}
        <EmptyState icon={<Users />} title="The roster is not available" description={describeError(roster.error)} />
      </>
    )
  }

  return (
    <>
      {header}

      <Toolbar
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search.q ?? ''}
              onChange={(e) => setSearch({ q: e.target.value.slice(0, 100) || undefined })}
              maxLength={100}
              placeholder="Search name or admission number"
              aria-label="Search students"
              className="w-full pl-8 md:w-56"
            />
          </div>
        }
      >
        <FilterChip
          label="Class"
          value={search.sectionId}
          options={sectionOptions.map((option) => ({ value: option.value, label: option.label }))}
          onChange={(value) => setSearch({ sectionId: value })}
          allLabel="Any"
        />
        <FilterChip
          label="Status"
          value={search.status}
          options={[
            { value: 'active' as const, label: 'Active' },
            { value: 'left' as const, label: 'Left' },
            { value: 'alumni' as const, label: 'Alumni' },
            { value: 'suspended' as const, label: 'Suspended' },
          ]}
          onChange={(value) => setSearch({ status: value ?? 'active' })}
          clearable={false}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <span><ToolbarButton icon={<ArrowUpDown />}>Sort: {SORT_LABEL[search.sort]}</ToolbarButton></span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {(Object.keys(SORT_LABEL) as StudentSearch['sort'][]).map((option) => (
              <DropdownMenuItem key={option} onClick={() => setSearch({ sort: option })} className="justify-between">
                {SORT_LABEL[option]}
                {search.sort === option && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Toolbar>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <DataTable
          columns={studentColumns}
          data={rows}
          isLoading={roster.isLoading}
          selectable
          getRowId={(row) => row.id}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          rowLink={(row) => `/students/${row.id}`}
          mobileRow={(row) => ({
            title: fullName(row),
            subtitle: `${row.admissionNumber} · Roll ${row.enrollment?.rollNumber ?? '—'}`,
            trailing: row.enrollment ? <Tag color={colorFor(row.enrollment.grade.name)}>{classLabel(row)}</Tag> : undefined,
          })}
          emptyState={
            <EmptyState
              icon={<Users />}
              title="No students match"
              description="Try a different class, status or search term."
              action={hasFilters ? <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
            />
          }
          footer={
            <>
              <span>{rows.length} students in view</span>
              <span>{roster.data?.total ?? 0} in total</span>
              {selectedIds.length > 0 && (
                <span className="flex items-center gap-2">
                  {selectedIds.length} selected
                  <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setRowSelection({})}>Clear</button>
                </span>
              )}
            </>
          }
          pagination={{ page: search.page, pageSize: PAGE_SIZE, total: roster.data?.total ?? 0, onPageChange: setPage }}
        />
        <StudentBulkBar ids={selectedIds} onClear={() => setRowSelection({})} />
      </div>
    </>
  )
}
