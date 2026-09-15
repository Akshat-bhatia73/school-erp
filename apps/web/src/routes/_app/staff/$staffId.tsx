import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CircleSlash, MoreHorizontal, PauseCircle, PlayCircle, Users , Pencil} from 'lucide-react'
import type { StaffStatus } from '@erp/shared'
import { api } from '@/api/client'
import { EmptyState, Facts, PageHeader, Panel } from '@/components/shared/page'
import { Tag, colorFor } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { formatDate, formatINR, fullName, humanize } from '@/lib/utils'
import { StaffEditSheet } from '@/components/staff/edit-sheet'
import { TeachingTab } from '@/components/staff/teaching-tab'
import { LoginTab } from '@/components/staff/login-tab'
import { StaffStatusTag, StaffTypeTag, canSeePay, employmentLabel } from '@/components/staff/shared'

export const Route = createFileRoute('/_app/staff/$staffId')({ component: Page })

function Page() {
  const qc = useQueryClient()
  const { staffId } = Route.useParams()
  const { can, roles } = useSession()
  const showPay = canSeePay(roles)
  const canEdit = can('staff', 'edit')

  const [editing, setEditing] = useState(false)
  const [resigning, setResigning] = useState(false)
  const [leavingDate, setLeavingDate] = useState(new Date().toISOString().slice(0, 10))

  const { data: staff, isLoading, isError } = useQuery({ queryKey: qk.staffMember(staffId), queryFn: () => api.staff.get(staffId) })

  const setStatus = useMutation({
    mutationFn: (patch: { status: StaffStatus; leavingDate?: string }) => api.staff.update(staffId, patch),
    onSuccess: (s) => {
      qc.invalidateQueries({ queryKey: qk.staffMember(staffId) })
      qc.invalidateQueries({ queryKey: ['staff'] })
      toast.success(`${fullName(s)} is now ${humanize(s.status).toLowerCase()}`)
      setResigning(false)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  if (isLoading) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Staff', to: '/staff', icon: <Users /> }, { label: 'Loading…' }]} />
        <div className="space-y-4 p-3 md:p-5"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>
      </>
    )
  }

  if (isError || !staff) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Staff', to: '/staff', icon: <Users /> }, { label: 'Not found' }]} />
        <EmptyState icon={<Users />} title="Staff member not found" description="This record may have been removed." />
      </>
    )
  }

  const name = fullName(staff)

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Staff', to: '/staff', icon: <Users /> }, { label: name }]}
        actions={canEdit ? (
          <>
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="More actions"><MoreHorizontal /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-48">
                {staff.status === 'active' ? (
                  <DropdownMenuItem onClick={() => setStatus.mutate({ status: 'on_leave' })}><PauseCircle />Mark on leave</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => setStatus.mutate({ status: 'active' })}><PlayCircle />Mark active</DropdownMenuItem>
                )}
                {staff.status !== 'resigned' && (
                  <DropdownMenuItem variant="destructive" onClick={() => setResigning(true)}><CircleSlash />Mark resigned</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : undefined}
        mobileActions={canEdit ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9" aria-label="Staff actions"><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              <DropdownMenuItem onClick={() => setEditing(true)}><Pencil />Edit</DropdownMenuItem>
              {staff.status === 'active' ? (
                <DropdownMenuItem onClick={() => setStatus.mutate({ status: 'on_leave' })}><PauseCircle />Mark on leave</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => setStatus.mutate({ status: 'active' })}><PlayCircle />Mark active</DropdownMenuItem>
              )}
              {staff.status !== 'resigned' && (
                <DropdownMenuItem variant="destructive" onClick={() => setResigning(true)}><CircleSlash />Mark resigned</DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : undefined}
      />

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="flex items-start gap-3 border-b bg-card p-3 md:gap-4 md:px-5 md:py-5">
          <UserAvatar name={name} src={staff.photoUrl} size="xl" className="size-12 md:size-16" />
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold md:text-[20px]">{name}</h1>
            <p className="mt-0.5 text-[13.5px] text-muted-foreground">{staff.designation}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <StaffTypeTag type={staff.staffType} />
              {staff.department && <Tag color={colorFor(staff.department)}>{staff.department}</Tag>}
              <Tag>{employmentLabel[staff.employmentType]}</Tag>
              <StaffStatusTag status={staff.status} />
            </div>
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              {staff.employeeCode} · Joined {formatDate(staff.joiningDate)}
              {staff.experienceYears !== undefined && ` · ${staff.experienceYears} years experience`}
            </p>
          </div>
        </div>

        <Tabs defaultValue="overview" className="gap-0">
          <div className="border-b bg-card px-3 py-2 md:px-4">
            <TabsList variant="line">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="teaching">Teaching</TabsTrigger>
              <TabsTrigger value="login">Login</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="space-y-4 p-3 md:p-5">
            <Panel title="Personal">
              <Facts
                columns={3}
                items={[
                  { label: 'Gender', value: humanize(staff.gender) },
                  { label: 'Date of birth', value: staff.dateOfBirth ? formatDate(staff.dateOfBirth) : '—' },
                  { label: 'Blood group', value: staff.bloodGroup === 'unknown' ? 'Not known' : staff.bloodGroup },
                  { label: 'Phone', value: <span className="font-mono">{staff.phone}</span> },
                  { label: 'Email', value: staff.email ?? '—' },
                  { label: 'Qualification', value: staff.qualification ?? '—' },
                  { label: 'Experience', value: staff.experienceYears !== undefined ? `${staff.experienceYears} years` : '—' },
                ]}
              />
            </Panel>

            <Panel title="Employment">
              <Facts
                columns={3}
                items={[
                  { label: 'Employee code', value: staff.employeeCode },
                  { label: 'Staff type', value: <StaffTypeTag type={staff.staffType} /> },
                  { label: 'Designation', value: staff.designation },
                  { label: 'Department', value: staff.department ?? '—' },
                  { label: 'Employment type', value: employmentLabel[staff.employmentType] },
                  { label: 'Joining date', value: formatDate(staff.joiningDate) },
                  { label: 'Leaving date', value: staff.leavingDate ? formatDate(staff.leavingDate) : '—' },
                ]}
              />
            </Panel>

            {showPay && (
              <Panel title="Pay & bank" description="Visible to the owner and the accountant only.">
                <Facts
                  columns={3}
                  items={[
                    { label: 'Monthly salary', value: staff.monthlySalary !== undefined ? formatINR(staff.monthlySalary) : '—' },
                    { label: 'Bank account', value: staff.bankAccountLast4 ? `•••• ${staff.bankAccountLast4}` : '—' },
                    { label: 'PAN', value: staff.panLast4 ? `•••••• ${staff.panLast4}` : '—' },
                  ]}
                />
              </Panel>
            )}

            <Panel title="Address">
              {staff.address ? (
                <Facts
                  columns={3}
                  items={[
                    { label: 'Address', value: [staff.address.line1, staff.address.line2].filter(Boolean).join(', ') },
                    { label: 'City', value: staff.address.city },
                    { label: 'District', value: staff.address.district ?? '—' },
                    { label: 'State', value: staff.address.state },
                    { label: 'PIN code', value: staff.address.pincode },
                  ]}
                />
              ) : (
                <p className="text-[13px] text-muted-foreground">No address on record.</p>
              )}
            </Panel>
          </TabsContent>

          <TabsContent value="teaching" className="p-3 md:p-5">
            <TeachingTab staff={staff} />
          </TabsContent>

          <TabsContent value="login" className="p-3 md:p-5">
            <LoginTab staff={staff} canCreate={can('users_roles', 'create')} />
          </TabsContent>
        </Tabs>
      </div>

      {canEdit && <StaffEditSheet staff={staff} open={editing} onOpenChange={setEditing} showPay={showPay} />}

      <AlertDialog open={resigning} onOpenChange={setResigning}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Mark {name} as resigned?</AlertDialogTitle>
            <AlertDialogDescription>They will drop out of the active staff list. You can change this later.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-1">
            <Label className="mb-1.5 text-[12.5px] text-muted-foreground">Leaving date</Label>
            <Input type="date" value={leavingDate} onChange={(e) => setLeavingDate(e.target.value)} />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => setStatus.mutate({ status: 'resigned', leavingDate })}>Mark resigned</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
