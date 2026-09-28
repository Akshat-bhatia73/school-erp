/**
 * Leave the office recorded ahead of time, for pupils and for staff.
 *
 * Each kind is its own read, bounded by the server: a teacher sees the leave of their own sections
 * (and only their own staff leave), a parent their own child's. The when chip picks the range the
 * server is asked for; the name search only narrows the list already loaded.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { CalendarOff, ClipboardCheck, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { z } from 'zod'
import { describeAttendanceError } from '@/components/attendance/labels'
import { CancelLeaveDialog, LeaveStatusTag, leaveRange, RecordLeaveSheet, type LeaveKind, type LeaveRow } from '@/components/attendance/leave'
import { shiftDate, todayIso } from '@/components/attendance/month-chip'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import type { LeaveListParams } from '@/lib/api/leave'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn, formatDate } from '@/lib/utils'

const WHEN = ['today', 'upcoming', 'past', 'all'] as const
type When = (typeof WHEN)[number]

const searchSchema = z.object({
  kind: z.enum(['students', 'staff']).optional().catch(undefined),
  when: z.enum(WHEN).optional().catch(undefined),
  cancelled: z.boolean().optional().catch(undefined),
})

export const Route = createFileRoute('/_app/attendance/leave/')({ component: Page, validateSearch: searchSchema })

const WHEN_OPTIONS: Array<{ value: When; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'upcoming', label: 'Now and upcoming' },
  { value: 'past', label: 'Past' },
  { value: 'all', label: 'All' },
]

/** Far enough back that "All" misses nothing the school ever recorded. */
const EARLIEST = '2000-01-01'

/**
 * The range the server is asked for. With neither end the server answers the leave that has not
 * ended before today, which is exactly "now and upcoming".
 */
function rangeFor(when: When): Pick<LeaveListParams, 'from' | 'to'> {
  const today = todayIso()
  if (when === 'today') return { from: today, to: today }
  if (when === 'past') return { to: shiftDate(today, -1) }
  if (when === 'all') return { from: EARLIEST }
  return {}
}

const KIND_KEYS: Record<LeaveKind, { read: 'attendance.read' | 'staff_attendance.read'; manage: 'attendance.manage' | 'staff_attendance.manage' }> = {
  students: { read: 'attendance.read', manage: 'attendance.manage' },
  staff: { read: 'staff_attendance.read', manage: 'staff_attendance.manage' },
}

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { schoolId, hasPermission } = useSchoolContext()

  const kinds = (['students', 'staff'] as const).filter((kind) => hasPermission(KIND_KEYS[kind].read))
  const kind: LeaveKind | undefined = search.kind && kinds.includes(search.kind) ? search.kind : kinds[0]
  const when: When = search.when ?? 'upcoming'
  const includeCancelled = search.cancelled === true
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [cancelling, setCancelling] = useState<LeaveRow | null>(null)

  const params: LeaveListParams = { ...rangeFor(when), ...(includeCancelled ? { includeCancelled: 'true' } : {}) }
  const pupilsQuery = useQuery({
    queryKey: qk.leave.students(schoolId, params),
    queryFn: () => api.leave.listStudents(schoolId, params),
    enabled: kind === 'students',
  })
  const staffQuery = useQuery({
    queryKey: qk.leave.staff(schoolId, params),
    queryFn: () => api.leave.listStaff(schoolId, params),
    enabled: kind === 'staff',
  })
  const active = kind === 'staff' ? staffQuery : pupilsQuery

  const rows = useMemo<LeaveRow[]>(() => {
    if (kind === 'staff') {
      return (staffQuery.data?.items ?? []).map((item) => ({
        id: item.id,
        version: item.version,
        personId: item.staff.id,
        name: item.staff.name,
        sub: item.staff.designation,
        startsOn: item.startsOn,
        endsOn: item.endsOn,
        days: item.days,
        reason: item.reason,
        status: item.status,
        recordedBy: item.recordedBy,
        allowedActions: item.allowedActions,
      }))
    }
    return (pupilsQuery.data?.items ?? []).map((item) => ({
      id: item.id,
      version: item.version,
      personId: item.student.id,
      name: item.student.name,
      sub: item.grade ? (item.section ? `${item.grade.name} - ${item.section.name}` : item.grade.name) : item.student.admissionNumber,
      startsOn: item.startsOn,
      endsOn: item.endsOn,
      days: item.days,
      reason: item.reason,
      status: item.status,
      recordedBy: item.recordedBy,
      allowedActions: item.allowedActions,
    }))
  }, [kind, pupilsQuery.data, staffQuery.data])

  const needle = text.trim().toLowerCase()
  const visible = needle ? rows.filter((row) => row.name.toLowerCase().includes(needle)) : rows

  const manageKey = kind ? KIND_KEYS[kind].manage : undefined
  // The list's own answer wins once it has arrived; until then the session says whether the key exists at all.
  const listActions = active.data?.allowedActions
  const canRecord = manageKey !== undefined && (listActions ? allows(listActions, manageKey) : hasPermission(manageKey))

  const columns = useMemo<ColumnDef<LeaveRow, unknown>[]>(() => {
    // The name opens the person's attendance month, where the leave days show on the calendar.
    const personLink = (row: LeaveRow) => kind === 'staff' ? `/attendance/staff/${row.personId}` : `/attendance/students/${row.personId}`
    return [
    {
      id: 'name',
      header: 'Name',
      size: 240,
      cell: ({ row }) => (
        <Link to={personLink(row.original)} className="block rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <EntityCell name={row.original.name} sub={row.original.sub} />
        </Link>
      ),
    },
    { id: 'from', header: 'From', size: 120, cell: ({ row }) => formatDate(row.original.startsOn) },
    { id: 'to', header: 'To', size: 120, cell: ({ row }) => formatDate(row.original.endsOn) },
    { id: 'days', header: 'Days', size: 80, cell: ({ row }) => <span className="tabular-nums">{row.original.days}</span> },
    { id: 'reason', header: 'Reason', cell: ({ row }) => <span className="block max-w-72 truncate text-muted-foreground">{row.original.reason ?? '—'}</span> },
    { id: 'status', header: 'Status', size: 110, cell: ({ row }) => <LeaveStatusTag status={row.original.status} /> },
    { id: 'recordedBy', header: 'Recorded by', size: 160, cell: ({ row }) => <span className="text-muted-foreground">{row.original.recordedBy ?? '—'}</span> },
    {
      id: 'actions',
      header: '',
      size: 130,
      cell: ({ row }) => (manageKey && row.original.status === 'active' && allows(row.original.allowedActions, manageKey)
        ? <Button size="sm" variant="outline" onClick={() => setCancelling(row.original)}>Cancel leave</Button>
        : null),
    },
    ]
  }, [kind, manageKey])

  const header = (
    <PageHeader
      crumbs={[{ label: 'Attendance', to: '/attendance', icon: <ClipboardCheck /> }, { label: 'Leave' }]}
      actions={canRecord ? <Button size="sm" onClick={() => setRecording(true)}><Plus />Record leave</Button> : undefined}
    />
  )

  if (!kind) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Attendance', to: '/attendance', icon: <ClipboardCheck /> }, { label: 'Leave' }]} />
        <EmptyState icon={<CalendarOff />} title="Leave is not available" description="You do not have access to anybody's leave." />
      </>
    )
  }

  const setSearch = (patch: Partial<z.infer<typeof searchSchema>>) =>
    void navigate({ search: (old: z.infer<typeof searchSchema>) => ({ ...old, ...patch }), replace: true })

  return (
    <>
      {header}
      {kinds.length > 1 && (
        <div role="tablist" aria-label="Whose leave" className="flex shrink-0 items-center gap-1 border-b bg-card px-3">
          {kinds.map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={option === kind}
              onClick={() => { setText(''); setSearch({ kind: option }) }}
              className={cn(
                'relative flex h-10 shrink-0 items-center px-2.5 text-[13.5px] text-muted-foreground hover:text-foreground md:h-11',
                option === kind && 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground',
              )}
            >
              {option === 'students' ? 'Students' : 'Staff'}
            </button>
          ))}
        </div>
      )}
      <Toolbar
        search={(
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="Search by name" aria-label="Search by name" className="h-8 w-full pl-8 md:w-56" />
          </div>
        )}
      >
        <FilterChip<When>
          label="When"
          value={when}
          options={WHEN_OPTIONS}
          clearable={false}
          onChange={(value) => setSearch({ when: value ?? 'upcoming' })}
        />
        <label className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap text-[13px] text-muted-foreground">
          <Switch checked={includeCancelled} onCheckedChange={(checked) => setSearch({ cancelled: checked ? true : undefined })} aria-label="Show cancelled" />
          Show cancelled
        </label>
      </Toolbar>
      {active.isError ? (
        <EmptyState icon={<CalendarOff />} title="Leave is not available" description={describeAttendanceError(active.error)} />
      ) : (
        <DataTable
          columns={columns}
          data={visible}
          isLoading={active.isLoading}
          getRowId={(row) => row.id}
          mobileRow={(row) => ({
            title: row.name,
            subtitle: `${leaveRange(row.startsOn, row.endsOn)}${row.sub ? ` · ${row.sub}` : ''}`,
            trailing: (
              <>
                <LeaveStatusTag status={row.status} />
                {manageKey && row.status === 'active' && allows(row.allowedActions, manageKey) && (
                  <Button size="sm" variant="outline" onClick={() => setCancelling(row)}>Cancel leave</Button>
                )}
              </>
            ),
          })}
          emptyState={(
            <EmptyState
              icon={<CalendarOff />}
              title="Nobody on leave"
              description={needle ? 'Nobody with that name has leave in this range.' : 'No leave is recorded for this range.'}
            />
          )}
          footer={<span>{visible.length} on leave in view</span>}
        />
      )}
      <RecordLeaveSheet kind={kind} open={recording} onOpenChange={setRecording} />
      <CancelLeaveDialog kind={kind} row={cancelling} onOpenChange={(open) => { if (!open) setCancelling(null) }} />
    </>
  )
}
