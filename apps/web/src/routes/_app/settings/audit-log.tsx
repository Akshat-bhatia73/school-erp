import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Download, History, Info, Search, UserCog } from 'lucide-react'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { AuditAction, AuditEntity, type AuditLog } from '@erp/shared'
import { api } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable } from '@/components/shared/data-table'
import { FilterChip, ToolbarButton } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { qk } from '@/lib/query'
import { humanize } from '@/lib/utils'
import { auditActionColor, entityLabels, SettingsTabs } from '@/components/settings/settings-tabs'
import { AuditDetailSheet, formatWhen, ViaIcon } from '@/components/settings/audit-detail-sheet'

export const Route = createFileRoute('/_app/settings/audit-log')({ component: Page })

const PAGE_SIZE = 50

function Page() {
  const [search, setSearch] = useState('')
  const [entity, setEntity] = useState<AuditEntity>()
  const [action, setAction] = useState<AuditAction>()
  const [actorUserId, setActorUserId] = useState<string>()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [detail, setDetail] = useState<AuditLog | null>(null)
  const [selection, setSelection] = useState<RowSelectionState>({})

  const params = useMemo(
    () => ({ search: search.trim() || undefined, entity, action, actorUserId, from: from || undefined, to: to || undefined, page, pageSize: PAGE_SIZE }),
    [search, entity, action, actorUserId, from, to, page],
  )
  const { data, isLoading } = useQuery({ queryKey: qk.auditLogs(params), queryFn: () => api.auditLogs.list(params) })
  const { data: users = [] } = useQuery({ queryKey: qk.users, queryFn: () => api.users.list() })

  const columns = useMemo<ColumnDef<AuditLog, any>[]>(() => [
    {
      id: 'when', header: 'When', size: 170,
      cell: ({ row }) => {
        const w = formatWhen(row.original.createdAt)
        return <span className="tabular-nums">{w.date} <span className="text-muted-foreground">{w.time}</span></span>
      },
    },
    {
      id: 'who', header: 'Who', size: 190,
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <UserAvatar name={row.original.actorName} size="xs" />
          <span className="truncate">{row.original.actorName}</span>
        </span>
      ),
    },
    {
      id: 'action', header: 'Action', size: 110,
      cell: ({ row }) => <Tag color={auditActionColor[row.original.action]}>{humanize(row.original.action)}</Tag>,
    },
    {
      id: 'what', header: 'What',
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-2">
          <Tag color="grey">{entityLabels[row.original.entity]}</Tag>
          <span className="truncate text-muted-foreground">{row.original.summary}</span>
        </span>
      ),
    },
    { id: 'via', header: 'Via', size: 64, cell: ({ row }) => <ViaIcon via={row.original.via} /> },
  ], [])

  const total = data?.total ?? 0
  const selectedCount = Object.values(selection).filter(Boolean).length

  return (
    <>
      <PageHeader crumbs={[{ label: 'Settings', icon: <UserCog /> }, { label: 'Audit log' }]} hideOnMobile />
      <SettingsTabs />
      <div className="shrink-0 border-b bg-card px-4 py-3">
        <Alert>
          <Info className="size-4" />
          <AlertDescription>Every change is recorded with who did it and when. Entries cannot be edited or deleted.</AlertDescription>
        </Alert>
      </div>
      <Toolbar
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} placeholder="Search entries" aria-label="Search audit entries" className="h-9 w-full pl-8 md:w-64" />
          </div>
        }
        right={
          <Tooltip>
            <TooltipTrigger asChild>
              <span><ToolbarButton icon={<Download />} className="pointer-events-none opacity-50">Export</ToolbarButton></span>
            </TooltipTrigger>
            <TooltipContent>Phase 2</TooltipContent>
          </Tooltip>
        }
      >
        <FilterChip
          label="Entity" value={entity} onChange={(v) => { setEntity(v); setPage(1) }} allLabel="Any"
          options={AuditEntity.options.map((e) => ({ value: e, label: entityLabels[e] }))}
        />
        <FilterChip
          label="Action" value={action} onChange={(v) => { setAction(v); setPage(1) }} allLabel="Any"
          options={AuditAction.options.map((a) => ({ value: a, label: humanize(a) }))}
        />
        <FilterChip
          label="Who" value={actorUserId} onChange={(v) => { setActorUserId(v); setPage(1) }} allLabel="Anyone"
          options={users.map((u) => ({ value: u.id, label: u.name }))}
        />
        <div className="flex items-center gap-1.5">
          <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="h-9 w-[9.5rem]" aria-label="From date" />
          <span className="text-muted-foreground">to</span>
          <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="h-9 w-[9.5rem]" aria-label="To date" />
        </div>
      </Toolbar>
      <DataTable
        columns={columns}
        data={data?.items ?? []}
        isLoading={isLoading}
        selectable
        dense
        getRowId={(r) => r.id}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        onRowClick={(r) => setDetail(r)}
        mobileRow={(r) => ({
          title: `${humanize(r.action)} · ${entityLabels[r.entity]}`,
          subtitle: r.summary,
          meta: <span className="truncate">{r.actorName} · {formatWhen(r.createdAt).date}</span>,
        })}
        emptyState={<EmptyState icon={<History />} title="No entries match" description="Try a wider date range or clear the filters." />}
        footer={
          <>
            <span>{total} entries</span>
            {selectedCount > 0 && <span className="text-foreground">{selectedCount} selected</span>}
          </>
        }
        pagination={{ page, pageSize: PAGE_SIZE, total, onPageChange: setPage }}
      />
      <AuditDetailSheet entry={detail} onOpenChange={(v) => { if (!v) setDetail(null) }} />
    </>
  )
}
