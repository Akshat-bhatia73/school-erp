import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Copy, ShieldCheck, Trash2, UserCog } from 'lucide-react'
import { toast } from 'sonner'
import type { Role } from '@erp/shared'
import { api } from '@/api/client'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { roleColor, SettingsTabs } from '@/components/settings/settings-tabs'
import { PermissionMatrix, RolesOverview } from '@/components/settings/permission-matrix'

export const Route = createFileRoute('/_app/settings/roles')({ component: Page })

function Page() {
  const qc = useQueryClient()
  const session = useSession()
  const canEdit = session.can('users_roles', 'edit')
  const canCreate = session.can('users_roles', 'create')
  const canDelete = session.can('users_roles', 'delete')

  const [selectedId, setSelectedId] = useState<string>()
  const { data: roles = [], isLoading } = useQuery({ queryKey: qk.roles, queryFn: () => api.roles.list() })
  const { data: users = [] } = useQuery({ queryKey: qk.users, queryFn: () => api.users.list() })

  useEffect(() => {
    if (!isLoading && roles.length && !roles.some((r) => r.id === selectedId)) setSelectedId(roles[0]!.id)
  }, [roles, isLoading, selectedId])

  const selected = roles.find((r) => r.id === selectedId)
  const userCount = (roleId: string) => users.filter((u) => u.roleIds.includes(roleId)).length

  const duplicate = useMutation({
    mutationFn: (r: Role) => api.roles.create({ key: 'custom', name: `${r.name} (copy)`, description: r.description, permissions: r.permissions }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: qk.roles })
      qc.invalidateQueries({ queryKey: qk.auditLogs() })
      setSelectedId(r.id)
      toast.success(`Created ${r.name}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: (id: string) => api.roles.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.roles })
      qc.invalidateQueries({ queryKey: qk.auditLogs() })
      setSelectedId(undefined)
      toast.success('Role deleted')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  return (
    <>
      <PageHeader crumbs={[{ label: 'Settings', icon: <UserCog /> }, { label: 'Roles & permissions' }]} />
      <SettingsTabs />
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col overflow-y-auto border-r">
          {isLoading
            ? <div className="space-y-2 p-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
            : roles.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={cn('w-full border-b px-3.5 py-3 text-left transition-colors hover:bg-accent/60', r.id === selectedId && 'bg-accent')}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-[13.5px] font-medium">{r.name}</span>
                    {r.isSystem && <Tag color="grey">System</Tag>}
                  </span>
                  {r.description && <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">{r.description}</span>}
                  <span className="mt-1 block text-[12px] text-muted-foreground tabular-nums">{userCount(r.id)} users</span>
                </button>
              ))}
        </aside>
        <div className="min-w-0 flex-1 overflow-y-auto bg-background p-5">
          {isLoading && <div className="space-y-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-80 w-full" /></div>}
          {!isLoading && roles.length === 0 && (
            <EmptyState icon={<ShieldCheck />} title="No roles yet" description="Roles decide what each person can see and change." />
          )}
          {selected && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border bg-card px-4 py-3.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="size-4 text-muted-foreground" />
                    <h2 className="text-[15px] font-semibold">{selected.name}</h2>
                    <Tag color={roleColor[selected.key]}>{selected.key}</Tag>
                    {selected.isSystem && <Tag color="grey">System</Tag>}
                  </div>
                  <p className="mt-1 text-[12.5px] text-muted-foreground">
                    {selected.description ?? 'No description.'} · {userCount(selected.id)} users
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {canCreate && (
                    <Button variant="outline" size="sm" disabled={duplicate.isPending} onClick={() => duplicate.mutate(selected)}>
                      <Copy className="size-4" />Duplicate as custom role
                    </Button>
                  )}
                  {canDelete && !selected.isSystem && userCount(selected.id) === 0 && (
                    <Button variant="outline" size="sm" disabled={remove.isPending} onClick={() => remove.mutate(selected.id)}>
                      <Trash2 className="size-4" />Delete
                    </Button>
                  )}
                </div>
              </div>
              <PermissionMatrix role={selected} canEdit={canEdit} />
              <RolesOverview roles={roles} selectedRoleId={selected.id} onSelectRole={setSelectedId} />
            </div>
          )}
        </div>
      </div>
    </>
  )
}
