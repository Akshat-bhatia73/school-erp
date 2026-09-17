import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Download, FileText, Plus, Users } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, Facts, Panel } from '@/components/shared/page'
import { colorFor, StatusDot, Tag, type TagColor } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import type { Enrollment, StudentDetail, StudentSummary } from '@/lib/api/students'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate, fullName, humanize } from '@/lib/utils'
import { GuardianSheet, type GuardianSheetEditing } from './guardian-sheet'
import { classLabel } from './student-columns'

/** A refused read is one sentence, not a blank tab. */
function Refused({ what }: { what: string }) {
  return <p className="text-[13px] text-muted-foreground">You do not have permission to see {what}.</p>
}

/**
 * Everything the server chose to send about this student. A block it left out (sensitive,
 * medical, guardian contacts) is simply not rendered: there is no placeholder for private data.
 */
export function OverviewTab({ detail, showGuardianContacts }: { detail: StudentDetail; showGuardianContacts: boolean }) {
  const { student, sensitive, medical, guardianContacts } = detail
  return (
    <div className="grid gap-4">
      <Panel title="Student">
        <Facts
          columns={3}
          items={[
            { label: 'Name', value: fullName(student) },
            { label: 'Admission number', value: <span className="font-mono">{student.admissionNumber}</span> },
            { label: 'Status', value: <span className="capitalize">{student.status}</span> },
            { label: 'Class', value: classLabel(student) },
            { label: 'Roll number', value: student.enrollment?.rollNumber },
            { label: 'Academic year', value: student.enrollment?.academicYear.name },
          ]}
        />
      </Panel>

      {sensitive && (
        <Panel title="Personal details">
          <Facts
            columns={3}
            items={[
              { label: 'Date of birth', value: formatDate(sensitive.dateOfBirth) },
              { label: 'Gender', value: humanize(sensitive.gender) },
              { label: 'Category', value: sensitive.category },
              { label: 'Admission type', value: sensitive.admissionType },
              { label: 'Admission date', value: formatDate(sensitive.admissionDate) },
              { label: 'Aadhaar last 4', value: sensitive.aadhaarLast4 ? <span className="font-mono">•••• {sensitive.aadhaarLast4}</span> : undefined },
              { label: 'APAAR ID', value: sensitive.apaarId ? <span className="font-mono">{sensitive.apaarId}</span> : undefined },
              { label: 'Address', value: sensitive.address },
            ]}
          />
        </Panel>
      )}

      {medical && (
        <Panel title="Health">
          <Facts columns={3} items={[{ label: 'Blood group', value: medical.bloodGroup }, { label: 'Medical notes', value: medical.medicalNotes }]} />
        </Panel>
      )}

      {showGuardianContacts && guardianContacts && guardianContacts.length > 0 && (
        <Panel title="Who to call" description="The contacts the school may share with staff.">
          <ul className="divide-y">
            {guardianContacts.map((contact) => (
              <li key={contact.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <UserAvatar name={contact.displayName} size="sm" />
                <span className="min-w-0 flex-1 truncate">{contact.displayName}</span>
                <Tag color={colorFor(contact.relation)}>{humanize(contact.relation)}</Tag>
                <span className="font-mono text-[12.5px] text-muted-foreground">{contact.phone}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  )
}

export function GuardiansTab({ studentId, canManage }: { studentId: string; canManage: boolean }) {
  const { schoolId } = useSchoolContext()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<GuardianSheetEditing | null>(null)

  const guardians = useQuery({
    queryKey: qk.studentGuardians(schoolId, studentId),
    queryFn: () => api.students.guardians(schoolId, studentId),
  })

  if (guardians.isError) return <Panel title="Parents and guardians"><Refused what="this family's guardian records" /></Panel>

  return (
    <>
      <Panel
        title="Parents and guardians"
        actions={canManage ? <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus />Add guardian</Button> : undefined}
      >
        {guardians.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">{[0, 1].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        ) : (guardians.data ?? []).length === 0 ? (
          <EmptyState icon={<Users />} title="No guardians yet" description="Add a parent or guardian so the school can reach the family." className="py-10" />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(guardians.data ?? []).map((guardian) => {
              // The guardian contract carries no version yet, so editing is offered only when a
              // server that does send one is in front of us.
              const version = (guardian as { version?: number }).version
              return (
                <div key={guardian.id} className="rounded-xl border p-3.5">
                  <div className="flex items-start gap-3">
                    <UserAvatar name={guardian.displayName} size="lg" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{guardian.displayName}</div>
                      <div className="mt-1 font-mono text-[12.5px] text-muted-foreground">{guardian.phone}</div>
                      {guardian.occupation && <div className="text-[12.5px] text-muted-foreground">{guardian.occupation}</div>}
                      {guardian.address && <div className="text-[12.5px] text-muted-foreground">{guardian.address}</div>}
                    </div>
                    {canManage && version !== undefined && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing({
                          guardianId: guardian.id,
                          expectedVersion: version,
                          displayName: guardian.displayName,
                          phone: guardian.phone,
                          occupation: guardian.occupation,
                          address: guardian.address,
                        })}
                      >
                        Edit
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Panel>
      {canManage && (guardians.data ?? []).some((guardian) => (guardian as { version?: number }).version === undefined) && (
        <p className="mt-2 text-[12.5px] text-muted-foreground">Correcting a guardian already on file is not built yet. Add the right record and ask the office to remove the old one.</p>
      )}
      {canManage && <GuardianSheet open={adding} onOpenChange={setAdding} studentId={studentId} />}
      {canManage && editing && (
        <GuardianSheet
          key={editing.guardianId}
          open
          onOpenChange={(value) => { if (!value) setEditing(null) }}
          studentId={studentId}
          editing={editing}
        />
      )}
    </>
  )
}

export function SiblingsTab({ studentId }: { studentId: string }) {
  const { schoolId } = useSchoolContext()
  const siblings = useQuery({
    queryKey: qk.studentSiblings(schoolId, studentId),
    queryFn: () => api.students.siblings(schoolId, studentId),
  })

  if (siblings.isError) return <Panel title="Siblings"><Refused what="siblings in this school" /></Panel>

  return (
    <Panel title="Siblings" description="Students who share a guardian.">
      {siblings.isLoading ? (
        <div className="grid gap-2">{[0, 1].map((i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : (siblings.data ?? []).length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No siblings in this school.</p>
      ) : (
        <ul className="divide-y">
          {(siblings.data ?? []).map((sibling: StudentSummary) => (
            <li key={sibling.id}>
              <Link to="/students/$studentId" params={{ studentId: sibling.id }} className="flex items-center gap-3 py-2.5 hover:bg-accent/50">
                <UserAvatar name={fullName(sibling)} size="sm" />
                <span className="link-dotted min-w-0 flex-1 truncate font-medium">{fullName(sibling)}</span>
                {classLabel(sibling) && <Tag color={colorFor(sibling.enrollment!.grade.name)}>{classLabel(sibling)}</Tag>}
                <span className="font-mono text-[12px] text-muted-foreground">{sibling.admissionNumber}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

export function DocumentsTab({ studentId, allowedActions }: { studentId: string; allowedActions: StudentDetail['allowedActions'] }) {
  const { schoolId } = useSchoolContext()
  const [busyId, setBusyId] = useState<string | null>(null)
  const documents = useQuery({
    queryKey: qk.studentDocuments(schoolId, studentId),
    queryFn: () => api.students.documents(schoolId, studentId),
  })

  const download = async (documentId: string, fallbackName: string) => {
    setBusyId(documentId)
    try {
      const file = await api.files.downloadStudentDocument(schoolId, studentId, documentId)
      const url = URL.createObjectURL(file.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = file.fileName || fallbackName
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setBusyId(null)
    }
  }

  if (documents.isError) return <Panel title="Documents"><Refused what="this student's documents" /></Panel>

  return (
    <Panel title="Documents" bodyClassName="px-0 pb-0">
      {documents.isLoading ? (
        <div className="grid gap-2 px-4 pb-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : (documents.data ?? []).length === 0 ? (
        <EmptyState icon={<FileText />} title="No documents on file" description="Birth certificate, transfer certificate and marksheets will show here." className="py-10" />
      ) : (
        <ul className="divide-y border-t">
          {(documents.data ?? []).map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 md:px-4">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px]">{row.fileName}</span>
                <span className="block text-[12px] text-muted-foreground">{humanize(row.type)} · {Math.max(1, Math.round(row.sizeBytes / 1024))} KB</span>
              </span>
              <StatusDot state={row.verified ? 'done' : 'empty'} title={row.verified ? 'Verified' : 'Not verified'} />
              {allows(row.allowedActions ?? allowedActions, 'students.download_documents') && (
                <Button size="sm" variant="outline" disabled={busyId === row.id} onClick={() => void download(row.id, row.fileName)}>
                  <Download />{busyId === row.id ? 'Getting file…' : 'Download'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

const OUTCOME: Record<Enrollment['outcome'], { label: string; color: TagColor }> = {
  ongoing: { label: 'Ongoing', color: 'green' },
  promoted: { label: 'Promoted', color: 'blue' },
  detained: { label: 'Detained', color: 'orange' },
  left: { label: 'Left', color: 'grey' },
}

export function EnrollmentsTab({ studentId }: { studentId: string }) {
  const { schoolId } = useSchoolContext()
  const enrollments = useQuery({
    queryKey: qk.studentEnrollments(schoolId, studentId),
    queryFn: () => api.students.enrollments(schoolId, studentId),
  })

  if (enrollments.isError) return <Panel title="Class history"><Refused what="this student's class history" /></Panel>

  return (
    <Panel title="Class history">
      {enrollments.isLoading ? (
        <div className="grid gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : (enrollments.data ?? []).length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No enrolment records yet.</p>
      ) : (
        <ol className="relative ml-1.5 border-l pl-5">
          {(enrollments.data ?? []).map((row) => {
            const outcome = OUTCOME[row.outcome]
            return (
              <li key={row.id} className="relative pb-5 last:pb-0">
                <span className="absolute top-1.5 -left-[26px] size-2.5 rounded-full border-2 border-card bg-muted-foreground/50" />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.academicYear.name}</span>
                  <Tag color={outcome.color}>{outcome.label}</Tag>
                </div>
                <div className="mt-0.5 text-[13px] text-muted-foreground">
                  {row.grade.name} - {row.section.name}
                  {row.rollNumber !== undefined && <> · Roll {row.rollNumber}</>}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </Panel>
  )
}
