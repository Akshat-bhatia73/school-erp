import { Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { KeyRound } from 'lucide-react'
import type { Staff } from '@erp/shared'
import { api } from '@/api/client'
import { EmptyState, Facts, Panel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { qk, queryClient } from '@/lib/query'
import { humanize, timeAgo } from '@/lib/utils'
import { createStaffLogin } from './create-login'

export function LoginTab({ staff, canCreate }: { staff: Staff; canCreate: boolean }) {
  const { data: user, isLoading } = useQuery({
    queryKey: qk.user(staff.userId ?? 'none'),
    queryFn: () => api.users.get(staff.userId!),
    enabled: !!staff.userId,
  })

  const create = useMutation({
    mutationFn: () => createStaffLogin(staff),
    onSuccess: (u) => {
      queryClient.invalidateQueries({ queryKey: qk.staffMember(staff.id) })
      queryClient.invalidateQueries({ queryKey: qk.users })
      toast.success(`Login created for ${u.name}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  if (staff.userId && isLoading) return <Panel><Skeleton className="h-24 w-full" /></Panel>

  if (!user) {
    return (
      <EmptyState
        icon={<KeyRound />}
        title="No login yet"
        description={`${staff.firstName} cannot sign in. Create a login to give them access to the app.`}
        action={canCreate ? <Button size="sm" onClick={() => create.mutate()} disabled={create.isPending}>Create login</Button> : undefined}
      />
    )
  }

  return (
    <Panel
      title="Login"
      actions={<Link to="/settings/users" className="text-[12.5px] link-dotted text-muted-foreground hover:text-foreground">Manage in Users &amp; logins</Link>}
    >
      <Facts
        items={[
          { label: 'Phone', value: <span className="font-mono">{user.phone}</span> },
          { label: 'Roles', value: <span className="flex flex-wrap gap-1.5">{user.roles.map((r) => <Tag key={r.id} color={colorFor(r.key)}>{r.name}</Tag>)}</span> },
          { label: 'Status', value: <Tag color={user.status === 'active' ? 'green' : user.status === 'invited' ? 'orange' : 'grey'} dot>{humanize(user.status)}</Tag> },
          { label: 'Last active', value: user.lastActiveAt ? timeAgo(user.lastActiveAt) : 'Never signed in' },
        ]}
      />
    </Panel>
  )
}
