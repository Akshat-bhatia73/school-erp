import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Action, Module, Scope, type Permission, type Role } from '@erp/shared'
import { api } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { qk } from '@/lib/query'
import { cn } from '@/lib/utils'
import { StatusDot } from '@/components/shared/tag'
import { moduleLabels, scopeLabels } from './settings-tabs'

const MODULES = Module.options
const ACTIONS = Action.options
const SCOPES = Scope.options

const actionLabels: Record<(typeof ACTIONS)[number], string> = {
  view: 'View', create: 'Create', edit: 'Edit', delete: 'Delete', approve: 'Approve', export: 'Export',
}

type Draft = Record<string, { actions: Set<string>; scope: (typeof SCOPES)[number] }>

function toDraft(permissions: Permission[]): Draft {
  const d: Draft = {}
  for (const m of MODULES) d[m] = { actions: new Set<string>(), scope: 'none' }
  for (const p of permissions) {
    const row = d[p.module]
    if (!row) continue
    for (const a of p.actions) row.actions.add(a)
    row.scope = p.scope
  }
  return d
}

function fromDraft(d: Draft): Permission[] {
  return MODULES.filter((m) => d[m]!.actions.size > 0 && d[m]!.scope !== 'none').map((m) => ({
    module: m,
    actions: ACTIONS.filter((a) => d[m]!.actions.has(a)),
    scope: d[m]!.scope,
  }))
}

/** Editable grid of modules × actions for one role */
export function PermissionMatrix({ role, canEdit }: { role: Role; canEdit: boolean }) {
  const qc = useQueryClient()
  const [draft, setDraft] = useState<Draft>(() => toDraft(role.permissions))
  const [dirty, setDirty] = useState(false)

  useEffect(() => { setDraft(toDraft(role.permissions)); setDirty(false) }, [role])

  const readOnly = role.isSystem || !canEdit

  const save = useMutation({
    mutationFn: () => api.roles.update(role.id, { permissions: fromDraft(draft) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.roles })
      qc.invalidateQueries({ queryKey: qk.auditLogs() })
      setDirty(false)
      toast.success(`Saved ${role.name}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const update = (m: string, fn: (row: Draft[string]) => Draft[string]) => {
    setDraft((d) => ({ ...d, [m]: fn(d[m]!) }))
    setDirty(true)
  }

  return (
    <div className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-[13.5px] font-semibold">Permissions</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {role.isSystem ? 'System roles cannot be changed. Duplicate to customise.' : 'Tick what this role can do, and how far it reaches.'}
          </p>
        </div>
        {!readOnly && <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save changes</Button>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[13.5px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 h-10 border-b bg-card px-4 text-left font-medium text-muted-foreground">Module</th>
              {ACTIONS.map((a) => (
                <th key={a} className="h-10 w-20 border-b border-l bg-card px-2 text-center font-medium text-muted-foreground">{actionLabels[a]}</th>
              ))}
              <th className="h-10 w-44 border-b border-l bg-card px-3 text-left font-medium text-muted-foreground">Scope</th>
            </tr>
          </thead>
          <tbody>
            {MODULES.map((m) => {
              const row = draft[m]!
              return (
                <tr key={m} className="group hover:bg-accent/40">
                  <td className="sticky left-0 z-10 h-12 border-b bg-card px-4 group-hover:bg-accent/40">
                    <div className="font-medium">{moduleLabels[m].label}</div>
                    <div className="text-[12px] text-muted-foreground">{moduleLabels[m].description}</div>
                  </td>
                  {ACTIONS.map((a) => (
                    <td key={a} className="h-12 border-b border-l text-center">
                      <Checkbox
                        checked={row.actions.has(a)}
                        disabled={readOnly}
                        aria-label={`${actionLabels[a]} ${moduleLabels[m].label}`}
                        onCheckedChange={(v) => update(m, (r) => {
                          const actions = new Set(r.actions)
                          if (v) actions.add(a); else actions.delete(a)
                          const scope = actions.size > 0 && r.scope === 'none' ? 'all' : r.scope
                          return { actions, scope }
                        })}
                      />
                    </td>
                  ))}
                  <td className="h-12 border-b border-l px-2">
                    <Select value={row.scope} disabled={readOnly} onValueChange={(v) => update(m, (r) => ({ ...r, scope: v as (typeof SCOPES)[number] }))}>
                      <SelectTrigger className="h-8 w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {SCOPES.map((s) => <SelectItem key={s} value={s}>{scopeLabels[s]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function cellState(role: Role, module: string): 'done' | 'partial' | 'full' | 'empty' {
  const p = role.permissions.find((x) => x.module === module)
  if (!p || p.actions.length === 0 || p.scope === 'none') return 'empty'
  if (p.actions.length >= ACTIONS.length) return 'done'
  if (p.actions.length === 1 && p.actions[0] === 'view') return 'full'
  return 'partial'
}

const legend: Array<{ state: 'done' | 'partial' | 'full' | 'empty'; label: string }> = [
  { state: 'done', label: 'Full access' },
  { state: 'partial', label: 'Some actions' },
  { state: 'full', label: 'View only' },
  { state: 'empty', label: 'No access' },
]

/** Compact all-roles × all-modules grid */
export function RolesOverview({ roles, selectedRoleId, onSelectRole }: { roles: Role[]; selectedRoleId?: string; onSelectRole?: (id: string) => void }) {
  const cells = useMemo(() => roles.map((r) => ({ role: r, states: MODULES.map((m) => ({ module: m, state: cellState(r, m) })) })), [roles])
  return (
    <div className="rounded-xl border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-[13.5px] font-semibold">Overview</h3>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">Every role against every module, at a glance.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
          {legend.map((l) => <span key={l.label} className="inline-flex items-center gap-1.5"><StatusDot state={l.state} />{l.label}</span>)}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-[12.5px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 h-9 border-b bg-card px-4 text-left font-medium text-muted-foreground">Role</th>
              {MODULES.map((m) => (
                <th key={m} className="h-9 border-b border-l bg-card px-2 text-center font-medium text-muted-foreground">
                  <span className="block max-w-20 truncate" title={moduleLabels[m].label}>{moduleLabels[m].label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cells.map(({ role, states }) => (
              <tr
                key={role.id}
                onClick={onSelectRole ? () => onSelectRole(role.id) : undefined}
                className={cn('group hover:bg-accent/40', onSelectRole && 'cursor-pointer', role.id === selectedRoleId && 'bg-accent/60')}
              >
                <td className={cn('sticky left-0 z-10 h-9 border-b bg-card px-4 font-medium whitespace-nowrap group-hover:bg-accent/40', role.id === selectedRoleId && 'bg-accent/60')}>{role.name}</td>
                {states.map((s) => (
                  <td key={s.module} className="h-9 border-b border-l text-center">
                    <StatusDot state={s.state} title={`${role.name} — ${moduleLabels[s.module as keyof typeof moduleLabels].label}`} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
