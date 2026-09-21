/** The staff directory. The server bounds the list; this screen only pages, searches and filters it. */
import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { Plus, Search, Users } from 'lucide-react'
import { z } from 'zod'
import { api } from '@/lib/api'
import type { StaffPage } from '@/lib/api/staff'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { StaffBulkBar } from '@/components/staff/staff-bulk-bar'
import { Tag, colorFor } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { describeError, isApiError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const searchSchema = z.object({
  q: z.string().max(100).optional().catch(undefined),
  department: z.string().max(100).optional().catch(undefined),
  page: z.number().int().min(1).default(1),
})
type StaffSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/_app/staff/')({ component: Page, validateSearch: searchSchema })

type StaffRow = StaffPage['items'][number]

const PAGE_SIZE = 25
const SEARCH_MAX = 100

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { schoolId, hasPermission } = useSchoolContext()
  const [selection, setSelection] = useState<RowSelectionState>({})
  const canExport = hasPermission('staff.export')

  // A filter always starts again from the first page; the page itself keeps a history entry.
  const setSearch = (patch: Partial<StaffSearch>) => {
    setSelection({})
    void navigate({ search: (old) => ({ ...old, page: 1, ...patch }), replace: true })
  }
  const setPage = (page: number) => {
    setSelection({})
    void navigate({ search: (old) => ({ ...old, page }) })
  }

  const term = search.q?.trim()
  const params = {
    page: search.page,
    pageSize: PAGE_SIZE,
    sort: 'name' as const,
    search: term === '' ? undefined : term,
    department: search.department,
  }
  const staffQuery = useQuery({
    queryKey: qk.staff(schoolId, params),
    queryFn: () => api.staff.list(schoolId, params),
  })
  const departmentsQuery = useQuery({
    queryKey: qk.departments(schoolId),
    queryFn: () => api.staff.departments(schoolId),
  })

  const rows = staffQuery.data?.items ?? []
  const selectedIds = Object.keys(selection).filter((id) => selection[id])
  const hasFilters = Boolean(search.q || search.department)
  const clearFilters = () => { setSelection({}); void navigate({ search: { page: 1 } }) }

  const columns = useMemo<ColumnDef<StaffRow, any>[]>(() => [
    {
      id: 'name',
      header: 'Staff',
      size: 260,
      cell: ({ row }) => (
        <EntityCell
          avatar={(
            <UserAvatar
              name={row.original.displayName}
              src={row.original.hasPhoto ? api.staff.photoUrl(schoolId, row.original.id, row.original.photoUpdatedAt) : undefined}
              size="sm"
            />
          )}
          name={row.original.displayName}
        />
      ),
    },
    { id: 'designation', header: 'Designation', cell: ({ row }) => row.original.designation },
    {
      id: 'department',
      header: 'Department',
      cell: ({ row }) => (row.original.department
        ? <Tag color={colorFor(row.original.department)}>{row.original.department}</Tag>
        : <span className="text-muted-foreground/60">—</span>),
    },
  ], [schoolId])

  if (isApiError(staffQuery.error, 'ACCESS_DENIED')) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Staff', icon: <Users /> }]} />
        <EmptyState icon={<Users />} title="You cannot see the staff directory" description="Ask the school owner if you need access to staff records." />
      </>
    )
  }

  if (staffQuery.error) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Staff', icon: <Users /> }]} />
        <EmptyState icon={<Users />} title="We could not load the staff directory" description={describeError(staffQuery.error)} />
      </>
    )
  }

  const total = staffQuery.data?.total ?? 0

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Staff', icon: <Users /> }]}
        badge={<Tag className="ml-2">{total}</Tag>}
        actions={
          hasPermission('staff.create')
            ? <Button size="sm" onClick={() => void navigate({ to: '/staff/new' })}><Plus />Add staff</Button>
            : undefined
        }
      />
      <Toolbar
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search.q ?? ''}
              onChange={(event) => setSearch({ q: event.target.value.slice(0, SEARCH_MAX) || undefined })}
              maxLength={SEARCH_MAX}
              placeholder="Search name or employee code"
              aria-label="Search staff"
              className="h-9 w-full pl-8 md:w-64"
            />
          </div>
        }
      >
        <FilterChip
          label="Department"
          value={search.department}
          options={(departmentsQuery.data ?? []).map((name) => ({ value: name, label: name }))}
          onChange={(value) => setSearch({ department: value })}
          allLabel="All departments"
        />
      </Toolbar>

      <div className="relative flex min-h-0 flex-1 flex-col">
        <DataTable
          columns={columns}
          data={rows}
          isLoading={staffQuery.isLoading}
          selectable={canExport}
          rowSelection={selection}
          onRowSelectionChange={setSelection}
          getRowId={(row: StaffRow) => row.id}
          rowLink={(row: StaffRow) => `/staff/${row.id}`}
          mobileRow={(row: StaffRow) => ({
            title: row.displayName,
            subtitle: row.designation,
            trailing: row.department ? <Tag color={colorFor(row.department)}>{row.department}</Tag> : undefined,
          })}
          emptyState={
            <EmptyState
              icon={<Users />}
              title="No staff to show"
              description="Try another search, or a different department."
              action={hasFilters ? <Button variant="outline" size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
            />
          }
          pagination={{ page: search.page, pageSize: PAGE_SIZE, total, onPageChange: setPage }}
          footer={
            <>
              <span>{rows.length} staff in view</span>
              <span>{total} in total</span>
            </>
          }
        />
        {canExport && <StaffBulkBar ids={selectedIds} onClear={() => setSelection({})} />}
      </div>
    </>
  )
}
