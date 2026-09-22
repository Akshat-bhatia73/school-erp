/**
 * The day's registers: which classes are marked and which are not.
 *
 * Everything on this screen comes from one read, which already carries only the sections this
 * person may mark or read. A parent has no register to open, so they get their children; an
 * accountant holds nothing but the staff register, so they get the way into it.
 */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { ClipboardCheck } from 'lucide-react'
import { useMemo } from 'react'
import { z } from 'zod'
import { DateChip, todayIso } from '@/components/attendance/month-chip'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import type { AttendanceSectionDayRow } from '@/lib/api/attendance'
import { describeError } from '@/lib/api-errors'
import { audienceFor } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate, fullName } from '@/lib/utils'

const searchSchema = z.object({ date: z.string().optional().catch(undefined) })

export const Route = createFileRoute('/_app/attendance/')({ component: Page, validateSearch: searchSchema })

/** The staff register on its own, for somebody who reads nothing else here. */
function StaffOnly() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Attendance', icon: <ClipboardCheck /> }]} />
      <div className="p-3 md:p-4">
        <Panel title="Staff register" description="Who was in today, and the month so far.">
          <Button asChild size="sm"><Link to="/attendance/staff">Open the staff register</Link></Button>
        </Panel>
      </div>
    </>
  )
}

/** A parent has no register to mark: they get a card per child. */
function ParentChildren() {
  const { schoolId } = useSchoolContext()
  const params = { status: 'active' as const, pageSize: 50 }
  const childrenQuery = useQuery({
    queryKey: qk.students(schoolId, params),
    queryFn: () => api.students.list(schoolId, params),
  })
  const children = childrenQuery.data?.items ?? []
  return (
    <>
      <PageHeader crumbs={[{ label: 'Attendance', icon: <ClipboardCheck /> }]} />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
        {childrenQuery.isError ? (
          <EmptyState icon={<ClipboardCheck />} title="Attendance is not available" description={describeError(childrenQuery.error)} />
        ) : children.length === 0 ? (
          <EmptyState icon={<ClipboardCheck />} title="Nothing to show yet" description="No child of yours is enrolled right now." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {children.map((child) => (
              <Link
                key={child.id}
                to="/attendance/students/$studentId"
                params={{ studentId: child.id }}
                className="flex items-center gap-3 rounded-xl border bg-card p-3 hover:bg-accent"
              >
                <UserAvatar name={fullName(child)} size="lg" />
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium">{fullName(child)}</span>
                  <span className="block truncate text-[12.5px] text-muted-foreground">{child.admissionNumber}</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function Page() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const { schoolId, roleKeys, hasPermission } = useSchoolContext()
  const canReadAttendance = hasPermission('attendance.read')
  const canReadStaff = hasPermission('staff_attendance.read')

  const params = { date: search.date }
  const sectionsQuery = useQuery({
    queryKey: qk.attendanceSections(schoolId, params),
    queryFn: () => api.attendance.sections(schoolId, params),
    enabled: canReadAttendance && audienceFor(roleKeys) !== 'parent',
  })

  const columns = useMemo<ColumnDef<AttendanceSectionDayRow, unknown>[]>(() => [
    {
      id: 'section',
      header: 'Class',
      size: 220,
      cell: ({ row }) => <EntityCell name={`${row.original.grade.name} - ${row.original.section.name}`} sub={`${row.original.strength} on the roster`} />,
    },
    {
      id: 'marked',
      header: 'Register',
      size: 130,
      cell: ({ row }) => (row.original.marked ? <Tag color="green">Marked</Tag> : <Tag color="grey">Not marked</Tag>),
    },
    { id: 'present', header: 'Present', size: 100, cell: ({ row }) => <span className="tabular-nums">{row.original.counts ? row.original.counts.present + row.original.counts.late : '—'}</span> },
    { id: 'absent', header: 'Absent', size: 100, cell: ({ row }) => <span className="tabular-nums">{row.original.counts?.absent ?? '—'}</span> },
    { id: 'saved', header: 'Last saved', size: 150, cell: ({ row }) => <span className="text-muted-foreground">{row.original.lastRecordedAt ? formatDate(row.original.lastRecordedAt) : '—'}</span> },
  ], [])

  if (!canReadAttendance) return canReadStaff ? <StaffOnly /> : <EmptyState icon={<ClipboardCheck />} title="Attendance is not available" description="You do not have access to the registers." />
  if (audienceFor(roleKeys) === 'parent') return <ParentChildren />

  const data = sectionsQuery.data
  const rows = data?.items ?? []
  const date = data?.date ?? search.date ?? todayIso()
  const marked = rows.filter((row) => row.marked).length

  const header = (
    <PageHeader
      crumbs={[{ label: 'Attendance', icon: <ClipboardCheck /> }]}
      actions={canReadStaff ? <Button asChild size="sm" variant="outline"><Link to="/attendance/staff">Staff register</Link></Button> : undefined}
    />
  )

  if (sectionsQuery.isError) {
    return (
      <>
        {header}
        <EmptyState icon={<ClipboardCheck />} title="Attendance is not available" description={describeError(sectionsQuery.error)} />
      </>
    )
  }

  return (
    <>
      {header}
      <Toolbar>
        <DateChip date={date} max={todayIso()} onChange={(value) => void navigate({ search: { date: value }, replace: true })} />
        {data && data.day.kind !== 'school_day' && (
          <p className="text-[12.5px] text-muted-foreground">
            {data.day.kind === 'sunday' ? 'No school on a Sunday, so there is nothing to mark.' : `No school today. ${data.day.holidayName ?? 'Holiday'}.`}
          </p>
        )}
      </Toolbar>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={sectionsQuery.isLoading}
        getRowId={(row) => row.section.id}
        rowLink={(row) => `/attendance/sections/${row.section.id}?date=${date}`}
        mobileRow={(row) => ({
          title: `${row.grade.name} - ${row.section.name}`,
          subtitle: `${row.strength} on the roster`,
          trailing: row.marked ? <Tag color="green">Marked</Tag> : <Tag color="grey">Not marked</Tag>,
        })}
        emptyState={<EmptyState icon={<ClipboardCheck />} title="No classes to show" description="You have no class to mark on this day." />}
        footer={<><span>{rows.length} {rows.length === 1 ? 'section' : 'sections'} in view</span><span>{marked} marked</span></>}
      />
    </>
  )
}
