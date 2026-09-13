import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { CalendarDays, Info, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import type { AcademicYear } from '@erp/shared'
import { api } from '@/api/client'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag, type TagColor } from '@/components/shared/tag'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { AcademicYearSheet } from '@/components/setup/academic-year-sheet'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { formatDate, humanize } from '@/lib/utils'

export const Route = createFileRoute('/_app/setup/academic-years')({ component: Page })

const STATUS_COLOR: Record<AcademicYear['status'], TagColor> = { current: 'green', upcoming: 'blue', closed: 'grey' }

function Page() {
  const { can } = useSession()
  const canEdit = can('school_setup', 'edit')
  const qc = useQueryClient()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<AcademicYear | undefined>()
  const [selection, setSelection] = useState<RowSelectionState>({})

  const { data: years = [], isLoading } = useQuery({ queryKey: qk.academicYears, queryFn: () => api.academicYears.list() })

  const makeCurrent = useMutation({
    mutationFn: (y: AcademicYear) => api.academicYears.update(y.id, { status: 'current' }),
    onSuccess: (y) => { qc.invalidateQueries({ queryKey: qk.academicYears }); qc.invalidateQueries(); toast.success(`${y.name} is now the current year`) },
    onError: (e: Error) => toast.error(e.message),
  })

  const columns = useMemo<ColumnDef<AcademicYear, unknown>[]>(() => [
    { id: 'name', header: 'Name', accessorFn: (r) => r.name, cell: ({ row }) => <EntityCell avatar={<CalendarDays />} name={row.original.name} /> },
    { id: 'start', header: 'Start', size: 160, accessorFn: (r) => r.startDate, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatDate(row.original.startDate)}</span> },
    { id: 'end', header: 'End', size: 160, accessorFn: (r) => r.endDate, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatDate(row.original.endDate)}</span> },
    { id: 'status', header: 'Status', size: 150, accessorFn: (r) => r.status, cell: ({ row }) => <Tag color={STATUS_COLOR[row.original.status]} dot>{humanize(row.original.status)}</Tag> },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => canEdit ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.original.status !== 'current' && <DropdownMenuItem onClick={() => makeCurrent.mutate(row.original)}>Make current</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSheetOpen(true) }}>Edit</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [canEdit, makeCurrent])

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'School setup' }, { label: 'Academic years' }]}
        actions={canEdit ? <Button size="sm" onClick={() => { setEditing(undefined); setSheetOpen(true) }}><Plus /> Add academic year</Button> : undefined}
        hideOnMobile
      />
      <SetupTabs actions={canEdit ? <Button size="sm" onClick={() => { setEditing(undefined); setSheetOpen(true) }}><Plus /> Add year</Button> : undefined} />
      <div className="border-b bg-card px-5 py-3">
        <Alert>
          <Info />
          <AlertTitle>The current year drives the whole school</AlertTitle>
          <AlertDescription>The current year is used for enrolment, attendance and fees. April to March is the default.</AlertDescription>
        </Alert>
      </div>
      <DataTable
        columns={columns}
        data={years}
        isLoading={isLoading}
        selectable
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        getRowId={(r) => r.id}
        emptyState={<EmptyState icon={<CalendarDays />} title="No academic years yet" description="Add a year like 2027-28 to start enrolling students." />}
        footer={<span>{years.length} {years.length === 1 ? 'year' : 'years'} in view</span>}
      />
      <AcademicYearSheet open={sheetOpen} onOpenChange={setSheetOpen} year={editing} />
    </>
  )
}
