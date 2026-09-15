import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { MoreHorizontal, Plus, Search, UserCog, Users } from 'lucide-react'
import { z } from 'zod'
import type { ColumnDef } from '@tanstack/react-table'
import { MembershipStatus, RoleKey } from '@erp/contracts'
import { api } from '@/lib/api'
import type { Invitation, Member } from '@/lib/api/members'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, SectionLabel, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { describeError } from '@/lib/api-errors'
import { assignableRolesFor, roleLabel } from '@/lib/permissions'
import { memberStatusColor, memberStatusLabel, roleColor, SettingsTabs } from '@/components/settings/settings-tabs'
import { InvitationPanel, InviteSheet } from '@/components/settings/invite-sheet'
import { MemberSheet } from '@/components/settings/member-sheet'

const searchSchema = z.object({
  /** The staff record the invitation should be linked to, from the staff login tab. */
  invite: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
})

export const Route = createFileRoute('/_app/settings/users')({
  component: Page,
  validateSearch: searchSchema,
})

const PAGE_SIZE = 25

function Page() {
  const { schoolId, roleKeys, hasPermission } = useSchoolContext()
  const searchParams = Route.useSearch()

  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [role, setRole] = useState<string>()
  const [status, setStatus] = useState<string>()
  const [inviteOpen, setInviteOpen] = useState(!!searchParams.invite)
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [selected, setSelected] = useState<Member | null>(null)

  const params = useMemo(() => ({ page, pageSize: PAGE_SIZE }), [page])
  const { data, isLoading, error } = useQuery({
    queryKey: qk.members(schoolId, params),
    queryFn: () => api.members.list(schoolId, params),
    enabled: hasPermission('members.read'),
  })

  const canInvite = hasPermission('members.invite') && hasPermission('roles.assign') && assignableRolesFor(roleKeys).length > 0

  const items = useMemo(() => data?.items ?? [], [data])
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((member) => {
      if (role && !member.roleKeys.includes(role as never)) return false
      if (status && member.status !== status) return false
      if (q && !member.displayName.toLowerCase().includes(q)) return false
      return true
    })
  }, [items, search, role, status])

  const columns = useMemo<ColumnDef<Member, unknown>[]>(() => [
    {
      id: 'person', header: 'Person', size: 240,
      cell: ({ row }) => (
        <EntityCell avatar={<UserAvatar name={row.original.displayName} size="sm" />} name={row.original.displayName} />
      ),
    },
    {
      id: 'roles', header: 'Roles', size: 240,
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {row.original.roleKeys.map((key) => <Tag key={key} color={roleColor[key]}>{roleLabel(key)}</Tag>)}
        </div>
      ),
    },
    {
      id: 'status', header: 'Status', size: 120,
      cell: ({ row }) => <Tag color={memberStatusColor[row.original.status]} dot>{memberStatusLabel[row.original.status]}</Tag>,
    },
    {
      id: 'staff', header: 'Linked staff', size: 150,
      cell: ({ row }) => row.original.staffId
        ? (
          <Link
            to="/staff/$staffId"
            params={{ staffId: row.original.staffId }}
            onClick={(e) => e.stopPropagation()}
            className="link-dotted text-muted-foreground hover:text-foreground"
          >
            Staff record
          </Link>
        )
        : <span className="text-muted-foreground/60">—</span>,
    },
    {
      id: 'actions', header: '', size: 56,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" aria-label={`Actions for ${row.original.displayName}`} onClick={(e) => e.stopPropagation()} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
            <DropdownMenuItem onClick={() => setSelected(row.original)}>Manage access</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ], [])

  const header = (
    <>
      <PageHeader
        crumbs={[{ label: 'Settings', icon: <UserCog /> }, { label: 'Users & logins' }]}
        actions={canInvite ? <Button onClick={() => setInviteOpen(true)}><Plus className="size-4" />Invite</Button> : undefined}
        hideOnMobile
      />
      <SettingsTabs actions={canInvite ? <Button size="sm" onClick={() => setInviteOpen(true)}><Plus />Invite</Button> : undefined} />
    </>
  )

  if (!hasPermission('members.read')) {
    return (
      <>
        {header}
        <EmptyState icon={<Users />} title="You cannot see the people in this school" description="Ask an owner or principal if you need this." />
      </>
    )
  }

  if (error) {
    return (
      <>
        {header}
        <EmptyState icon={<Users />} title="We could not show this list" description={describeError(error)} />
      </>
    )
  }

  const hasFilters = !!(search.trim() || role || status)

  return (
    <>
      {header}
      <Toolbar
        search={
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this page" aria-label="Search members on this page" className="h-9 w-full pl-8 md:w-64" />
          </div>
        }
      >
        <FilterChip
          label="Role" value={role} onChange={setRole} allLabel="Any"
          options={RoleKey.options.map((key) => ({ value: key, label: roleLabel(key) }))}
        />
        <FilterChip
          label="Status" value={status} onChange={setStatus} allLabel="Any"
          options={MembershipStatus.options.map((key) => ({ value: key, label: memberStatusLabel[key] }))}
        />
      </Toolbar>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        dense
        getRowId={(member) => member.id}
        onRowClick={(member) => setSelected(member)}
        mobileRow={(member) => ({
          title: member.displayName,
          subtitle: member.roleKeys.map((key) => roleLabel(key)).join(', '),
          meta: <span>{memberStatusLabel[member.status]}</span>,
        })}
        emptyState={
          <EmptyState
            icon={<Users />}
            title="No one matches"
            description="Try clearing the filters or looking on another page."
            action={hasFilters ? <Button variant="outline" size="sm" onClick={() => { setSearch(''); setRole(undefined); setStatus(undefined) }}>Clear filters</Button> : undefined}
          />
        }
        footer={<span>{rows.length} members on this page</span>}
        pagination={{ page, pageSize: PAGE_SIZE, total: data?.total ?? 0, onPageChange: setPage }}
      />
      {invitations.length > 0 && (
        <div className="shrink-0 border-t bg-background px-3 pb-4 md:px-5">
          <SectionLabel>Sent this session</SectionLabel>
          <div className="grid gap-3">
            {invitations.map((invitation) => (
              <InvitationPanel
                key={invitation.id}
                invitation={invitation}
                onChanged={(next) => setInvitations((current) => current.map((item) => item.id === next.id ? next : item))}
              />
            ))}
          </div>
        </div>
      )}
      {canInvite && (
        <InviteSheet
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          prefill={{ staffId: searchParams.invite, displayName: searchParams.name }}
          onInvited={(invitation) => setInvitations((current) => [invitation, ...current])}
        />
      )}
      <MemberSheet member={selected} onOpenChange={(open) => { if (!open) setSelected(null) }} onUpdated={setSelected} />
    </>
  )
}
