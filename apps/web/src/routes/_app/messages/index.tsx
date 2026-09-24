/** Messages: the inbox for everyone, and the messages the school and the caller sent. */
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { MessageAudienceKind, MessageKind, MessageStatus, MESSAGE_KINDS } from '@erp/contracts'
import { Inbox, Mail, Paperclip, Plus, Settings2, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { z } from 'zod'
import { AUDIENCE_KIND_LABEL, formatDateTime, KIND_COLOR, kindLabel, STATUS_COLOR, STATUS_LABEL } from '@/components/messages/labels'
import { DataTable } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import type { InboxRow, MessageRow } from '@/lib/api/messages'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn } from '@/lib/utils'

const searchSchema = z.object({
  tab: z.enum(['inbox', 'sent']).optional().catch(undefined),
  kind: MessageKind.optional().catch(undefined),
  status: MessageStatus.optional().catch(undefined),
  audience: MessageAudienceKind.optional().catch(undefined),
  unread: z.boolean().optional().catch(undefined),
  mine: z.boolean().optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
})

export const Route = createFileRoute('/_app/messages/')({ component: Page, validateSearch: searchSchema })

const PAGE_SIZE = 25
const KIND_OPTIONS = MESSAGE_KINDS.map((kind) => ({ value: kind, label: kindLabel(kind) }))

function Page() {
  const { hasPermission } = useSchoolContext()
  const search = Route.useSearch()
  const canSend = hasPermission('communication.send')
  const canManage = hasPermission('communication.manage')
  const showSent = canSend || canManage
  const tab = showSent && search.tab === 'sent' ? 'sent' : 'inbox'

  const actions = (
    <>
      {canManage && <Button variant="outline" size="sm" asChild><Link to="/messages/settings"><Settings2 />Automatic messages</Link></Button>}
      {canSend && <Button variant="outline" size="sm" asChild><Link to="/messages/templates">Templates</Link></Button>}
      {canSend && <Button size="sm" asChild><Link to="/messages/new"><Plus />New message</Link></Button>}
    </>
  )

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Messages', icon: <Mail /> }]}
        actions={actions}
        mobileActions={canSend ? <Button size="sm" asChild><Link to="/messages/new"><Plus />New</Link></Button> : undefined}
      />
      {showSent && (
        <div className="flex shrink-0 items-center gap-1 border-b bg-card px-3">
          {(['inbox', 'sent'] as const).map((key) => (
            <Link
              key={key}
              to="/messages"
              search={{ tab: key === 'inbox' ? undefined : key }}
              className={cn(
                'relative flex h-10 items-center px-2.5 text-[13.5px] text-muted-foreground hover:text-foreground md:h-11',
                tab === key && 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground',
              )}
            >
              {key === 'inbox' ? 'Inbox' : 'Sent'}
            </Link>
          ))}
        </div>
      )}
      {tab === 'inbox' ? <InboxView /> : <SentView />}
    </>
  )
}

function InboxView() {
  const { schoolId } = useSchoolContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/messages/' })
  const params = { kind: search.kind, show: search.unread ? ('unread' as const) : ('all' as const), page: search.page ?? 1, pageSize: PAGE_SIZE }
  const inboxQuery = useQuery({ queryKey: qk.messages.inbox(schoolId, params), queryFn: () => api.messages.inbox(schoolId, params) })
  const data = inboxQuery.data

  const columns = useMemo<ColumnDef<InboxRow>[]>(() => [
    {
      id: 'title',
      header: 'Message',
      size: 460,
      cell: ({ row }) => {
        const item = row.original
        return (
          <div className="min-w-0 py-1">
            <p className={cn('flex items-center gap-1.5 truncate', !item.readAt && 'font-semibold')}>
              {!item.readAt && <span className="size-1.5 shrink-0 rounded-full bg-foreground" aria-label="Unread" />}
              <span className="truncate">{item.title || 'Message'}</span>
              {item.attachmentCount > 0 && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has files" />}
            </p>
            <p className="truncate text-[12.5px] text-muted-foreground">{item.preview}</p>
          </div>
        )
      },
    },
    { id: 'kind', header: 'Kind', size: 130, cell: ({ row }) => <Tag color={KIND_COLOR[row.original.kind]}>{kindLabel(row.original.kind)}</Tag> },
    { id: 'from', header: 'From', size: 180, cell: ({ row }) => <span className="truncate">{row.original.sender.name}</span> },
    { id: 'pupil', header: 'About', size: 160, cell: ({ row }) => <span className="truncate text-muted-foreground">{row.original.pupil?.name ?? ''}</span> },
    { id: 'sentAt', header: 'Sent', size: 170, cell: ({ row }) => <span className="text-muted-foreground tabular-nums">{formatDateTime(row.original.sentAt)}</span> },
  ], [])

  return (
    <>
      <Toolbar>
        <FilterChip label="Kind" value={search.kind} options={KIND_OPTIONS} onChange={(kind) => void navigate({ search: (prev) => ({ ...prev, kind, page: undefined }) })} />
        <FilterChip
          label="Show"
          value={search.unread ? 'unread' : undefined}
          options={[{ value: 'unread', label: 'Unread only' }]}
          onChange={(value) => void navigate({ search: (prev) => ({ ...prev, unread: value ? true : undefined, page: undefined }) })}
        />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-hidden">
        {inboxQuery.isError ? (
          <EmptyState icon={<Inbox />} title="Messages are not available" description={describeError(inboxQuery.error)} />
        ) : (
          <DataTable
            columns={columns}
            data={data?.items ?? []}
            isLoading={inboxQuery.isLoading}
            getRowId={(row) => row.recipientId}
            rowLink={(row) => `/messages/${row.messageId}`}
            mobileRow={(row) => ({
              title: <span className={cn(!row.readAt && 'font-semibold')}>{row.title || 'Message'}</span>,
              subtitle: row.preview,
              meta: `${row.sender.name} · ${formatDateTime(row.sentAt)}`,
              trailing: <Tag color={KIND_COLOR[row.kind]}>{kindLabel(row.kind)}</Tag>,
            })}
            emptyState={<EmptyState icon={<Inbox />} title={search.unread ? 'Nothing unread' : 'No messages yet'} description="Messages from the school show up here." />}
            footer={data ? `${data.total} ${data.total === 1 ? 'message' : 'messages'}, ${data.unread} unread` : undefined}
            pagination={data && data.total > PAGE_SIZE ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: (page) => void navigate({ search: (prev) => ({ ...prev, page }) }) } : undefined}
          />
        )}
      </div>
    </>
  )
}

const STATUS_OPTIONS = MessageStatus.options.map((status) => ({ value: status, label: STATUS_LABEL[status] }))
const AUDIENCE_OPTIONS = MessageAudienceKind.options.map((kind) => ({ value: kind, label: AUDIENCE_KIND_LABEL[kind] }))

/** "Read 12 of 40 · 3 not agreed", or the time a scheduled message will go. */
function deliveryLine(row: MessageRow): string {
  const counts = row.counts
  if (!counts || row.status === 'draft' || row.status === 'scheduled') return ''
  const parts = [`Read ${counts.read} of ${counts.inApp}`, `${counts.delivered} delivered`]
  if (counts.noConsent > 0) parts.push(`${counts.noConsent} not agreed`)
  return parts.join(' · ')
}

function SentView() {
  const { schoolId } = useSchoolContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/messages/' })
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  // The title search waits for the person to stop typing.
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300)
    return () => clearTimeout(timer)
  }, [text])

  const params = {
    kind: search.kind,
    status: search.status,
    audience: search.audience,
    author: search.mine ? ('mine' as const) : ('anyone' as const),
    q: q || undefined,
    page: search.page ?? 1,
    pageSize: PAGE_SIZE,
  }
  const listQuery = useQuery({ queryKey: qk.messages.list(schoolId, params), queryFn: () => api.messages.list(schoolId, params) })
  const data = listQuery.data

  const columns = useMemo<ColumnDef<MessageRow>[]>(() => [
    {
      id: 'title',
      header: 'Title',
      size: 320,
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium">{row.original.title || 'Words removed'}</span>
          {row.original.attachmentCount > 0 && <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Has files" />}
        </span>
      ),
    },
    { id: 'kind', header: 'Kind', size: 130, cell: ({ row }) => <Tag color={KIND_COLOR[row.original.kind]}>{kindLabel(row.original.kind)}</Tag> },
    { id: 'audience', header: 'To', size: 200, cell: ({ row }) => <span className="truncate">{row.original.audience.label}</span> },
    { id: 'status', header: 'Status', size: 110, cell: ({ row }) => <Tag color={STATUS_COLOR[row.original.status]} dot>{STATUS_LABEL[row.original.status]}</Tag> },
    {
      id: 'when',
      header: 'When',
      size: 170,
      cell: ({ row }) => {
        const m = row.original
        const when = m.status === 'scheduled' ? m.sendAt : m.sentAt ?? m.createdAt
        return <span className="text-muted-foreground tabular-nums">{formatDateTime(when)}</span>
      },
    },
    { id: 'delivery', header: 'Delivery', size: 240, cell: ({ row }) => <span className="truncate text-muted-foreground">{deliveryLine(row.original)}</span> },
    { id: 'sender', header: 'Written by', size: 160, cell: ({ row }) => <span className="truncate">{row.original.sender.name}</span> },
  ], [])

  const setSearch = (patch: Partial<z.infer<typeof searchSchema>>) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch, page: undefined }) })

  return (
    <>
      <Toolbar
        search={
          <div className="relative w-full md:w-60">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search titles" aria-label="Search titles" className="h-8 pl-8" maxLength={100} />
          </div>
        }
      >
        <FilterChip label="Kind" value={search.kind} options={KIND_OPTIONS} onChange={(kind) => setSearch({ kind })} />
        <FilterChip label="Status" value={search.status} options={STATUS_OPTIONS} onChange={(status) => setSearch({ status })} />
        <FilterChip label="To" value={search.audience} options={AUDIENCE_OPTIONS} onChange={(audience) => setSearch({ audience })} />
        <FilterChip
          label="Written by"
          value={search.mine ? 'mine' : undefined}
          allLabel="Anyone"
          options={[{ value: 'mine', label: 'Written by me' }]}
          onChange={(value) => setSearch({ mine: value ? true : undefined })}
        />
      </Toolbar>
      <div className="min-h-0 flex-1 overflow-hidden">
        {listQuery.isError ? (
          <EmptyState icon={<Mail />} title="Messages are not available" description={describeError(listQuery.error)} />
        ) : (
          <DataTable
            columns={columns}
            data={data?.items ?? []}
            isLoading={listQuery.isLoading}
            getRowId={(row) => row.id}
            rowLink={(row) => (row.status === 'draft' ? `/messages/${row.id}/edit` : `/messages/${row.id}`)}
            mobileRow={(row) => ({
              title: row.title || 'Words removed',
              subtitle: row.audience.label,
              meta: formatDateTime(row.status === 'scheduled' ? row.sendAt : row.sentAt ?? row.createdAt),
              trailing: <Tag color={STATUS_COLOR[row.status]} dot>{STATUS_LABEL[row.status]}</Tag>,
            })}
            emptyState={<EmptyState icon={<Mail />} title="No messages here" description="Messages you write, and the ones the school sends by itself, show up here." />}
            footer={data ? `${data.total} ${data.total === 1 ? 'message' : 'messages'} in view` : undefined}
            pagination={data && data.total > PAGE_SIZE ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: (page) => void navigate({ search: (prev) => ({ ...prev, page }) }) } : undefined}
          />
        )}
      </div>
    </>
  )
}
