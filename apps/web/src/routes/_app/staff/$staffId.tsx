/**
 * One staff record. The server sends only the blocks this person may read, so a block that is
 * absent is simply not rendered — there is no placeholder for private data.
 */
import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CalendarDays, FileDown, Pencil, Users } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { EmptyState, Facts, PageHeader, Panel } from '@/components/shared/page'
import { useExportDownload } from '@/components/shared/export-download'
import { Tag, colorFor } from '@/components/shared/tag'
import { UserAvatar } from '@/components/shared/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { describeError, isApiError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate, formatINR } from '@/lib/utils'
import { StaffContactSheet, StaffEmploymentSheet, StaffPaySheet } from '@/components/staff/edit-sheet'
import { TeachingTab } from '@/components/staff/teaching-tab'
import { LoginTab } from '@/components/staff/login-tab'
import { StaffStatusTag, employmentLabel } from '@/components/staff/shared'
import { StaffAnonymisePanel } from '@/components/staff/anonymise-panel'

export const Route = createFileRoute('/_app/staff/$staffId')({ component: Page })

function Page() {
  const { staffId } = Route.useParams()
  const { schoolId, hasPermission } = useSchoolContext()
  const [editing, setEditing] = useState<'employment' | 'contact' | 'pay' | null>(null)
  const exportFile = useExportDownload()

  const startExport = useMutation({
    mutationFn: () => api.staff.exportProfile(schoolId, staffId),
    onSuccess: (job) => exportFile.start(job),
    onError: (error) => toast.error(describeError(error)),
  })

  const detailQuery = useQuery({
    queryKey: qk.staffMember(schoolId, staffId),
    queryFn: () => api.staff.get(schoolId, staffId),
  })

  if (detailQuery.isLoading) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Staff', to: '/staff', icon: <Users /> }, { label: 'Loading…' }]} />
        <div className="space-y-4 p-3 md:p-5"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div>
      </>
    )
  }

  if (detailQuery.error || !detailQuery.data) {
    const refused = isApiError(detailQuery.error, 'ACCESS_DENIED')
    return (
      <>
        <PageHeader crumbs={[{ label: 'Staff', to: '/staff', icon: <Users /> }, { label: refused ? 'Not available' : 'Not found' }]} />
        <EmptyState
          icon={<Users />}
          title={refused ? 'You cannot open this staff record' : 'Staff member not found'}
          description={refused ? 'Ask the school owner if you need to see this person’s record.' : 'This record may have been removed.'}
        />
      </>
    )
  }

  const detail = detailQuery.data
  const { staff, employment } = detail
  const canEditEmployment = allows(detail.allowedActions, 'staff.update_employment')
  const canEditContact = allows(detail.allowedActions, 'staff.update_private')
  const canEditPay = allows(detail.allowedActions, 'staff.update_pay')
  const canSeeTeaching = allows(detail.allowedActions, 'staff.read_employment')
  const canSeeLogin = hasPermission('members.read')
  const canAnonymise = allows(detail.allowedActions, 'staff.anonymise')
  const canExport = allows(detail.allowedActions, 'staff.export')
  // Mount each sheet only while it is open, so its fields always come from the version being saved.

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Staff', to: '/staff', icon: <Users /> }, { label: staff.displayName }]}
        actions={(canExport || canEditEmployment) ? (
          <>
            {canExport && (
              <Button variant="outline" size="sm" disabled={startExport.isPending} onClick={() => startExport.mutate()}>
                <FileDown />{startExport.isPending ? 'Preparing…' : 'Export PDF'}
              </Button>
            )}
            {canEditEmployment && (
              <Button variant="outline" size="sm" onClick={() => setEditing('employment')}><Pencil />Edit employment</Button>
            )}
          </>
        ) : undefined}
        mobileActions={(canExport || canEditEmployment) ? (
          <>
            {canExport && (
              <Button variant="outline" size="sm" className="h-9" disabled={startExport.isPending} onClick={() => startExport.mutate()}>
                <FileDown />PDF
              </Button>
            )}
            {canEditEmployment && (
              <Button variant="outline" size="sm" className="h-9" onClick={() => setEditing('employment')}><Pencil />Edit</Button>
            )}
          </>
        ) : undefined}
      />

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="flex items-start gap-3 border-b bg-card p-3 md:gap-4 md:px-5 md:py-5">
          <UserAvatar name={staff.displayName} size="xl" className="size-12 md:size-16" />
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold md:text-[20px]">{staff.displayName}</h1>
            <p className="mt-0.5 text-[13.5px] text-muted-foreground">{staff.designation}</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              {staff.department && <Tag color={colorFor(staff.department)}>{staff.department}</Tag>}
              {employment && <Tag>{employmentLabel[employment.employmentType]}</Tag>}
              {employment && <StaffStatusTag status={employment.status} />}
              {staff.anonymised && <Tag>Anonymised</Tag>}
            </div>
            {exportFile.status}
          </div>
        </div>

        <Tabs defaultValue="overview" className="gap-0">
          <div className="border-b bg-card px-3 py-2 md:px-4">
            <TabsList variant="line">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {canSeeTeaching && <TabsTrigger value="teaching">Teaching</TabsTrigger>}
              {canSeeLogin && <TabsTrigger value="login">Login</TabsTrigger>}
              {hasPermission('timetable.read') && <TabsTrigger value="timetable">Timetable</TabsTrigger>}
            </TabsList>
          </div>

          <TabsContent value="overview" className="space-y-4 p-3 md:p-5">
            <Panel title="Directory">
              <Facts
                columns={3}
                items={[
                  { label: 'Name', value: staff.displayName },
                  { label: 'Designation', value: staff.designation },
                  { label: 'Department', value: staff.department ?? '—' },
                ]}
              />
            </Panel>

            {employment && (
              <Panel
                title="Employment"
                actions={canEditEmployment ? <Button variant="ghost" size="sm" onClick={() => setEditing('employment')}>Edit</Button> : undefined}
              >
                <Facts
                  columns={3}
                  items={[
                    { label: 'Employee code', value: employment.employeeCode },
                    { label: 'Employment type', value: employmentLabel[employment.employmentType] },
                    { label: 'Status', value: <StaffStatusTag status={employment.status} /> },
                    { label: 'Joining date', value: formatDate(employment.joiningDate) },
                  ]}
                />
              </Panel>
            )}

            {detail.private && (
              <Panel
                title="Contact"
                actions={canEditContact ? <Button variant="ghost" size="sm" onClick={() => setEditing('contact')}>Edit</Button> : undefined}
              >
                <Facts
                  columns={3}
                  items={[
                    { label: 'Phone', value: <span className="font-mono">{detail.private.phone}</span> },
                    { label: 'Address', value: detail.private.address ?? '—' },
                    { label: 'Date of birth', value: detail.private.dateOfBirth ? formatDate(detail.private.dateOfBirth) : '—' },
                    { label: 'Bank account', value: detail.private.bankAccountLast4 ? `•••• ${detail.private.bankAccountLast4}` : '—' },
                    { label: 'PAN', value: detail.private.panLast4 ? `•••••• ${detail.private.panLast4}` : '—' },
                  ]}
                />
              </Panel>
            )}

            {detail.pay && (
              <Panel
                title="Pay"
                actions={canEditPay ? <Button variant="ghost" size="sm" onClick={() => setEditing('pay')}>Edit</Button> : undefined}
              >
                <Facts columns={3} items={[{ label: 'Monthly salary', value: formatINR(detail.pay.monthlySalary) }]} />
              </Panel>
            )}
            {canAnonymise && !staff.anonymised && <StaffAnonymisePanel staff={staff} />}
          </TabsContent>

          {canSeeTeaching && (
            <TabsContent value="teaching" className="p-3 md:p-5">
              <TeachingTab
                staffId={staff.id}
                staffVersion={staff.version}
                canManage={hasPermission('staff.manage_assignments')}
              />
            </TabsContent>
          )}

          {canSeeLogin && (
            <TabsContent value="login" className="p-3 md:p-5">
              <LoginTab staffId={staff.id} displayName={staff.displayName} />
            </TabsContent>
          )}

          {hasPermission('timetable.read') && (
            <TabsContent value="timetable" className="p-3 md:p-5">
              <Panel title="Timetable" description="The weekly grid lives on the timetable screen.">
                <Button variant="outline" size="sm" asChild>
                  <Link to="/timetable/teachers" search={{ staffId: staff.id }}><CalendarDays />Open this teacher’s timetable</Link>
                </Button>
              </Panel>
            </TabsContent>
          )}
        </Tabs>
      </div>

      {canEditEmployment && editing === 'employment' && (
        <StaffEmploymentSheet key={`employment-${staff.version}`} detail={detail} open onOpenChange={(open) => setEditing(open ? 'employment' : null)} />
      )}
      {canEditContact && editing === 'contact' && (
        <StaffContactSheet key={`contact-${staff.version}`} detail={detail} open onOpenChange={(open) => setEditing(open ? 'contact' : null)} />
      )}
      {canEditPay && editing === 'pay' && (
        <StaffPaySheet key={`pay-${staff.version}`} detail={detail} open onOpenChange={(open) => setEditing(open ? 'pay' : null)} />
      )}
    </>
  )
}
