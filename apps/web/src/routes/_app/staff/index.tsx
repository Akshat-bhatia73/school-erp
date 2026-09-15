/** The staff directory. The server bounds the list; this screen only pages, searches and sorts it. */
import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { Download, Plus, Search, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import type { StaffPage } from '@/lib/api/staff'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { describeError, isApiError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export const Route = createFileRoute('/_app/staff/')({ component: Page })

type StaffRow = StaffPage['items'][number]

const PAGE_SIZE = 25
const SEARCH_MAX = 100
const EXPORT_MAX = 100

function Page() {
  const navigate = useNavigate()
  const { schoolId, hasPermission } = useSchoolContext()

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [department, setDepartment] = useState<string | undefined>()
  const [selection, setSelection] = useState<RowSelectionState>({})
  const [exportJobId, setExportJobId] = useState<string | null>(null)

  const term = search.trim().slice(0, SEARCH_MAX)
  const params = { page, pageSize: PAGE_SIZE, sort: 'name' as const, search: term === '' ? undefined : term }
  const staffQuery = useQuery({
    queryKey: qk.staff(schoolId, params),
    queryFn: () => api.staff.list(schoolId, params),
  })
  const departmentsQuery = useQuery({
    queryKey: qk.departments(schoolId),
    queryFn: () => api.staff.departments(schoolId),
  })

  const items = useMemo(() => staffQuery.data?.items ?? [], [staffQuery.data])
  // The server has no department filter, so this narrows the page already loaded and nothing more.
  const rows = useMemo(
    () => (department ? items.filter((row) => row.department === department) : items),
    [items, department],
  )

  const exportJob = useQuery({
    queryKey: qk.exportJob(schoolId, exportJobId ?? 'none'),
    queryFn: () => api.files.exportJob(schoolId, exportJobId as string),
    enabled: exportJobId !== null,
    refetchInterval: (query) => (query.state.data?.status === 'queued' ? 3000 : false),
  })

  const startExport = useMutation({
    mutationFn: (staffIds: string[]) => api.staff.export(schoolId, { staffIds }),
    onSuccess: (job) => {
      setExportJobId(job.id)
      toast.success('Export started')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const selectedIds = Object.keys(selection).filter((id) => selection[id])

  const columns = useMemo<ColumnDef<StaffRow, any>[]>(() => [
    {
      id: 'name',
      header: 'Staff',
      size: 260,
      cell: ({ row }) => (
        <EntityCell avatar={<UserAvatar name={row.original.displayName} size="sm" />} name={row.original.displayName} />
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
  ], [])

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
          <>
            {hasPermission('staff.export') && (
              <Button
                variant="outline"
                size="sm"
                disabled={selectedIds.length === 0 || selectedIds.length > EXPORT_MAX || startExport.isPending}
                title={
                  selectedIds.length === 0
                    ? 'Select staff to export'
                    : selectedIds.length > EXPORT_MAX
                      ? `You can export up to ${EXPORT_MAX} staff at a time`
                      : undefined
                }
                onClick={() => startExport.mutate(selectedIds)}
              >
                <Download />Export
              </Button>
            )}
            {hasPermission('staff.create') && (
              <Button size="sm" onClick={() => navigate({ to: '/staff/new' })}><Plus />Add staff</Button>
            )}
          </>
        }
      />
      <Toolbar
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => { setSearch(event.target.value.slice(0, SEARCH_MAX)); setPage(1); setSelection({}) }}
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
          value={department}
          options={(departmentsQuery.data ?? []).map((name) => ({ value: name, label: name }))}
          onChange={(value) => { setDepartment(value); setSelection({}) }}
          allLabel="All departments"
        />
      </Toolbar>

      {exportJobId !== null && (
        <div className="border-b bg-card px-3 py-2 text-[12.5px] text-muted-foreground md:px-5">
          {exportJob.data?.status === 'ready'
            ? 'Your export is ready. Downloading is not built yet, so ask the office for the file.'
            : exportJob.data?.status === 'failed'
              ? 'The export did not finish. Try again.'
              : exportJob.data?.status === 'expired'
                ? 'That export has expired. Start a new one.'
                : 'Preparing your export…'}
        </div>
      )}

      <DataTable
        columns={columns}
        data={rows}
        isLoading={staffQuery.isLoading}
        selectable
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        getRowId={(row: StaffRow) => row.id}
        rowLink={(row: StaffRow) => `/staff/${row.id}`}
        mobileRow={(row: StaffRow) => ({
          title: row.displayName,
          subtitle: row.designation,
          trailing: row.department ? <Tag color={colorFor(row.department)}>{row.department}</Tag> : undefined,
        })}
        emptyState={<EmptyState icon={<Users />} title="No staff to show" description="Try another search, or clear the department filter." />}
        pagination={{ page, pageSize: PAGE_SIZE, total, onPageChange: (next: number) => { setPage(next); setSelection({}) } }}
        footer={
          <>
            <span>{rows.length} staff in view</span>
            {department && <span>filtered on this page</span>}
            <span>{total} in the school</span>
          </>
        }
      />
    </>
  )
}
