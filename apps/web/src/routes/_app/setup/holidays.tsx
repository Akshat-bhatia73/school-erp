import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { MoreHorizontal, PartyPopper, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { FilterChip } from '@/components/shared/filter-chip'
import { Tag, type TagColor } from '@/components/shared/tag'
import { SetupTabs } from '@/components/setup/setup-tabs'
import { HolidaySheet, HOLIDAY_TYPES } from '@/components/setup/holiday-sheet'
import { MonthStrip } from '@/components/setup/month-strip'
import { currentStartYear, holidayDays, holidayRange, monthCounts, parseDate } from '@/components/setup/holiday-utils'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { api } from '@/lib/api'
import type { HolidayRecord } from '@/lib/api/setup'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { allows } from '@/lib/permissions'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { humanize } from '@/lib/utils'

export const Route = createFileRoute('/_app/setup/holidays')({ component: Page })

const TYPE_COLOR: Record<HolidayRecord['type'], TagColor> = { national: 'orange', festival: 'purple', vacation: 'blue', school: 'teal' }

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const canManage = hasPermission('holidays.manage')
  const queryClient = useQueryClient()
  const { years, current, currentYearId, isLoading: yearLoading } = useAcademicYear()
  const [pickedYearId, setPickedYearId] = useState<string | undefined>()
  const [type, setType] = useState<HolidayRecord['type'] | undefined>()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<HolidayRecord | undefined>()
  const [pending, setPending] = useState<HolidayRecord | null>(null)

  const activeYearId = pickedYearId ?? currentYearId ?? ''
  // The year chip only exists for somebody who reads the year list; everybody else gets the current
  // year the server named.
  const activeYear = years.find((year) => year.id === activeYearId) ?? (activeYearId === current?.id ? current : undefined)
  // The year filter is optional on the server, so somebody who cannot read years (a teacher or a
  // parent) still gets the whole school's holidays rather than a blank screen.
  const params = activeYearId ? { academicYearId: activeYearId } : {}

  const { data: holidays = [], isLoading, error } = useQuery({
    queryKey: qk.holidays(schoolId, params),
    queryFn: () => api.setup.holidays(schoolId, params),
    enabled: !yearLoading,
  })

  // The list endpoint filters by year only, so the type chip narrows the year already loaded.
  const rows = useMemo(() => (type ? holidays.filter((holiday) => holiday.type === type) : holidays), [holidays, type])
  const months = useMemo(
    () => monthCounts(rows, activeYear ? parseDate(activeYear.startDate).getFullYear() : currentStartYear()),
    [rows, activeYear],
  )
  const totalDays = rows.reduce((sum, holiday) => sum + holidayDays(holiday), 0)

  const remove = useMutation({
    mutationFn: (holiday: HolidayRecord) => api.setup.deleteHoliday(schoolId, holiday.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'holidays'] })
      toast.success('Holiday removed')
      setPending(null)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const columns = useMemo<ColumnDef<HolidayRecord, unknown>[]>(() => [
    { id: 'name', header: 'Holiday name', accessorFn: (r) => r.name, cell: ({ row }) => <EntityCell avatar={<PartyPopper />} name={row.original.name} /> },
    { id: 'dates', header: 'Dates', size: 220, accessorFn: (r) => r.startDate, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{holidayRange(row.original)}</span> },
    { id: 'days', header: 'Days', size: 90, accessorFn: (r) => holidayDays(r), cell: ({ row }) => <span className="tabular-nums">{holidayDays(row.original)}</span> },
    { id: 'type', header: 'Type', size: 150, accessorFn: (r) => r.type, cell: ({ row }) => <Tag color={TYPE_COLOR[row.original.type]}>{humanize(row.original.type)}</Tag> },
    {
      id: 'actions', header: '', size: 60, enableSorting: false,
      cell: ({ row }) => allows(row.original.allowedActions, 'holidays.manage') ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label={`Actions for ${row.original.name}`} onClick={(e) => e.stopPropagation()}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setEditing(row.original); setSheetOpen(true) }}>Edit</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setPending(row.original)}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null,
    },
  ], [])

  return (
    <>
      <PageHeader crumbs={[{ label: 'School setup' }, { label: 'Holidays' }]} hideOnMobile />
      <SetupTabs />
      <Toolbar
        right={canManage ? (
          <Button size="sm" disabled={!activeYearId} title={activeYearId ? undefined : 'Pick an academic year first'} onClick={() => { setEditing(undefined); setSheetOpen(true) }}>
            <Plus /> Add holiday
          </Button>
        ) : undefined}
      >
        {years.length > 0 && (
          <FilterChip
            label="Year"
            value={activeYearId || undefined}
            options={years.map((year) => ({ value: year.id, label: year.name }))}
            onChange={(v) => setPickedYearId(v ?? undefined)}
            clearable={false}
            allLabel="Current year"
          />
        )}
        <FilterChip
          label="Type"
          value={type}
          options={HOLIDAY_TYPES.map((t) => ({ value: t, label: humanize(t) }))}
          onChange={setType}
          allLabel="All types"
        />
      </Toolbar>
      {error ? (
        <p className="p-5 text-[13.5px] text-muted-foreground">{describeError(error)}</p>
      ) : (
        <>
          <MonthStrip months={months} />
          <DataTable
            columns={columns}
            data={rows}
            isLoading={isLoading || yearLoading}
            getRowId={(r) => r.id}
            emptyState={<EmptyState icon={<PartyPopper />} title="No holidays yet" description="Add festivals, national holidays and vacations for this year." />}
            footer={<span>{rows.length} {rows.length === 1 ? 'holiday' : 'holidays'} · {totalDays} days off{type ? ` · ${humanize(type)} only` : ''}</span>}
          />
        </>
      )}
      <HolidaySheet open={sheetOpen} onOpenChange={setSheetOpen} holiday={editing} academicYearId={activeYearId} />
      <AlertDialog open={pending !== null} onOpenChange={(open) => { if (!open) setPending(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {pending?.name}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. The days go back to being working days.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={(event) => { event.preventDefault(); if (pending) remove.mutate(pending) }}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
