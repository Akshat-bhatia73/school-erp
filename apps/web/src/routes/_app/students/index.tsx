import { useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { RowSelectionState } from '@tanstack/react-table'
import { ArrowUpDown, Check, MoreHorizontal, Plus, Search, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { api } from '@/api/client'
import { DataTable } from '@/components/shared/data-table'
import { FilterChip, ToolbarButton } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { StudentBulkBar } from '@/components/students/student-bulk-bar'
import { classLabel, exportStudentsCsv, studentColumns } from '@/components/students/student-columns'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { colorFor } from '@/components/shared/tag'
import { fullName } from '@/lib/utils'

const searchSchema = z.object({
  q: z.string().optional(),
  gradeId: z.string().optional(),
  sectionId: z.string().optional(),
  status: z.enum(['active', 'left', 'alumni']).default('active'),
  gender: z.enum(['male', 'female', 'other']).optional(),
  admissionType: z.enum(['regular', 'rte', 'staff_ward', 'scholarship']).optional(),
  sort: z.enum(['roll', 'name', 'admission', 'recent']).default('roll'),
  page: z.number().int().min(1).default(1),
})
type StudentSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/_app/students/')({
  component: Page,
  validateSearch: searchSchema,
})

const PAGE_SIZE = 25
const SORT_LABEL: Record<StudentSearch['sort'], string> = { roll: 'Roll number', name: 'Name', admission: 'Admission no', recent: 'Recently added' }

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { can } = useSession()
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})

  const setSearch = (patch: Partial<StudentSearch>) => {
    setRowSelection({})
    navigate({ search: (old) => ({ ...old, page: 1, ...patch }), replace: true })
  }
  const setPage = (p: number) => {
    setRowSelection({})
    navigate({ search: (old) => ({ ...old, page: p }) })
  }

  const { data: year } = useQuery({ queryKey: [...qk.academicYears, 'current'], queryFn: () => api.academicYears.current() })
  const { data: grades = [] } = useQuery({ queryKey: qk.grades, queryFn: () => api.grades.list() })
  const { data: sections = [] } = useQuery({
    queryKey: qk.sections({ academicYearId: year?.id, gradeId: search.gradeId }),
    queryFn: () => api.sections.list({ academicYearId: year?.id, gradeId: search.gradeId }),
    enabled: !!search.gradeId,
  })

  const params = {
    academicYearId: year?.id,
    gradeId: search.gradeId,
    sectionId: search.sectionId,
    status: search.status,
    gender: search.gender,
    admissionType: search.admissionType,
    search: search.q,
    sort: search.sort,
    page: search.page,
    pageSize: PAGE_SIZE,
  }
  const { data, isLoading } = useQuery({ queryKey: qk.students(params), queryFn: () => api.students.list(params) })

  const rows = data?.items ?? []
  const selectedIds = useMemo(() => Object.keys(rowSelection).filter((id) => rowSelection[id]), [rowSelection])
  const boys = rows.filter((r) => r.gender === 'male').length
  const girls = rows.filter((r) => r.gender === 'female').length
  const hasFilters = !!(search.q || search.gradeId || search.sectionId || search.gender || search.admissionType || search.status !== 'active')
  const clearFilters = () => navigate({ search: { status: 'active', sort: search.sort, page: 1 } })

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Students', icon: <Users /> }]}
        badge={data ? <Tag className="ml-2">{data.total}</Tag> : undefined}
        actions={
          can('students', 'create') ? (
            <>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: '/students/import' })}>Import</Button>
              <Button variant="outline" size="sm" onClick={() => navigate({ to: '/students/promote' })}>Promote</Button>
              <Button size="sm" onClick={() => navigate({ to: '/students/new' })}>Admit student</Button>
            </>
          ) : undefined
        }
        mobileActions={
          can('students', 'create') ? (
            <>
              <Button size="sm" onClick={() => navigate({ to: '/students/new' })} className="h-9"><Plus />Admit</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" aria-label="More student actions" className="size-9 p-0"><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => navigate({ to: '/students/import' })}>Import from Excel</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => navigate({ to: '/students/promote' })}>Promote students</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : undefined
        }
      />

      <Toolbar
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search.q ?? ''}
              onChange={(e) => setSearch({ q: e.target.value || undefined })}
              placeholder="Search name, admission no, parent phone"
              aria-label="Search students"
              className="w-full pl-8 md:w-56"
            />
          </div>
        }
      >
        <FilterChip
          label="Class"
          value={search.gradeId}
          options={grades.map((g) => ({ value: g.id, label: g.name }))}
          onChange={(v) => setSearch({ gradeId: v, sectionId: undefined })}
          allLabel="Any"
        />
        <FilterChip
          label="Section"
          value={search.sectionId}
          options={sections.map((s) => ({ value: s.id, label: s.name }))}
          onChange={(v) => setSearch({ sectionId: v })}
          allLabel={search.gradeId ? 'Any' : 'Pick a class'}
          className={search.gradeId ? undefined : 'pointer-events-none opacity-50'}
        />
        <FilterChip
          label="Status"
          value={search.status}
          options={[{ value: 'active' as const, label: 'Active' }, { value: 'left' as const, label: 'Left' }, { value: 'alumni' as const, label: 'Alumni' }]}
          onChange={(v) => setSearch({ status: v ?? 'active' })}
          clearable={false}
        />
        <FilterChip
          label="Gender"
          value={search.gender}
          options={[{ value: 'male' as const, label: 'Boys' }, { value: 'female' as const, label: 'Girls' }, { value: 'other' as const, label: 'Other' }]}
          onChange={(v) => setSearch({ gender: v })}
          allLabel="Any"
        />
        <FilterChip
          label="Admission type"
          value={search.admissionType}
          options={[
            { value: 'regular' as const, label: 'Regular' },
            { value: 'rte' as const, label: 'RTE' },
            { value: 'staff_ward' as const, label: 'Staff ward' },
            { value: 'scholarship' as const, label: 'Scholarship' },
          ]}
          onChange={(v) => setSearch({ admissionType: v })}
          allLabel="Any"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <span><ToolbarButton icon={<ArrowUpDown />}>Sort: {SORT_LABEL[search.sort]}</ToolbarButton></span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {(Object.keys(SORT_LABEL) as StudentSearch['sort'][]).map((s) => (
              <DropdownMenuItem key={s} onClick={() => setSearch({ sort: s })} className="justify-between">
                {SORT_LABEL[s]}
                {search.sort === s && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Toolbar>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <DataTable
          columns={studentColumns}
          data={rows}
          isLoading={isLoading}
          selectable
          getRowId={(r) => r.id}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          rowLink={(r) => `/students/${r.id}`}
          mobileRow={(r) => ({
            title: fullName(r),
            subtitle: `${r.admissionNumber} · Roll ${r.enrollment?.rollNumber ?? '—'}`,
            meta: r.primaryGuardian ? <span className="truncate font-mono">{r.primaryGuardian.phone}</span> : undefined,
            trailing: r.grade ? <Tag color={colorFor(r.grade.name)}>{classLabel(r)}</Tag> : undefined,
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
              <span>Boys {boys} · Girls {girls}</span>
              {selectedIds.length > 0 && (
                <span className="flex items-center gap-2">
                  {selectedIds.length} selected
                  <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setRowSelection({})}>Clear</button>
                </span>
              )}
            </>
          }
          pagination={{ page: search.page, pageSize: PAGE_SIZE, total: data?.total ?? 0, onPageChange: setPage }}
        />
        <StudentBulkBar
          ids={selectedIds}
          canEdit={can('students', 'edit')}
          onClear={() => setRowSelection({})}
          onExport={() => exportStudentsCsv(rows.filter((r) => selectedIds.includes(r.id)))}
        />
      </div>
    </>
  )
}
