/** Add a staff member. Creation never makes a login and never sets pay; the contract says so. */
import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Users } from 'lucide-react'
import { api } from '@/lib/api'
import type { CreateStaffInput } from '@/lib/api/staff'
import { EmptyState, PageHeader, Panel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { EmploymentFields, PersonalFields, emptyDraft, validateDraft, type FieldErrors, type StaffDraft } from '@/components/staff/form'

export const Route = createFileRoute('/_app/staff/new')({ component: Page })

function Page() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { schoolId, hasPermission } = useSchoolContext()
  const canCreate = hasPermission('staff.create')

  const [draft, setDraft] = useState<StaffDraft>(emptyDraft)
  const [errors, setErrors] = useState<FieldErrors>({})
  const set = (patch: Partial<StaffDraft>) => setDraft((current) => ({ ...current, ...patch }))

  const departmentsQuery = useQuery({
    queryKey: qk.departments(schoolId),
    queryFn: () => api.staff.departments(schoolId),
    enabled: canCreate,
  })

  const save = useMutation({
    mutationFn: (input: CreateStaffInput) => api.staff.create(schoolId, input),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'staff'] })
      toast.success(`Added ${created.displayName} to staff`)
      void navigate({ to: '/staff/$staffId', params: { staffId: created.id } })
    },
    onError: (error) => toast.error(describeError(error)),
  })

  function onSubmit() {
    const result = validateDraft(draft)
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
        <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 md:px-5 md:py-6">
          <Panel title="Personal" description="Who this person is and how to reach them.">
            <PersonalFields d={draft} set={set} errors={errors} />
          </Panel>

          <Panel title="Employment" description="Role in the school and joining details.">
            <EmploymentFields d={draft} set={set} errors={errors} departments={departmentsQuery.data ?? []} />
          </Panel>

          <p className="text-[12.5px] text-muted-foreground">
            Pay and a login are set later, from the staff record.
          </p>
        </div>
      </div>
    </>
  )
}
