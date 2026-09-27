import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { ArrowRightLeft, CalendarCheck, ChevronDown, Download, FileDown, IndianRupee, Pencil, UserMinus, Users } from 'lucide-react'
import { useState } from 'react'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { useExportDownload } from '@/components/shared/export-download'
import { Tag } from '@/components/shared/tag'
import { MarkLeftDialog, MoveSectionDialog } from '@/components/students/student-dialogs'
import { classLabel, StudentStatusTag } from '@/components/students/student-columns'
import { StudentLoginPanel } from '@/components/students/student-login-panel'
import { StudentBasicSheet, StudentSensitiveSheet } from '@/components/students/student-edit-sheet'
import { useExportRecord } from '@/components/students/export-record-button'
import { AnonymisePanel, ConsentsTab, DocumentsTab, EnrollmentsTab, GuardiansTab, OverviewTab, SiblingsTab, StudentPhotoDialog } from '@/components/students/student-profile'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { fullName } from '@/lib/utils'

export const Route = createFileRoute('/_app/students/$studentId')({ component: Page })

function Page() {
  const { studentId } = Route.useParams()
  const { schoolId, hasPermission } = useSchoolContext()
  const [editBasic, setEditBasic] = useState(false)
  const [editSensitive, setEditSensitive] = useState(false)
  const [move, setMove] = useState(false)
  const [markLeft, setMarkLeft] = useState(false)
  const [photo, setPhoto] = useState(false)
  const navigate = useNavigate()
  const exportFile = useExportDownload()

  const startExport = useMutation({
    mutationFn: () => api.students.exportProfile(schoolId, studentId),
    onSuccess: (job) => exportFile.start(job),
    onError: (error) => toast.error(describeError(error)),
  })

  const detailQuery = useQuery({
    queryKey: qk.student(schoolId, studentId),
    queryFn: () => api.students.get(schoolId, studentId),
  })
  const exportRecord = useExportRecord({
    studentId,
    admissionNumber: detailQuery.data?.student.admissionNumber ?? '',
    // Nothing is offered until the record itself has answered.
    allowedActions: detailQuery.data?.allowedActions ?? [],
  })

  if (detailQuery.isError) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students', icon: <Users /> }, { label: 'Not available' }]} />
        <EmptyState icon={<Users />} title="This student is not available" description={describeError(detailQuery.error)} />
      </>
    )
  }

  const detail = detailQuery.data
  if (detailQuery.isLoading || !detail) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students', icon: <Users /> }, { label: 'Loading…' }]} />
        <div className="flex items-center gap-4 border-b p-3 md:p-5">
          <Skeleton className="size-16 rounded-lg" />
          <div className="grid gap-2"><Skeleton className="h-5 w-48" /><Skeleton className="h-4 w-64" /></div>
        </div>
      </>
    )
  }

  const { student, allowedActions } = detail
  const name = fullName(student)
  const canEditBasic = allows(allowedActions, 'students.update_basic')
  const canEditSensitive = allows(allowedActions, 'students.update_sensitive')
  // Both enrolment writes resolve the current enrolment on the server, so a student without one
  // can only be told 'not found'. The controls stay hidden until there is an enrolment to change.
  // Guardian, document and enrolment keys belong to other resource types, so the server never lists
  // them in a student's allowedActions. They are school-level grants, read from the session.
  const canManageEnrollment = hasPermission('students.manage_enrollment') && Boolean(student.enrollment)
  const canReadGuardians = hasPermission('students.read_guardians')
  const canManageGuardians = hasPermission('students.manage_guardians')
  const canReadSiblings = allows(allowedActions, 'students.read_siblings')
  const canReadDocuments = hasPermission('students.read_documents')
  const canReadEnrollments = hasPermission('students.read_enrollments')
  const canReadConsents = allows(allowedActions, 'students.read_consents')
  const canAnonymise = allows(allowedActions, 'students.anonymise')
  const canExport = allows(allowedActions, 'students.export')
  const canManageLogin = hasPermission('students.manage_login')
  const canReadFees = hasPermission('fees.read')
  const canReadAttendance = hasPermission('attendance.read')
  const hasExport = canExport || exportRecord.permitted
  const hasActions = canEditBasic || canEditSensitive || canManageEnrollment || hasExport || canReadFees || canReadAttendance
  const photoSrc = student.hasPhoto ? api.students.photoUrl(schoolId, student.id, student.photoUpdatedAt) : undefined
  const openFees = () => void navigate({ to: '/fees/students/$studentId', params: { studentId: student.id } })
  const openAttendance = () => void navigate({ to: '/attendance/students/$studentId', params: { studentId: student.id } })

  const exportItems = (
    <>
      {canExport && <DropdownMenuItem disabled={startExport.isPending} onClick={() => startExport.mutate()}><FileDown />Export PDF</DropdownMenuItem>}
      {exportRecord.permitted && <DropdownMenuItem disabled={exportRecord.pending} onClick={exportRecord.run}><Download />Export this record</DropdownMenuItem>}
    </>
  )

  const menuItems = (
    <>
      {canEditSensitive && <DropdownMenuItem onClick={() => setEditSensitive(true)}><Pencil />Edit details</DropdownMenuItem>}
      {canManageEnrollment && <DropdownMenuItem onClick={() => setMove(true)}><ArrowRightLeft />Move to another section</DropdownMenuItem>}
      {canManageEnrollment && <DropdownMenuItem onClick={() => setMarkLeft(true)}><UserMinus />Mark as left</DropdownMenuItem>}
    </>
  )

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Students', to: '/students', icon: <Users /> }, { label: name }]}
        actions={
          hasActions ? (
            <>
              {canReadFees && (
                <Button asChild size="sm" variant="outline">
                  <Link to="/fees/students/$studentId" params={{ studentId: student.id }}><IndianRupee />Fee statement</Link>
                </Button>
              )}
              {canReadAttendance && (
                <Button asChild size="sm" variant="outline">
                  <Link to="/attendance/students/$studentId" params={{ studentId: student.id }}><CalendarCheck />Attendance</Link>
                </Button>
              )}
              {hasExport && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" disabled={startExport.isPending || exportRecord.pending}>
                      <FileDown />{startExport.isPending || exportRecord.pending ? 'Preparing…' : 'Export'}<ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52">{exportItems}</DropdownMenuContent>
                </DropdownMenu>
              )}
              {canEditBasic && <Button size="sm" variant="outline" onClick={() => setEditBasic(true)}><Pencil />Edit name</Button>}
              {(canEditSensitive || canManageEnrollment) && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">More<ChevronDown /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-52">{menuItems}</DropdownMenuContent>
                </DropdownMenu>
              )}
            </>
          ) : undefined
        }
        mobileActions={
          hasActions ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-9">Actions<ChevronDown /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                {canReadFees && <DropdownMenuItem onClick={openFees}><IndianRupee />Fee statement</DropdownMenuItem>}
                {canReadAttendance && <DropdownMenuItem onClick={openAttendance}><CalendarCheck />Attendance</DropdownMenuItem>}
                {exportItems}
                {(canReadFees || canReadAttendance || hasExport) && (canEditBasic || canEditSensitive || canManageEnrollment) && <DropdownMenuSeparator />}
                {canEditBasic && <DropdownMenuItem onClick={() => setEditBasic(true)}><Pencil />Edit name</DropdownMenuItem>}
                {menuItems}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined
        }
      />

      <div className="flex items-start gap-3 border-b p-3 md:gap-4 md:p-5">
        {/* Whoever may edit the record changes the photo from the avatar itself. */}
        {canEditBasic ? (
          <button
            type="button"
            onClick={() => setPhoto(true)}
            aria-label="Edit photo"
            title={student.hasPhoto ? 'Change photo' : 'Add photo'}
            className="shrink-0 rounded-lg transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <UserAvatar name={name} src={photoSrc} size="xl" className="size-12 md:size-16" />
          </button>
        ) : (
          <UserAvatar name={name} src={photoSrc} size="xl" className="size-12 md:size-16" />
        )}
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold md:text-xl">{name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {student.enrollment && <Tag>{classLabel(student)}</Tag>}
            {student.enrollment?.rollNumber !== undefined && <Tag>Roll {student.enrollment.rollNumber}</Tag>}
            <StudentStatusTag status={student.status} />
            {student.anonymised && <Tag color="grey">Anonymised</Tag>}
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground">
            <span className="font-mono">{student.admissionNumber}</span>
            {student.enrollment && <> · {student.enrollment.academicYear.name}</>}
          </p>
          {exportFile.status}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <Tabs defaultValue="overview" className="gap-4">
          <TabsList variant="line">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            {canReadGuardians && <TabsTrigger value="guardians">Guardians</TabsTrigger>}
            {canReadConsents && <TabsTrigger value="consent">Consent</TabsTrigger>}
            {canReadSiblings && <TabsTrigger value="siblings">Siblings</TabsTrigger>}
            {canReadDocuments && <TabsTrigger value="documents">Documents</TabsTrigger>}
            {canReadEnrollments && <TabsTrigger value="enrollments">Class history</TabsTrigger>}
          </TabsList>
          <TabsContent value="overview" className="space-y-4">
            <OverviewTab detail={detail} showGuardianContacts={!canReadGuardians} />
            {canManageLogin && <StudentLoginPanel studentId={student.id} />}
            {canAnonymise && !student.anonymised && <AnonymisePanel student={student} />}
          </TabsContent>
          {canReadGuardians && (
            <TabsContent value="guardians"><GuardiansTab studentId={student.id} studentVersion={student.version} canManage={canManageGuardians} allowedActions={allowedActions} /></TabsContent>
          )}
          {canReadConsents && <TabsContent value="consent"><ConsentsTab studentId={student.id} /></TabsContent>}
          {canReadSiblings && <TabsContent value="siblings"><SiblingsTab studentId={student.id} /></TabsContent>}
          {canReadDocuments && (
            <TabsContent value="documents"><DocumentsTab studentId={student.id} allowedActions={allowedActions} /></TabsContent>
          )}
          {canReadEnrollments && <TabsContent value="enrollments"><EnrollmentsTab studentId={student.id} /></TabsContent>}
        </Tabs>
      </div>

      {canEditBasic && (
        <StudentPhotoDialog student={student} canReadConsents={canReadConsents} open={photo} onOpenChange={setPhoto} />
      )}
      {canEditBasic && (
        <StudentBasicSheet key={`basic:${student.version}`} open={editBasic} onOpenChange={setEditBasic} student={student} />
      )}
      {canEditSensitive && (
        <StudentSensitiveSheet
          key={`sensitive:${student.version}`}
          open={editSensitive}
          onOpenChange={setEditSensitive}
          student={student}
          sensitive={detail.sensitive}
          medical={detail.medical}
        />
      )}
      {canManageEnrollment && (
        <MoveSectionDialog
          open={move}
          onOpenChange={setMove}
          studentId={student.id}
          expectedVersion={student.version}
          academicYearId={student.enrollment?.academicYear.id ?? null}
        />
      )}
      {canManageEnrollment && (
        <MarkLeftDialog open={markLeft} onOpenChange={setMarkLeft} studentId={student.id} expectedVersion={student.version} />
      )}
    </>
  )
}
