import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Info, MoreHorizontal, Plus, Search, UserCog, Users } from 'lucide-react'
import { toast } from 'sonner'
import type { ColumnDef, RowSelectionState } from '@tanstack/react-table'
import { UserStatus } from '@erp/shared'
import { api, type UserRow } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { humanize, timeAgo } from '@/lib/utils'
import { roleColor, SettingsTabs, userStatusColor } from '@/components/settings/settings-tabs'
import { EditRolesSheet, InviteUserSheet } from '@/components/settings/user-sheets'

export const Route = createFileRoute('/_app/settings/users')({ component: Page })

function Page() {
  const qc = useQueryClient()
  const session = useSession()
  const canEdit = session.can('users_roles', 'edit')
  const canCreate = session.can('users_roles', 'create')

  const [search, setSearch] = useState('')
  const [roleId, setRoleId] = useState<string>()
  const [status, setStatus] = useState<UserStatus>()
  const [invite, setInvite] = useState(false)
  const [editing, setEditing] = useState<UserRow | null>(null)
  const [selection, setSelection] = useState<RowSelectionState>({})

  const { data: users = [], isLoading } = useQuery({ queryKey: qk.users, queryFn: () => api.users.list() })
  const { data: roles = [] } = useQuery({ queryKey: qk.roles, queryFn: () => api.roles.list() })

  const setStatusMut = useMutation({
    mutationFn: ({ id, next }: { id: string; next: UserStatus }) => api.users.update(id, { status: next }),
    onSuccess: (u) => {
      qc.invalidateQueries({ queryKey: qk.users })
      qc.invalidateQueries({ queryKey: qk.auditLogs() })
      toast.success(u.status === 'disabled' ? `Disabled ${u.name}` : `Enabled ${u.name}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return users.filter((u) => {
      if (roleId && !u.roleIds.includes(roleId)) return false
      if (status && u.status !== status) return false
      if (q && !(u.name.toLowerCase().includes(q) || u.phone.includes(q) || (u.email ?? '').toLowerCase().includes(q))) return false
      return true
    })
  }, [users, search, roleId, status])

  const hasFilters = !!(search.trim() || roleId || status)
  const activeCount = rows.filter((u) => u.status === 'active').length
  const selectedCount = Object.values(selection).filter(Boolean).length

  const columns = useMemo<ColumnDef<UserRow, any>[]>(() => [
    {
      id: 'user', header: 'User', size: 260,
      cell: ({ row }) => (
        <EntityCell
          avatar={<UserAvatar name={row.original.name} src={row.original.avatarUrl} size="sm" />}
          name={row.original.name}
          sub={<span className="font-mono">{row.original.phone}</span>}
        />
      ),
    },
    {
      id: 'roles', header: 'Roles', size: 240,
      cell: ({ row }) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {row.original.roles.map((r) => <Tag key={r.id} color={roleColor[r.key]}>{r.name}</Tag>)}
        </div>
      ),
    },
    {
      id: 'linked', header: 'Linked to', size: 180,
      cell: ({ row }) => {
        const u = row.original
        if (u.staff) return <span>{u.staff.designation}</span>
        if (u.guardianId) return <span>Parent</span>
        return <span className="text-muted-foreground/60">—</span>
      },
    },
    {
      id: 'status', header: 'Status', size: 120,
      cell: ({ row }) => <Tag color={userStatusColor[row.original.status]} dot>{humanize(row.original.status)}</Tag>,
    },
    {
      id: 'lastActive', header: 'Last active', size: 130,
      cell: ({ row }) => row.original.lastActiveAt
        ? <span className="text-muted-foreground">{timeAgo(row.original.lastActiveAt)}</span>
        : <span className="text-muted-foreground/60">Never</span>,
    },
    {
      id: 'actions', header: '', size: 56,
      cell: ({ row }) => {
        const u = row.original
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" onClick={(e) => e.stopPropagation()} className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              {canEdit && <DropdownMenuItem onClick={() => setEditing(u)}>Edit roles</DropdownMenuItem>}
              {canEdit && (
                <DropdownMenuItem onClick={() => setStatusMut.mutate({ id: u.id, next: u.status === 'disabled' ? 'active' : 'disabled' })}>
                  {u.status === 'disabled' ? 'Enable' : 'Disable'}
                </DropdownMenuItem>
              )}
              {canEdit && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onClick={() => { session.setUserId(u.id); toast.success(`Now viewing as ${u.name}`) }}
              >
                Switch to this user
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      },
    },
  ], [canEdit, session, setStatusMut])

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Settings', icon: <UserCog /> }, { label: 'Users & logins' }]}
        actions={canCreate ? <Button onClick={() => setInvite(true)}><Plus className="size-4" />Invite user</Button> : undefined}
        hideOnMobile
      />
      <SettingsTabs actions={canCreate ? <Button size="sm" onClick={() => setInvite(true)}><Plus />Invite</Button> : undefined} />
      <div className="shrink-0 border-b bg-card px-3 py-2 md:px-4 md:py-3">
        <Alert>
          <Info className="size-4" />
          <AlertDescription>
            Logins are by phone number and OTP. Auth is turned off in this preview; use "Switch to this user" to test what each role sees.
          </AlertDescription>
        </Alert>
      </div>
      <Toolbar>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search users" className="h-9 w-64 pl-8" />
        </div>
        <FilterChip
          label="Role" value={roleId} onChange={setRoleId} allLabel="Any"
          options={roles.map((r) => ({ value: r.id, label: r.name, count: users.filter((u) => u.roleIds.includes(r.id)).length }))}
        />
        <FilterChip
          label="Status" value={status} onChange={setStatus} allLabel="Any"
          options={UserStatus.options.map((s) => ({ value: s, label: humanize(s), count: users.filter((u) => u.status === s).length }))}
        />
      </Toolbar>
      <DataTable
        columns={columns}
        data={rows}
        isLoading={isLoading}
        selectable
        getRowId={(u) => u.id}
        rowSelection={selection}
        onRowSelectionChange={setSelection}
        dense
        emptyState={
          <EmptyState
            icon={<Users />}
            title="No users match"
            description="Try clearing the filters or searching for a different name."
            action={hasFilters ? <Button variant="outline" size="sm" onClick={() => { setSearch(''); setRoleId(undefined); setStatus(undefined) }}>Clear filters</Button> : undefined}
          />
        }
        footer={
          <>
            <span>{rows.length} users</span>
            <span>{activeCount} active</span>
            {selectedCount > 0 && <span className="text-foreground">{selectedCount} selected</span>}
          </>
        }
      />
      <InviteUserSheet open={invite} onOpenChange={setInvite} roles={roles} />
      <EditRolesSheet user={editing} onOpenChange={(v) => { if (!v) setEditing(null) }} roles={roles} />
    </>
  )
}
