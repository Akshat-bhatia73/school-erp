/**
 * Leave: applications and the leave the office recorded ahead of time.
 *
 * Views, each shown only to somebody it has something for: Requests (applications this person may
 * decide, waiting ones first, with a badge), My leave (a staff member's own applications), a
 * parent's Applications for their children, and the recorded leave of pupils and of staff.
 *
 * Each record kind is its own read, bounded by the server: a teacher sees the leave of their own sections
 * (and only their own staff leave), a parent their own child's. The when chip picks the range the
 * server is asked for; the name search only narrows the list already loaded.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { CalendarOff, ClipboardCheck, Plus, Search } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { z } from 'zod'
import { LEAVE_TYPE_LABELS, LeaveApplicationStatus } from '@erp/contracts'
import { describeAttendanceError } from '@/components/attendance/labels'
import { CancelLeaveDialog, LeaveStatusTag, leaveRange, RecordLeaveSheet, type LeaveKind, type LeaveRow } from '@/components/attendance/leave'
import {
  ApplicationStatusTag, ApplyLeaveSheet, canDecide, canWithdraw, DecideLeaveDialog, STATUS_OPTIONS, WithdrawLeaveDialog,
  type ApplicationRow, type Decision,
} from '@/components/attendance/leave-applications'
import { shiftDate, todayIso } from '@/components/attendance/month-chip'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import type { LeaveListParams } from '@/lib/api/leave'
import { allows, audiencesFor } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn, formatDate } from '@/lib/utils'

const WHEN = ['today', 'upcoming', 'past', 'all'] as const
type When = (typeof WHEN)[number]

const VIEWS = ['requests', 'mine', 'children', 'students', 'staff'] as const
type View = (typeof VIEWS)[number]

const searchSchema = z.object({
  view: z.enum(VIEWS).optional().catch(undefined),
  /** The older link to a record view; `view` wins. */
  kind: z.enum(['students', 'staff']).optional().catch(undefined),
  /** Narrows the applications to one state. */
  status: LeaveApplicationStatus.optional().catch(undefined),
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


const CRUMBS = [{ label: 'Attendance', to: '/attendance', icon: <ClipboardCheck /> }, { label: 'Leave' }]

const VIEW_LABEL: Record<View, string> = {
  requests: 'Requests',
  mine: 'My leave',
  children: 'Applications',
  students: 'Students',
  staff: 'Staff',
}

/**
 * The applications this person reads. A decider and a parent read pupil applications; anybody on
 * the staff reads staff applications (their own, and the office everybody's). Both lists come from
 * one read each, shared by every view, so the Requests badge and the views never disagree.
 */
function useApplications() {
  const { schoolId, roleKeys, hasPermission } = useSchoolContext()
  const audiences = audiencesFor(roleKeys)
  const isFamily = audiences.includes('parent')
  const isStaff = audiences.some((audience) => audience === 'office' || audience === 'accountant' || audience === 'teacher')
  const canRead = hasPermission('leave_applications.read')
  const canDecideAny = hasPermission('leave_applications.decide')
  const readPupils = canRead && (canDecideAny || isFamily)
  const readStaff = canRead && isStaff

  const pupils = useQuery({
    queryKey: qk.leave.applications.pupils(schoolId, {}),
    queryFn: () => api.leave.applications.pupils.list(schoolId, {}),
    enabled: readPupils,
  })
  const staff = useQuery({
    queryKey: qk.leave.applications.staff(schoolId, {}),
    queryFn: () => api.leave.applications.staff.list(schoolId, {}),
    enabled: readStaff,
  })

  const pupilRows = useMemo<ApplicationRow[]>(() => (pupils.data?.items ?? []).map((item) => ({
    id: item.id,
    kind: 'students',
    version: item.version,
    personId: item.student.id,
    name: item.student.name,
    sub: item.grade ? (item.section ? `${item.grade.name} - ${item.section.name}` : item.grade.name) : item.student.admissionNumber,
    startsOn: item.startsOn,
    endsOn: item.endsOn,
    days: item.days,
    reason: item.reason,
    status: item.status,
    appliedAt: item.appliedAt,
    appliedBy: item.appliedBy,
    mine: item.mine,
    decidedAt: item.decidedAt,
    decidedBy: item.decidedBy,
    decisionNote: item.decisionNote,
    allowedActions: item.allowedActions,
  })), [pupils.data])
  const staffRows = useMemo<ApplicationRow[]>(() => (staff.data?.items ?? []).map((item) => ({
    id: item.id,
    kind: 'staff',
    version: item.version,
    personId: item.staff.id,
    name: item.staff.name,
    sub: item.staff.designation,
    startsOn: item.startsOn,
    endsOn: item.endsOn,
    days: item.days,
    leaveType: item.leaveType,
    reason: item.reason,
    status: item.status,
    appliedAt: item.appliedAt,
    appliedBy: item.appliedBy,
    mine: item.mine,
    decidedAt: item.decidedAt,
    decidedBy: item.decidedBy,
    decisionNote: item.decisionNote,
    allowedActions: item.allowedActions,
  })), [staff.data])

  // Somebody else's applications, waiting ones first, then the newest.
  const requests = useMemo(() => [...pupilRows, ...staffRows]
    .filter((row) => !row.mine)
    .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.appliedAt.localeCompare(a.appliedAt)), [pupilRows, staffRows])
  const mine = useMemo(() => staffRows.filter((row) => row.mine), [staffRows])
  // A parent reads every application for their own children, whichever guardian made it; a parent
  // who also decides reads the school's, so their own view keeps to the ones they made.
  const children = useMemo(() => (canDecideAny ? pupilRows.filter((row) => row.mine) : pupilRows), [canDecideAny, pupilRows])

  const staffList = staff.data
  // No staff record (the list does not offer apply) and nothing of one's own: no "My leave".
  const hasOwnLeave = readStaff && hasPermission('leave_applications.apply')
    && !(staffList && !allows(staffList.allowedActions, 'leave_applications.apply') && !staffList.items.some((item) => item.mine))

  return {
    pupils,
    staff,
    requests,
    mine,
    children,
    showRequests: canDecideAny,
    showMine: hasOwnLeave,
    showChildren: readPupils && isFamily,
  }
}

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { hasPermission } = useSchoolContext()
  const applications = useApplications()

  const views: View[] = [
    ...(applications.showRequests ? ['requests' as const] : []),
    ...(applications.showMine ? ['mine' as const] : []),
    ...(applications.showChildren ? ['children' as const] : []),
    ...(['students', 'staff'] as const).filter((kind) => hasPermission(KIND_KEYS[kind].read)),
  ]
  // `kind` is the older link to a record view and still works.
  const asked = search.view ?? search.kind
  const view: View | undefined = asked && views.includes(asked) ? asked : views[0]

  if (!view) {
    return (
      <>
        <PageHeader crumbs={CRUMBS} />
        <EmptyState icon={<CalendarOff />} title="Leave is not available" description="You do not have access to anybody's leave." />
      </>
    )
  }

  const waiting = applications.requests.filter(canDecide).length
  const tabs = views.length > 1 ? (
    <div role="tablist" aria-label="Whose leave" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b bg-card px-3">
      {views.map((option) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={option === view}
          onClick={() => void navigate({ search: (old: z.infer<typeof searchSchema>) => ({ ...old, view: option, kind: undefined, status: undefined }), replace: true })}
          className={cn(
            'relative flex h-10 shrink-0 items-center gap-1.5 px-2.5 text-[13.5px] text-muted-foreground hover:text-foreground md:h-11',
            option === view && 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground',
          )}
        >
          {VIEW_LABEL[option]}
          {option === 'requests' && waiting > 0 && (
            <span aria-label={`${waiting} waiting`} className="rounded-full bg-tag-orange/12 px-1.5 text-[11.5px] font-medium tabular-nums text-tag-orange dark:bg-tag-orange/18">{waiting}</span>
          )}
        </button>
      ))}
    </div>
  ) : null

  if (view === 'students' || view === 'staff') return <RecordsView key={view} kind={view} tabs={tabs} />
  return <ApplicationsView key={view} view={view} tabs={tabs} applications={applications} />
}

/** Requests to decide, one's own leave, or a parent's applications for their children. */
function ApplicationsView({ view, tabs, applications }: {
  view: 'requests' | 'mine' | 'children'
  tabs: ReactNode
  applications: ReturnType<typeof useApplications>
}) {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const [text, setText] = useState('')
  const [applying, setApplying] = useState(false)
  const [deciding, setDeciding] = useState<{ row: ApplicationRow; decision: Decision } | null>(null)
  const [withdrawing, setWithdrawing] = useState<ApplicationRow | null>(null)

  const status = search.status
  const rows = view === 'requests' ? applications.requests : view === 'mine' ? applications.mine : applications.children
  const queries = view === 'requests'
    ? [applications.pupils, applications.staff]
    : view === 'mine' ? [applications.staff] : [applications.pupils]
  const failed = queries.find((query) => query.isError)
  const loading = queries.some((query) => query.isLoading)

  const needle = text.trim().toLowerCase()
  const visible = rows.filter((row) => (!status || row.status === status) && (!needle || row.name.toLowerCase().includes(needle)))
  const hasStaffRows = rows.some((row) => row.kind === 'staff')

  const applyKind: LeaveKind | undefined = view === 'mine' ? 'staff' : view === 'children' ? 'students' : undefined
  const applyList = view === 'mine' ? applications.staff.data : view === 'children' ? applications.pupils.data : undefined
  const canApply = applyKind !== undefined && applyList !== undefined && allows(applyList.allowedActions, 'leave_applications.apply')

  const actionsFor = (row: ApplicationRow) => (
    <div className="flex flex-wrap justify-end gap-1.5">
      {canDecide(row) && (
        <>
          <Button size="sm" onClick={() => setDeciding({ row, decision: 'approve' })}>Approve</Button>
          <Button size="sm" variant="outline" onClick={() => setDeciding({ row, decision: 'refuse' })}>Not approved</Button>
        </>
      )}
      {canWithdraw(row) && <Button size="sm" variant="outline" onClick={() => setWithdrawing(row)}>Withdraw</Button>}
    </div>
  )

  const columns = useMemo<ColumnDef<ApplicationRow, unknown>[]>(() => [
    {
      id: 'name',
      header: 'Name',
      size: 220,
      cell: ({ row }) => <EntityCell name={row.original.name} sub={row.original.sub} />,
    },
    { id: 'dates', header: 'Dates', size: 190, cell: ({ row }) => leaveRange(row.original.startsOn, row.original.endsOn) },
    { id: 'days', header: 'Days', size: 70, cell: ({ row }) => <span className="tabular-nums">{row.original.days}</span> },
    ...(hasStaffRows ? [{
      id: 'type',
      header: 'Type',
      size: 130,
      cell: ({ row }: { row: { original: ApplicationRow } }) => (row.original.leaveType ? LEAVE_TYPE_LABELS[row.original.leaveType] : 'Pupil leave'),
    }] : []),
    { id: 'reason', header: 'Reason', cell: ({ row }) => <span className="block max-w-72 truncate text-muted-foreground" title={row.original.reason}>{row.original.reason}</span> },
    {
      id: 'status',
      header: 'Status',
      size: 200,
      cell: ({ row }) => (
        <div className="min-w-0">
          <ApplicationStatusTag status={row.original.status} />
          {row.original.decisionNote && <p className="mt-1 max-w-56 truncate text-[12px] text-muted-foreground" title={row.original.decisionNote}>{row.original.decisionNote}</p>}
          {row.original.decidedBy && <p className="text-[12px] text-muted-foreground">{row.original.decidedBy}{row.original.decidedAt ? `, ${formatDate(row.original.decidedAt)}` : ''}</p>}
        </div>
      ),
    },
    {
      id: 'applied',
      header: 'Applied',
      size: 170,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.appliedBy ? `${row.original.appliedBy}, ` : ''}{formatDate(row.original.appliedAt)}
        </span>
      ),
    },
    { id: 'actions', header: '', size: 220, cell: ({ row }) => actionsFor(row.original) },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [hasStaffRows])

  const noun = view === 'requests' ? 'request' : 'application'
  const empty = view === 'requests'
    ? { title: 'No requests', description: status || needle ? 'No request matches.' : 'Nobody has applied for leave yet.' }
    : { title: 'No applications', description: status ? 'No application matches.' : 'Leave you apply for shows here with its answer.' }

  return (
    <>
      <PageHeader
        crumbs={CRUMBS}
        actions={canApply ? <Button size="sm" onClick={() => setApplying(true)}><Plus />Apply for leave</Button> : undefined}
      />
      {tabs}
      <Toolbar
        search={view === 'requests' ? (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={text} onChange={(event) => setText(event.target.value)} placeholder="Search by name" aria-label="Search by name" className="h-8 w-full pl-8 md:w-56" />
          </div>
        ) : undefined}
      >
        <FilterChip<LeaveApplicationStatus>
          label="Status"
          value={status}
          options={STATUS_OPTIONS}
          onChange={(value) => void navigate({ search: (old: z.infer<typeof searchSchema>) => ({ ...old, status: value ?? undefined }), replace: true })}
        />
      </Toolbar>
      {failed ? (
        <EmptyState icon={<CalendarOff />} title="Leave is not available" description={describeAttendanceError(failed.error)} />
      ) : (
        <DataTable
          columns={columns}
          data={visible}
          isLoading={loading}
          getRowId={(row) => `${row.kind}-${row.id}`}
          mobileRow={(row) => ({
            title: row.name,
            subtitle: `${leaveRange(row.startsOn, row.endsOn)}${row.leaveType ? ` · ${LEAVE_TYPE_LABELS[row.leaveType]}` : ''}${row.sub ? ` · ${row.sub}` : ''}`,
            meta: (
              <span className="block text-[12.5px] text-muted-foreground">
                {row.reason}
                {row.decisionNote ? ` · ${row.decisionNote}` : ''}
              </span>
            ),
            trailing: (
              <>
                <ApplicationStatusTag status={row.status} />
                {actionsFor(row)}
              </>
            ),
          })}
          emptyState={<EmptyState icon={<CalendarOff />} title={empty.title} description={empty.description} />}
          footer={<span>{visible.length} {visible.length === 1 ? noun : `${noun}s`} in view</span>}
        />
      )}
      {applyKind && <ApplyLeaveSheet kind={applyKind} open={applying} onOpenChange={setApplying} />}
      <DecideLeaveDialog target={deciding} onOpenChange={(open) => { if (!open) setDeciding(null) }} />
      <WithdrawLeaveDialog row={withdrawing} onOpenChange={(open) => { if (!open) setWithdrawing(null) }} />
    </>
  )
}

/** The leave the office recorded, for one kind of person. */
function RecordsView({ kind, tabs }: { kind: LeaveKind; tabs: ReactNode }) {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { schoolId, hasPermission } = useSchoolContext()

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

  const manageKey = KIND_KEYS[kind].manage
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
      cell: ({ row }) => (row.original.status === 'active' && allows(row.original.allowedActions, manageKey)
        ? <Button size="sm" variant="outline" onClick={() => setCancelling(row.original)}>Cancel leave</Button>
        : null),
    },
    ]
  }, [kind, manageKey])

  const setSearch = (patch: Partial<z.infer<typeof searchSchema>>) =>
    void navigate({ search: (old: z.infer<typeof searchSchema>) => ({ ...old, ...patch }), replace: true })

  return (
    <>
      <PageHeader
        crumbs={CRUMBS}
        actions={canRecord ? <Button size="sm" onClick={() => setRecording(true)}><Plus />Record leave</Button> : undefined}
      />
      {tabs}
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
                {row.status === 'active' && allows(row.allowedActions, manageKey) && (
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
