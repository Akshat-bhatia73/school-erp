import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { CalendarDays, Info, MoreHorizontal, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag, type TagColor } from '@/components/shared/tag'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { AcademicYearSheet } from '@/components/setup/academic-year-sheet'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import type { AcademicYearRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate, humanize } from '@/lib/utils'

export const Route = createFileRoute('/_app/setup/academic-years')({ component: Page })

const STATUS_COLOR: Record<AcademicYearRecord['status'], TagColor> = { current: 'green', upcoming: 'blue', closed: 'grey' }

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const canManage = hasPermission('academic_years.manage')
  const queryClient = useQueryClient()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<AcademicYearRecord | undefined>()

  const { data: years = [], isLoading, error } = useQuery({
    queryKey: qk.academicYears(schoolId),
    queryFn: () => api.setup.academicYears(schoolId),
  })

  const makeCurrent = useMutation({
    mutationFn: (year: AcademicYearRecord) => api.setup.updateAcademicYear(schoolId, year.id, {
      name: year.name,
      startDate: year.startDate,
      endDate: year.endDate,
      status: 'current',
      expectedVersion: year.version,
    }),
    onSuccess: () => {
      // A new current year changes what every other screen reads, so clear the whole school.
      void queryClient.invalidateQueries({ queryKey: qk.all(schoolId) })
      toast.success('Saved changes')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const makeCurrentMutate = makeCurrent.mutate
  const columns = useMemo<ColumnDef<AcademicYearRecord, unknown>[]>(() => [
    { id: 'name', header: 'Name', accessorFn: (r) => r.name, cell: ({ row }) => <EntityCell avatar={<CalendarDays />} name={row.original.name} /> },
    { id: 'start', header: 'Start', size: 160, accessorFn: (r) => r.startDate, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatDate(row.original.startDate)}</span> },
    { id: 'end', header: 'End', size: 160, accessorFn: (r) => r.endDate, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{formatDate(row.original.endDate)}</span> },
    { id: 'status', header: 'Status', size: 150, accessorFn: (r) => r.status, cell: ({ row }) => <Tag color={STATUS_COLOR[row.original.status]} dot>{humanize(row.original.status)}</Tag> },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => canManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {row.original.status !== 'current' && <DropdownMenuItem onClick={() => makeCurrentMutate(row.original)}>Make current</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSheetOpen(true) }}>Edit</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [canManage, makeCurrentMutate])

  const addButton = (label: string) => (
    <Button size="sm" onClick={() => { setEditing(undefined); setSheetOpen(true) }}><Plus /> {label}</Button>
  )

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'School setup' }, { label: 'Academic years' }]}
        actions={canManage ? addButton('Add academic year') : undefined}
        hideOnMobile
      />
      <SetupTabs actions={canManage ? addButton('Add year') : undefined} />
      <div className="border-b bg-card px-3 py-2 md:px-5 md:py-3">
        <Alert>
          <Info />
          <AlertTitle>The current year drives the whole school</AlertTitle>
          <AlertDescription>The current year is used for enrolment, attendance and fees. April to March is the default.</AlertDescription>
        </Alert>
      </div>
      {error ? (
        <p className="p-5 text-[13.5px] text-muted-foreground">{describeError(error)}</p>
      ) : (
        <DataTable
          columns={columns}
          data={years}
          isLoading={isLoading}
          getRowId={(r) => r.id}
          emptyState={<EmptyState icon={<CalendarDays />} title="No academic years yet" description="Add a year like 2027-28 to start enrolling students." />}
          footer={<span>{years.length} {years.length === 1 ? 'year' : 'years'} in view</span>}
        />
      )}
      <AcademicYearSheet open={sheetOpen} onOpenChange={setSheetOpen} year={editing} />
    </>
  )
}
