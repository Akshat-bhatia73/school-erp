import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Download, History, UserCog } from 'lucide-react'
import type { ColumnDef } from '@tanstack/react-table'
import { api } from '@/lib/api'
import type { AuditEvent } from '@/lib/api/audit'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable } from '@/components/shared/data-table'
import { FilterChip, ToolbarButton } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Input } from '@/components/ui/input'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { describeError } from '@/lib/api-errors'
import { SettingsTabs } from '@/components/settings/settings-tabs'
import { actionLabel, AuditDetailSheet, formatWhen } from '@/components/settings/audit-detail-sheet'
import { AuditExportDialog } from '@/components/settings/audit-export-dialog'

export const Route = createFileRoute('/_app/settings/audit-log')({ component: Page })

const PAGE_SIZE = 50

/** A calendar date as an instant with this browser's offset, which is what the contract takes. */
function isoFrom(date: string, endOfDay: boolean): string | undefined {
  if (!date) return undefined
  const at = new Date(`${date}T${endOfDay ? '23:59:59.999' : '00:00:00'}`)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [outcome, setOutcome] = useState<'allowed' | 'denied' | undefined>()
  const [detail, setDetail] = useState<AuditEvent | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  const params = useMemo(() => ({
    page,
    pageSize: PAGE_SIZE,
    action: action.trim() || undefined,
    from: isoFrom(from, false),
    to: isoFrom(to, true),
    outcome,
  }), [page, action, from, to, outcome])

  const { data, isLoading, error } = useQuery({
    queryKey: qk.auditEvents(schoolId, params),
    queryFn: () => api.audit.list(schoolId, params),
    enabled: hasPermission('audit.read'),
  })

  const rows = data?.items ?? []

  const columns = useMemo<ColumnDef<AuditEvent, unknown>[]>(() => [
    {
      id: 'when', header: 'When', size: 170,
      cell: ({ row }) => {
        const when = formatWhen(row.original.at)
        return <span className="tabular-nums">{when.date} <span className="text-muted-foreground">{when.time}</span></span>
      },
    },
    {
      id: 'who', header: 'Who', size: 190,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <UserAvatar name={row.original.actorDisplayName} size="xs" />
          <span className="truncate">{row.original.actorDisplayName}</span>
        </span>
      ),
    },
    { id: 'action', header: 'Action', size: 180, cell: ({ row }) => <Tag color="blue">{actionLabel(row.original.action)}</Tag> },
    {
      id: 'what', header: 'What',
      cell: ({ row }) => (
        <span className="block min-w-0">
          <span className="block truncate text-muted-foreground">{row.original.summary}</span>
          {row.original.note && <span className="block truncate text-[12.5px] text-muted-foreground/80">{row.original.note}</span>}
        </span>
      ),
    },
    {
      id: 'outcome', header: 'Outcome', size: 110,
      cell: ({ row }) => <Tag color={row.original.outcome === 'allowed' ? 'green' : 'red'} dot>{row.original.outcome === 'allowed' ? 'Allowed' : 'Refused'}</Tag>,
    },
  ], [])

  const header = (
    <>
      <PageHeader crumbs={[{ label: 'Settings', icon: <UserCog /> }, { label: 'Audit log' }]} hideOnMobile />
      <SettingsTabs />
    </>
  )

  if (!hasPermission('audit.read')) {
    return (
      <>
        {header}
        <EmptyState icon={<History />} title="You cannot see the audit log" description="Ask an owner or principal if you need this." />
      </>
    )
  }

  if (error) {
    return (
      <>
        {header}
        <EmptyState icon={<History />} title="We could not show the audit log" description={describeError(error)} />
      </>
    )
  }

  return (
    <>
      {header}
      <Toolbar
        search={
          <Input
            value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1) }}
            placeholder="Exact action name, like members.suspend"
            aria-label="Filter by the exact action name"
            className="h-9 w-full md:w-64"
          />
        }
        right={hasPermission('audit.export')
          ? <ToolbarButton icon={<Download />} onClick={() => setExportOpen(true)}>Export</ToolbarButton>
          : undefined}
      >
        <FilterChip
          label="Outcome"
          value={outcome}
          options={[{ value: 'allowed', label: 'Allowed' }, { value: 'denied', label: 'Refused' }]}
          onChange={(value) => { setOutcome(value); setPage(1) }}
        />
        <div className="flex items-center gap-1.5">
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="h-9 w-[9.5rem]" aria-label="From date" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="h-9 w-[9.5rem]" aria-label="To date" />
        </div>
      </Toolbar>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        dense
        getRowId={(row) => row.id}
        onRowClick={(row) => setDetail(row)}
        mobileRow={(row) => ({
          title: actionLabel(row.action),
          subtitle: row.summary,
          meta: <span className="truncate">{row.actorDisplayName} · {formatWhen(row.at).date}</span>,
        })}
        emptyState={<EmptyState icon={<History />} title="No entries match" description="Type the exact action name, like members.suspend, or try a wider date range." />}
        footer={<span>{data?.total === 1 ? '1 entry' : `${data?.total ?? 0} entries`}</span>}
        pagination={{ page, pageSize: PAGE_SIZE, total: data?.total ?? 0, onPageChange: setPage }}
      />
      <AuditDetailSheet entry={detail} onOpenChange={(open) => { if (!open) setDetail(null) }} />
      {hasPermission('audit.export') && <AuditExportDialog open={exportOpen} onOpenChange={setExportOpen} />}
    </>
  )
}
