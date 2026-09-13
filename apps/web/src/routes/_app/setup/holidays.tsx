import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { MoreHorizontal, PartyPopper, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { HolidayType, type Holiday } from '@erp/shared'
import { api } from '@/api/client'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { FilterChip } from '@/components/shared/filter-chip'
import { Tag, type TagColor } from '@/components/shared/tag'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { HolidaySheet } from '@/components/setup/holiday-sheet'
import { MonthStrip } from '@/components/setup/month-strip'
import { holidayDays, holidayRange, monthCounts } from '@/components/setup/holiday-utils'
import { useAcademicYears } from '@/components/setup/use-current-year'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { humanize } from '@/lib/utils'

export const Route = createFileRoute('/_app/setup/holidays')({ component: Page })

const TYPE_COLOR: Record<Holiday['type'], TagColor> = { national: 'orange', festival: 'purple', vacation: 'blue', school: 'teal' }

function Page() {
  const canEdit = useSession().can('school_setup', 'edit')
  const qc = useQueryClient()
  const { years, current } = useAcademicYears()
  const [yearId, setYearId] = useState<string | undefined>()
  const [type, setType] = useState<Holiday['type'] | undefined>()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<Holiday | undefined>()
  const [selection, setSelection] = useState<RowSelectionState>({})

  const activeYearId = yearId ?? current?.id ?? ''
  const activeYear = years.find((y) => y.id === activeYearId)

  const { data: holidays = [], isLoading } = useQuery({
    queryKey: qk.holidays(activeYearId),
    queryFn: () => api.holidays.list(activeYearId),
    enabled: !!activeYearId,
  })

  const rows = useMemo(() => (type ? holidays.filter((h) => h.type === type) : holidays), [holidays, type])
  const months = useMemo(() => monthCounts(rows, activeYear ? new Date(activeYear.startDate).getFullYear() : new Date().getFullYear()), [rows, activeYear])
  const totalDays = rows.reduce((a, h) => a + holidayDays(h), 0)

  const remove = useMutation({
    mutationFn: (id: string) => api.holidays.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['holidays'] }); toast.success('Holiday removed') },
    onError: (e: Error) => toast.error(e.message),
  })

  const columns = useMemo<ColumnDef<Holiday, unknown>[]>(() => [
    { id: 'name', header: 'Holiday name', accessorFn: (r) => r.name, cell: ({ row }) => <EntityCell avatar={<PartyPopper />} name={row.original.name} /> },
    { id: 'dates', header: 'Dates', size: 220, accessorFn: (r) => r.startDate, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{holidayRange(row.original)}</span> },
    { id: 'days', header: 'Days', size: 90, accessorFn: (r) => holidayDays(r), cell: ({ row }) => <span className="tabular-nums">{holidayDays(row.original)}</span> },
    { id: 'type', header: 'Type', size: 150, accessorFn: (r) => r.type, cell: ({ row }) => <Tag color={TYPE_COLOR[row.original.type]}>{humanize(row.original.type)}</Tag> },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => canEdit ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSheetOpen(true) }}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => remove.mutate(row.original.id)}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [canEdit, remove])

  return (
    <>
      <PageHeader crumbs={[{ label: 'School setup' }, { label: 'Holidays' }]} hideOnMobile />
      <SetupTabs />
      <Toolbar
        right={canEdit ? <Button size="sm" disabled={!activeYearId} onClick={() => { setEditing(undefined); setSheetOpen(true) }}><Plus /> Add holiday</Button> : undefined}
      >
        <FilterChip
          label="Year"
          value={activeYearId || undefined}
          options={years.map((y) => ({ value: y.id, label: y.name }))}
          onChange={(v) => setYearId(v ?? current?.id)}
          clearable={false}
          allLabel="Current year"
        />
        <FilterChip
          label="Type"
          value={type}
          options={HolidayType.options.map((t) => ({ value: t, label: humanize(t) }))}
          onChange={setType}
          allLabel="All types"
        />
      </Toolbar>
      <MonthStrip months={months} />
      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        selectable
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        getRowId={(r) => r.id}
        emptyState={<EmptyState icon={<PartyPopper />} title="No holidays yet" description="Add festivals, national holidays and vacations for this year." />}
        footer={<span>{rows.length} {rows.length === 1 ? 'holiday' : 'holidays'} · {totalDays} days off</span>}
      />
      <HolidaySheet open={sheetOpen} onOpenChange={setSheetOpen} holiday={editing} academicYearId={activeYearId} />
    </>
  )
}
