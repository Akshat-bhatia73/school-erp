import { useQueries, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ChevronDown, IdCard, Pencil, UserMinus, ArrowRightLeft, Users } from 'lucide-react'
import { useState } from 'react'
import { api } from '@/api/client'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { colorFor, StatusDot, Tag } from '@/components/shared/tag'
import { GuardianSheet } from '@/components/students/guardian-sheet'
import { MarkLeftDialog, MoveSectionDialog } from '@/components/students/student-dialogs'
import { StudentEditSheet } from '@/components/students/student-edit-sheet'
import { admissionTag, DocumentsTab, GuardiansTab, HistoryTab, OverviewTab, QuickFacts, type EnrollmentRow, type GuardianLink } from '@/components/students/student-profile'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { ageFromDob, formatDate, fullName } from '@/lib/utils'

export const Route = createFileRoute('/_app/students/$studentId')({ component: Page })

function Page() {
  const { studentId } = Route.useParams()
  const { can } = useSession()
  const canEdit = can('students', 'edit')
  const [edit, setEdit] = useState(false)
  const [move, setMove] = useState(false)
  const [markLeft, setMarkLeft] = useState(false)
  const [addGuardian, setAddGuardian] = useState(false)

  const { data: student, isLoading, isError } = useQuery({ queryKey: qk.student(studentId), queryFn: () => api.students.get(studentId) })
  const [guardiansQ, siblingsQ, documentsQ, enrollmentsQ] = useQueries({
    queries: [
      { queryKey: qk.studentGuardians(studentId), queryFn: () => api.students.guardians(studentId) },
      { queryKey: qk.studentSiblings(studentId), queryFn: () => api.students.siblings(studentId) },
      { queryKey: qk.studentDocuments(studentId), queryFn: () => api.students.documents(studentId) },
      { queryKey: qk.studentEnrollments(studentId), queryFn: () => api.students.enrollments(studentId) },
    ],
  })

  if (isError) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students', icon: <Users /> }, { label: 'Not found' }]} />
        <EmptyState icon={<Users />} title="Student not found" description="This student may have been removed." />
      </>
    )
  }

  if (isLoading || !student) {
    return (
      <>
        <PageHeader crumbs={[{ label: 'Students', to: '/students', icon: <Users /> }, { label: 'Loading…' }]} />
        <div className="flex items-center gap-4 border-b p-5">
          <Skeleton className="size-16 rounded-lg" />
          <div className="grid gap-2"><Skeleton className="h-5 w-48" /><Skeleton className="h-4 w-64" /></div>
        </div>
      </>
    )
  }

  const name = fullName(student)
  const admission = admissionTag(student.admissionType)
  const guardians = (guardiansQ.data ?? []) as GuardianLink[]
  const enrollments = (enrollmentsQ.data ?? []) as EnrollmentRow[]

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Students', to: '/students', icon: <Users /> }, { label: name }]}
        actions={
          canEdit ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setEdit(true)}><Pencil />Edit</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline">More<ChevronDown /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem onClick={() => setMove(true)}><ArrowRightLeft />Move to section</DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setMarkLeft(true)}><UserMinus />Mark as left</DropdownMenuItem>
                  <DropdownMenuItem disabled><IdCard />Print ID card <span className="ml-auto text-[11px] text-muted-foreground">Phase 2</span></DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : undefined
        }
      />

      <div className="flex items-start gap-4 border-b p-5">
        <UserAvatar name={name} src={student.photoUrl} size="xl" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {student.grade && <Tag color={colorFor(student.grade.name)}>{student.grade.shortName} - {student.section?.name ?? '—'}</Tag>}
            {student.enrollment?.rollNumber !== undefined && <Tag>Roll {student.enrollment.rollNumber}</Tag>}
            {admission && <Tag color={admission.color}>{admission.label}</Tag>}
            <Tag className="capitalize" color={student.status === 'active' ? 'green' : 'grey'} dot>{student.status}</Tag>
            {student.house && <Tag color={colorFor(student.house)} dot>{student.house} house</Tag>}
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
            <span className="font-mono">{student.admissionNumber}</span>
            <span>·</span>
            <span>Admitted {formatDate(student.admissionDate)}</span>
            <span>·</span>
            <span>{ageFromDob(student.dateOfBirth)} years old</span>
            {student.status !== 'active' && student.leftOn && (<><span>·</span><StatusDot state="warn" /><span>Left {formatDate(student.leftOn)}</span></>)}
          </p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
          <Tabs defaultValue="overview" className="gap-4">
            <TabsList variant="line">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="guardians">Guardians</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="history">History</TabsTrigger>
            </TabsList>
            <TabsContent value="overview"><OverviewTab student={student} /></TabsContent>
            <TabsContent value="guardians">
              <GuardiansTab
                guardians={guardians}
                siblings={siblingsQ.data ?? []}
                isLoading={guardiansQ.isLoading}
                canEdit={canEdit}
                onAdd={() => setAddGuardian(true)}
              />
            </TabsContent>
            <TabsContent value="documents"><DocumentsTab documents={documentsQ.data ?? []} isLoading={documentsQ.isLoading} /></TabsContent>
            <TabsContent value="history"><HistoryTab enrollments={enrollments} isLoading={enrollmentsQ.isLoading} /></TabsContent>
          </Tabs>
        </div>
        <aside className="w-80 shrink-0 overflow-y-auto border-l p-4 scrollbar-thin">
          <QuickFacts student={student} siblingCount={siblingsQ.data?.length ?? 0} />
        </aside>
      </div>

      <StudentEditSheet key={`${student.id}:${student.updatedAt}`} open={edit} onOpenChange={setEdit} student={student} />
      <MoveSectionDialog open={move} onOpenChange={setMove} studentIds={[student.id]} />
      <MarkLeftDialog open={markLeft} onOpenChange={setMarkLeft} studentIds={[student.id]} />
      <GuardianSheet open={addGuardian} onOpenChange={setAddGuardian} studentId={student.id} />
    </>
  )
}
