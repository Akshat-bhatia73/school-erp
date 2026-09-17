import { Fragment, useMemo } from 'react'
import { ACTIVE_PERMISSION_KEYS, ROLE_TEMPLATES, RoleKey, type PermissionKey } from '@erp/contracts'
import { describePermission, roleLabel } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { resourceGroupLabel } from './settings-tabs'

const ROLES = RoleKey.options.filter((key) => ROLE_TEMPLATES[key].enabled)

/** 'school' -> 'Whole school', so a cell says how far a grant reaches. */
const SCOPE_LABEL: Record<string, string> = {
  school: 'Whole school',
  self: 'Self',
  assigned_sections: 'Own classes',
  assigned_subjects: 'Own subjects',
  own_children: 'Own children',
  own_record: 'Own record',
  finance: 'Finance',
}

function scopeFor(role: RoleKey, permission: PermissionKey): string | null {
  const grant = ROLE_TEMPLATES[role].grants.find((item) => item.permission === permission)
  return grant ? (SCOPE_LABEL[grant.scope] ?? grant.scope) : null
}

/**
 * The fixed role templates as a grid. Nothing here is editable: role definitions are frozen in the
 * contracts and `roles.manage` is reserved, so this screen only shows what each role already has.
 */
export function PermissionMatrix() {
  const groups = useMemo(() => {
    const byResource = new Map<string, PermissionKey[]>()
    for (const key of ACTIVE_PERMISSION_KEYS) {
      const resource = key.split('.')[0] ?? 'other'
      const list = byResource.get(resource) ?? []
      list.push(key)
      byResource.set(resource, list)
    }
    return [...byResource.entries()]
  }, [])

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <header className="border-b px-4 py-3">
        <h3 className="text-[13.5px] font-semibold">What each role can do</h3>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">Roles are fixed in this build. A cell says how far that role's access reaches.</p>
      </header>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 h-9 border-b bg-muted/40 px-3 text-left font-medium text-muted-foreground">Permission</th>
              {ROLES.map((role) => (
                <th key={role} className="h-9 border-b border-l bg-muted/40 px-3 text-left font-medium text-muted-foreground whitespace-nowrap">{roleLabel(role)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map(([resource, keys]) => (
              <Fragment key={resource}>
                <tr>
                  <td colSpan={ROLES.length + 1} className="h-8 border-b bg-muted/20 px-3 text-[12px] font-medium text-muted-foreground">
                    {resourceGroupLabel(resource)}
                  </td>
                </tr>
                {keys.map((permission) => (
                  <tr key={permission}>
                    <td className="sticky left-0 z-10 h-9 border-b bg-card px-3">{describePermission(permission)}</td>
                    {ROLES.map((role) => {
                      const scope = scopeFor(role, permission)
                      return (
                        <td key={role} className={cn('h-9 border-b border-l px-3 whitespace-nowrap', scope ? 'text-foreground' : 'text-muted-foreground/50')}>
                          {scope ?? '—'}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
