import { createFileRoute } from '@tanstack/react-router'
import { ShieldCheck, UserCog } from 'lucide-react'
import { ROLE_TEMPLATES, RoleKey } from '@erp/contracts'
import { EmptyState, Facts, PageHeader, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { useSchoolContext } from '@/lib/session'
import { assignableRolesFor, roleLabel } from '@/lib/permissions'
import { roleColor, SettingsTabs } from '@/components/settings/settings-tabs'
import { PermissionMatrix } from '@/components/settings/permission-matrix'

export const Route = createFileRoute('/_app/settings/roles')({ component: Page })

const ROLES = RoleKey.options.filter((key) => ROLE_TEMPLATES[key].enabled)

function Page() {
  const { roleKeys, hasPermission } = useSchoolContext()
  const assignable = assignableRolesFor(roleKeys)

  const header = (
    <>
      <PageHeader crumbs={[{ label: 'Settings', icon: <UserCog /> }, { label: 'Roles & permissions' }]} hideOnMobile />
      <SettingsTabs />
    </>
  )

  if (!hasPermission('roles.read')) {
    return (
      <>
        {header}
        <EmptyState icon={<ShieldCheck />} title="You cannot see what each role can do" description="Ask an owner or principal if you need this." />
      </>
    )
  }

  return (
    <>
      {header}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-background p-3 md:p-5">
        <Panel title="Roles in this build" description="These roles are fixed. New roles come in a later build.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {ROLES.map((role) => (
              <div key={role} className="rounded-xl border px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <Tag color={roleColor[role]}>{roleLabel(role)}</Tag>
                  {ROLE_TEMPLATES[role].requiredMfa && <Tag color="orange">Needs a second step</Tag>}
                </div>
                <p className="mt-1.5 text-[12.5px] text-muted-foreground tabular-nums">{ROLE_TEMPLATES[role].grants.length} things this role can do</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Roles you can assign" description="What you may hand out when you invite someone or change their roles.">
          {assignable.length === 0
            ? <p className="text-[13px] text-muted-foreground">You cannot give anyone a role.</p>
            : (
              <Facts
                columns={1}
                items={[{ label: 'You can assign', value: <span className="flex flex-wrap gap-1.5">{assignable.map((role) => <Tag key={role} color={roleColor[role]}>{roleLabel(role)}</Tag>)}</span> }]}
              />
            )}
        </Panel>

        <PermissionMatrix />
      </div>
    </>
  )
}
