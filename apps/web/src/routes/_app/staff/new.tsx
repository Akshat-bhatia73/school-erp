import { useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Users } from 'lucide-react'
import type { StaffInput } from '@erp/shared'
import { api } from '@/api/client'
import { EmptyState, PageHeader, Panel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { AddressFields, EmploymentFields, PayFields, PersonalFields, emptyDraft, validateDraft, type FieldErrors, type StaffDraft } from '@/components/staff/form'
import { canSeePay } from '@/components/staff/shared'
import { createStaffLogin } from '@/components/staff/create-login'

export const Route = createFileRoute('/_app/staff/new')({ component: Page })

function Page() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { can, roles, school } = useSession()
  const canCreate = can('staff', 'create')
  const showPay = canSeePay(roles)

  const { data: departments = [] } = useQuery({ queryKey: qk.departments, queryFn: () => api.staff.departments() })
  const listParams = { status: 'all' as const, pageSize: 500 }
  const { data: existing } = useQuery({ queryKey: qk.staff(listParams), queryFn: () => api.staff.list(listParams) })

  const suggestedCode = useMemo(() => {
    const prefix = `${(school?.code ?? 'SCH').toUpperCase()}-E`
    const highest = (existing?.items ?? []).reduce((max, s) => {
      const n = Number(s.employeeCode.match(/(\d+)$/)?.[1] ?? 0)
      return n > max ? n : max
    }, 0)
    return `${prefix}${String(highest + 1).padStart(3, '0')}`
  }, [school, existing])

  const [draft, setDraft] = useState<StaffDraft>(emptyDraft)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [createLogin, setCreateLogin] = useState(false)
  const set = (p: Partial<StaffDraft>) => setDraft((d) => ({ ...d, ...p }))

  const code = draft.employeeCode || suggestedCode

  const save = useMutation({
    mutationFn: async (input: StaffInput) => {
      const created = await api.staff.create(input)
      if (createLogin) await createStaffLogin(created)
      return created
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['staff'] })
      qc.invalidateQueries({ queryKey: qk.departments })
      qc.invalidateQueries({ queryKey: qk.users })
      toast.success(`Added ${created.firstName} to staff`)
      navigate({ to: '/staff/$staffId', params: { staffId: created.id } })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function onSubmit() {
    const result = validateDraft({ ...draft, employeeCode: code })
    if (!result.ok) {
      setErrors(result.errors)
      toast.error('Check the highlighted fields')
      return
    }
    setErrors({})
    save.mutate(result.value)
  }

  if (!canCreate) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Staff', to: '/staff', icon: <Users /> }, { label: 'Add staff' }]} />
        <EmptyState icon={<Users />} title="You cannot add staff" description="Ask the school owner for permission to add staff members." />
      </>
    )
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Staff', to: '/staff', icon: <Users /> }, { label: 'Add staff' }]}
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate({ to: '/staff' })}>Cancel</Button>
            <Button size="sm" onClick={onSubmit} disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save staff member'}</Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="mx-auto max-w-3xl space-y-4 px-5 py-6">
          <Panel title="Personal" description="Who this person is and how to reach them.">
            <PersonalFields d={draft} set={set} errors={errors} />
          </Panel>

          <Panel title="Employment" description="Role in the school and joining details.">
            <EmploymentFields
              d={{ ...draft, employeeCode: code }}
              set={set}
              errors={errors}
              departments={departments}
              codeHint={draft.employeeCode ? undefined : `Suggested: ${suggestedCode}`}
            />
          </Panel>

          {showPay && (
            <Panel title="Pay & bank" description="Only the owner and the accountant can see this.">
              <PayFields d={draft} set={set} errors={errors} />
            </Panel>
          )}

          <Panel title="Address">
            <AddressFields d={draft} set={set} errors={errors} />
          </Panel>

          <Panel>
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label className="text-[13.5px] font-medium">Create a login for this person</Label>
                <p className="mt-0.5 text-[12.5px] text-muted-foreground">
                  {draft.staffType === 'teaching' ? 'They get the Teacher role' : 'They get the Admin role'} and sign in with {draft.phone || 'their phone number'}.
                </p>
              </div>
              <Switch checked={createLogin} onCheckedChange={setCreateLogin} />
            </div>
          </Panel>
        </div>
      </div>
    </>
  )
}
