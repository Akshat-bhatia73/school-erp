import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { Plus, Search, Users } from 'lucide-react'
import type { EmploymentType, StaffStatus, StaffType } from '@erp/shared'
import { api, type StaffRow } from '@/api/client'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { StatusDot, Tag, colorFor } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { formatDate, formatINR, fullName } from '@/lib/utils'
import { canSeePay, employmentOptions, sectionLabel, staffTypeColor, staffTypeLabel, staffTypeOptions, statusLabel, statusOptions, statusState } from '@/components/staff/shared'

export const Route = createFileRoute('/_app/staff/')({ component: Page })

function Page() {
  const navigate = useNavigate()
  const { can, roles } = useSession()
  const showPay = canSeePay(roles)

  const [search, setSearch] = useState('')
  const [staffType, setStaffType] = useState<StaffType | undefined>()
  const [department, setDepartment] = useState<string | undefined>()
  const [status, setStatus] = useState<StaffStatus | undefined>()
  const [employmentType, setEmploymentType] = useState<EmploymentType | undefined>()
  const [selection, setSelection] = useState<RowSelectionState>({})

  const params = { staffType, status, department, search: search || undefined, pageSize: 200 }
  const { data, isLoading } = useQuery({ queryKey: qk.staff(params), queryFn: () => api.staff.list(params) })
  const { data: departments = [] } = useQuery({ queryKey: qk.departments, queryFn: () => api.staff.departments() })

  const rows = useMemo(
    () => (data?.items ?? []).filter((r) => !employmentType || r.employmentType === employmentType),
    [data, employmentType],
  )

  const columns = useMemo<ColumnDef<StaffRow, any>[]>(() => {
    const cols: ColumnDef<StaffRow, any>[] = [
      {
        id: 'name',
        header: 'Staff',
        size: 240,
        cell: ({ row }) => (
          <EntityCell avatar={<UserAvatar name={fullName(row.original)} src={row.original.photoUrl} size="sm" />} name={fullName(row.original)} sub={row.original.employeeCode} />
        ),
      },
      { id: 'designation', header: 'Designation', cell: ({ row }) => row.original.designation },
      {
        id: 'department',
        header: 'Department',
        cell: ({ row }) => (row.original.department ? <Tag color={colorFor(row.original.department)}>{row.original.department}</Tag> : <span className="text-muted-foreground/60">—</span>),
      },
      { id: 'type', header: 'Type', cell: ({ row }) => <Tag color={staffTypeColor[row.original.staffType]}>{staffTypeLabel[row.original.staffType]}</Tag> },
      {
        id: 'classTeacher',
        header: 'Class teacher of',
        cell: ({ row }) => {
          const list = row.original.classTeacherOf ?? []
          if (!list.length) return <span className="text-muted-foreground/60">—</span>
          return (
            <div className="flex flex-wrap items-center gap-1">
              {list.map((c) => <Tag key={c.section.id} color={colorFor(c.grade?.name ?? c.section.name)}>{sectionLabel(c.grade?.name, c.section.name)}</Tag>)}
            </div>
          )
        },
      },
      { id: 'subjects', header: 'Subjects', size: 90, cell: ({ row }) => <span className="tabular-nums">{row.original.subjectCount || <span className="text-muted-foreground/60">—</span>}</span> },
      { id: 'phone', header: 'Phone', size: 130, cell: ({ row }) => <span className="font-mono text-[12.5px]">{row.original.phone}</span> },
      { id: 'joined', header: 'Joined', size: 120, cell: ({ row }) => formatDate(row.original.joiningDate) },
    ]
    if (showPay) {
      cols.push({
        id: 'salary',
        header: 'Salary',
        size: 110,
        cell: ({ row }) => (row.original.monthlySalary !== undefined ? <span className="tabular-nums">{formatINR(row.original.monthlySalary)}</span> : <span className="text-muted-foreground/60">—</span>),
      })
    }
    cols.push({
      id: 'status',
      header: 'Status',
      size: 80,
      cell: ({ row }) => <StatusDot state={statusState(row.original.status)} title={statusLabel[row.original.status]} />,
    })
    return cols
  }, [showPay])

  const teaching = rows.filter((r) => r.staffType === 'teaching').length

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Staff', icon: <Users /> }]}
        badge={<Tag className="ml-2">{data?.total ?? 0}</Tag>}
        actions={can('staff', 'create') ? (
          <Button size="sm" onClick={() => navigate({ to: '/staff/new' })}><Plus />Add staff</Button>
        ) : undefined}
      />
      <Toolbar
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, code, phone" aria-label="Search staff" className="h-9 w-full pl-8 md:w-64" />
          </div>
        }
      >
        <FilterChip label="Type" value={staffType} options={staffTypeOptions} onChange={setStaffType} allLabel="All types" />
        <FilterChip label="Department" value={department} options={departments.map((d) => ({ value: d, label: d }))} onChange={setDepartment} allLabel="All departments" />
        <FilterChip label="Status" value={status} options={statusOptions} onChange={setStatus} allLabel="Active + on leave" />
        <FilterChip label="Employment" value={employmentType} options={employmentOptions} onChange={setEmploymentType} allLabel="Any" />
      </Toolbar>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        selectable
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        getRowId={(r: StaffRow) => r.id}
        rowLink={(r: StaffRow) => `/staff/${r.id}`}
        mobileRow={(r: StaffRow) => ({
          title: fullName(r),
          subtitle: `${r.designation} · ${r.employeeCode}`,
          meta: <span className="truncate font-mono">{r.phone}</span>,
          trailing: <Tag color={staffTypeColor[r.staffType]}>{staffTypeLabel[r.staffType]}</Tag>,
        })}
        emptyState={<EmptyState icon={<Users />} title="No staff match these filters" description="Try clearing a filter or searching for another name." />}
        footer={
          <>
            <span>{rows.length} staff in view</span>
            <span>{teaching} teaching</span>
            <span>{rows.length - teaching} non-teaching</span>
          </>
        }
      />
    </>
  )
}
