import { Link, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { KeyRound } from 'lucide-react'
import { api } from '@/lib/api'
import type { Member } from '@/lib/api/members'
import { EmptyState, Facts, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { describeError } from '@/lib/api-errors'
import { assignableRolesFor, roleLabel } from '@/lib/permissions'
import { memberStatusColor, memberStatusLabel, roleColor } from '@/components/settings/settings-tabs'

/** The directory filters by staff id, so one row is all this needs. */
async function findByStaffId(schoolId: string, staffId: string): Promise<Member | null> {
  const result = await api.members.list(schoolId, { staffId, pageSize: 1 })
  return result.items[0] ?? null
}

export function LoginTab({ staffId, displayName }: { staffId: string; displayName: string }) {
  const { schoolId, roleKeys, hasPermission } = useSchoolContext()
  const navigate = useNavigate()

  const canRead = hasPermission('members.read')
  const { data: member, isLoading, error } = useQuery({
    queryKey: qk.members(schoolId, { staffId }),
    queryFn: () => findByStaffId(schoolId, staffId),
    enabled: canRead,
  })

  if (!canRead) return null
  if (isLoading) return <Panel><Skeleton className="h-24 w-full" /></Panel>
  if (error) return <Panel><p className="text-[13px] text-muted-foreground">{describeError(error)}</p></Panel>

  const canInvite = hasPermission('members.invite') && hasPermission('roles.assign') && assignableRolesFor(roleKeys).length > 0

  if (!member) {
    return (
      <EmptyState
        icon={<KeyRound />}
        title="No login yet"
        description={`${displayName} cannot sign in. Invite them to give them access to the app.`}
        action={canInvite
          ? <Button size="sm" onClick={() => { void navigate({ to: '/settings/users', search: { invite: staffId, name: displayName } } as never) }}>Invite</Button>
          : undefined}
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
          { label: 'Roles', value: <span className="flex flex-wrap gap-1.5">{member.roleKeys.map((role) => <Tag key={role} color={roleColor[role]}>{roleLabel(role)}</Tag>)}</span> },
          { label: 'Status', value: <Tag color={memberStatusColor[member.status]} dot>{memberStatusLabel[member.status]}</Tag> },
        ]}
      />
    </Panel>
  )
}
