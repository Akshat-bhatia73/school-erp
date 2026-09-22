import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Download, Eye, FileText, Plus, ShieldOff, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AnonymiseRequest, CONSENT_PURPOSES, ConsentMethod, UnlinkGuardianRequest, type ConsentPurpose } from '@erp/contracts'
import { UserAvatar } from '@/components/shared/avatar'
import { EmptyState, Facts, Panel } from '@/components/shared/page'
import { PhotoField } from '@/components/shared/photo-field'
import { colorFor, StatusDot, Tag, type TagColor } from '@/components/shared/tag'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import type { Enrollment, StudentDetail, StudentSummary } from '@/lib/api/students'
import { METHOD_LABEL, PURPOSE_DESCRIPTION, PURPOSE_LABEL } from '@/lib/consent'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate, fullName, humanize } from '@/lib/utils'
import { ExportRecordButton } from './export-record-button'
import { GuardianSheet, type GuardianSheetEditing } from './guardian-sheet'
import { classLabel } from './student-columns'

/** A refused read is one sentence, not a blank tab. */
function Refused({ what }: { what: string }) {
  return <p className="text-[13px] text-muted-foreground">You do not have permission to see {what}.</p>
}

/** How long a revealed number stays on screen before it goes back to the mask. */
const REVEAL_SECONDS = 30

/**
 * The masked id, and the full one only after an explicit, audited request.
 *
 * The answer lives in this component's own state and nowhere else: it is never put in the query
 * cache, it goes when the panel or sheet holding it unmounts, and it goes on its own after
 * thirty seconds even if the screen stays open.
 */
function RevealField({ masked, canReveal, read }: { masked: string; canReveal: boolean; read: () => Promise<string> }) {
  const [shown, setShown] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (shown === null) return
    const timer = window.setTimeout(() => setShown(null), REVEAL_SECONDS * 1000)
    return () => { window.clearTimeout(timer); setShown(null) }
  }, [shown])

  const onReveal = async () => {
    setBusy(true)
    try {
      setShown(await read())
    } catch (error) {
      toast.error(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="flex items-center gap-2">
      <span className="font-mono">{shown ?? masked}</span>
      {canReveal && shown === null && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onReveal()}>
          <Eye />{busy ? 'Getting…' : 'Reveal'}
        </Button>
      )}
    </span>
  )
}

/**
 * The student's photograph. A photo may only be held while the family has said yes to it, so when
 * this screen can see the consent answers and none of them is a yes, the controls are replaced by
 * a plain sentence. Somebody who cannot read consents still sees the controls: the server checks
 * the same rule and refuses.
 */
function StudentPhotoPanel({ student, canReadConsents }: { student: StudentDetail['student']; canReadConsents: boolean }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const consents = useQuery({
    queryKey: qk.studentConsents(schoolId, student.id),
    queryFn: () => api.students.consents(schoolId, student.id),
    enabled: canReadConsents,
  })

  const answers = (consents.data?.items ?? []).filter((row) => row.purpose === 'photographs')
  const photographsGranted = answers.some((row) => row.status === 'given') && !answers.some((row) => row.status === 'withdrawn')
  const known = canReadConsents && consents.isSuccess
  const refresh = () => queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })

  return (
    <Panel title="Photo" description="Shown on the class list and on this record.">
      <PhotoField
        name={fullName(student)}
        src={student.hasPhoto ? api.students.photoUrl(schoolId, student.id, student.photoUpdatedAt) : undefined}
        note={known && !photographsGranted ? 'Photo upload needs the photographs consent from the parent.' : undefined}
        onUpload={async (file) => {
          await api.students.uploadPhoto(schoolId, student.id, file, student.version)
          await refresh()
        }}
        onRemove={async () => {
          await api.students.removePhoto(schoolId, student.id, student.version)
          await refresh()
        }}
      />
    </Panel>
  )
}

/**
 * Everything the server chose to send about this student. A block it left out (sensitive,
 * medical, guardian contacts) is simply not rendered: there is no placeholder for private data.
 */
export function OverviewTab({ detail, showGuardianContacts }: { detail: StudentDetail; showGuardianContacts: boolean }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const { student, sensitive, medical, guardianContacts, allowedActions } = detail
  return (
    <div className="grid gap-4">
      <Panel
        title="Student"
        actions={
          <div className="flex items-center gap-2">
            {hasPermission('fees.read') && (
              <Button asChild size="sm" variant="outline">
                <Link to="/fees/students/$studentId" params={{ studentId: student.id }}>Fee statement</Link>
              </Button>
            )}
            {hasPermission('attendance.read') && (
              <Button asChild size="sm" variant="outline">
                <Link to="/attendance/students/$studentId" params={{ studentId: student.id }}>Attendance</Link>
              </Button>
            )}
            <ExportRecordButton studentId={student.id} admissionNumber={student.admissionNumber} allowedActions={allowedActions} />
          </div>
        }
      >
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

      {allows(allowedActions, 'students.update_basic') && (
        <StudentPhotoPanel student={student} canReadConsents={allows(allowedActions, 'students.read_consents')} />
      )}

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
              {
                label: 'Aadhaar',
                value: sensitive.aadhaarLast4
                  ? (
                      <RevealField
                        masked={`ending ${sensitive.aadhaarLast4}`}
                        canReveal={allows(allowedActions, 'students.read_sensitive')}
                        read={async () => (await api.students.revealAadhaar(schoolId, student.id)).aadhaar}
                      />
                    )
                  : undefined,
              },
              {
                label: 'APAAR ID',
                value: sensitive.apaarMasked
                  ? (
                      <RevealField
                        masked={sensitive.apaarMasked}
                        canReveal={allows(allowedActions, 'students.read_sensitive')}
                        read={async () => (await api.students.revealApaar(schoolId, student.id)).apaarId}
                      />
                    )
                  : undefined,
              },
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

export function GuardiansTab({ studentId, studentVersion, canManage, allowedActions }: {
  studentId: string
  studentVersion: number
  canManage: boolean
  /** The student record's own actions: the guardian list carries none of its own. */
  allowedActions: StudentDetail['allowedActions']
}) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<GuardianSheetEditing | null>(null)
  const [unlinking, setUnlinking] = useState<{ id: string; name: string } | null>(null)
  const [unlinkReason, setUnlinkReason] = useState('')
  const [unlinkError, setUnlinkError] = useState<string | null>(null)
  // Reading a guardian record is what the reveal asks for again, one guardian at a time.
  const canReveal = allows(allowedActions, 'students.read_guardians')

  const unlink = useMutation({
    mutationFn: (body: { expectedVersion: number; reason: string }) =>
      api.students.unlinkGuardian(schoolId, studentId, unlinking!.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      toast.success('Guardian unlinked')
      setUnlinking(null)
      setUnlinkReason('')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submitUnlink = () => {
    const parsed = UnlinkGuardianRequest.safeParse({ expectedVersion: studentVersion, reason: unlinkReason.trim() })
    if (!parsed.success) {
      setUnlinkError('Say why this guardian is no longer linked.')
      return
    }
    setUnlinkError(null)
    unlink.mutate(parsed.data)
  }

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
            {(guardians.data ?? []).map((guardian) => (
              <div key={guardian.id} className="rounded-xl border p-3.5">
                <div className="flex items-start gap-3">
                  <UserAvatar name={guardian.displayName} size="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{guardian.displayName}</div>
                    <div className="mt-1 font-mono text-[12.5px] text-muted-foreground">{guardian.phone}</div>
                    {guardian.occupation && <div className="text-[12.5px] text-muted-foreground">{guardian.occupation}</div>}
                    {guardian.address && <div className="text-[12.5px] text-muted-foreground">{guardian.address}</div>}
                    {guardian.officeAddress && <div className="text-[12.5px] text-muted-foreground">Office: {guardian.officeAddress}</div>}
                    {/*
                      Identity numbers are never echoed back with the record: the list carries
                      the last digits only, and the whole number comes from its own audited
                      read, held here and forgotten again.
                    */}
                    {guardian.panLast4 && (
                      <div className="mt-1 text-[12.5px] text-muted-foreground">
                        PAN{' '}
                        <RevealField
                          masked={`ending ${guardian.panLast4}`}
                          canReveal={canReveal}
                          read={async () => {
                            const revealed = await api.students.revealGuardianIdentity(schoolId, studentId, guardian.id)
                            if (!revealed.pan) throw new Error('no pan')
                            return revealed.pan
                          }}
                        />
                      </div>
                    )}
                    {guardian.aadhaarLast4 && (
                      <div className="text-[12.5px] text-muted-foreground">
                        Aadhaar{' '}
                        <RevealField
                          masked={`ending ${guardian.aadhaarLast4}`}
                          canReveal={canReveal}
                          read={async () => {
                            const revealed = await api.students.revealGuardianIdentity(schoolId, studentId, guardian.id)
                            if (!revealed.aadhaar) throw new Error('no aadhaar')
                            return revealed.aadhaar
                          }}
                        />
                      </div>
                    )}
                  </div>
                  {canManage && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditing({
                        guardianId: guardian.id,
                        expectedVersion: guardian.version,
                        displayName: guardian.displayName,
                        phone: guardian.phone,
                        occupation: guardian.occupation,
                        address: guardian.address,
                        officeAddress: guardian.officeAddress,
                        panLast4: guardian.panLast4,
                        aadhaarLast4: guardian.aadhaarLast4,
                      })}
                    >
                      Edit
                    </Button>
                  )}
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => { setUnlinking({ id: guardian.id, name: guardian.displayName }); setUnlinkReason(''); setUnlinkError(null) }}>
                      Unlink
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
      {canManage && unlinking && (
        <AlertDialog open onOpenChange={(open) => { if (!open) setUnlinking(null) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unlink {unlinking.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This guardian stops being a contact for this student. If they are not linked to any other
                student, their personal details are cleared as well.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5 px-1">
              <Label>Reason</Label>
              <Textarea rows={2} value={unlinkReason} onChange={(e) => setUnlinkReason(e.target.value)} placeholder="No longer the guardian of this student" />
              {unlinkError && <p className="text-[12px] text-destructive">{unlinkError}</p>}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep guardian</AlertDialogCancel>
              <Button variant="destructive" disabled={unlink.isPending} onClick={submitUnlink}>
                {unlink.isPending ? 'Unlinking…' : 'Unlink guardian'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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

const METHODS = ConsentMethod.options

/**
 * What each guardian agreed to, newest answer per purpose. Recording and withdrawing are the same
 * write with a different status, so both controls appear together or not at all.
 */
export function ConsentsTab({ studentId }: { studentId: string }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [method, setMethod] = useState<(typeof METHODS)[number]>('in_person')

  const consents = useQuery({
    queryKey: qk.studentConsents(schoolId, studentId),
    queryFn: () => api.students.consents(schoolId, studentId),
  })
  const guardians = useQuery({
    queryKey: qk.studentGuardians(schoolId, studentId),
    queryFn: () => api.students.guardians(schoolId, studentId),
  })

  const record = useMutation({
    mutationFn: (body: Parameters<typeof api.students.recordConsent>[2]) => api.students.recordConsent(schoolId, studentId, body),
    // The write answers with the whole current list, so the words come from what was sent.
    onSuccess: (_list, sent) => {
      void queryClient.invalidateQueries({ queryKey: qk.studentConsents(schoolId, studentId) })
      toast.success(sent.status === 'given' ? 'Consent recorded' : 'Consent withdrawn')
    },
    onError: (error) => toast.error(describeError(error)),
  })

  if (consents.isError) return <Panel title="Consent"><Refused what="this family's consent records" /></Panel>
  if (consents.isLoading || !consents.data) {
    return <Panel title="Consent"><div className="grid gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9" />)}</div></Panel>
  }

  const canManage = allows(consents.data.allowedActions, 'students.manage_consents')
  const rows = consents.data.items
  // Every linked guardian is listed, because a purpose nobody answered is still a question.
  const people = new Map<string, string>()
  for (const guardian of guardians.data ?? []) people.set(guardian.id, guardian.displayName)
  for (const row of rows) if (!people.has(row.guardianId)) people.set(row.guardianId, row.guardianDisplayName)

  if (people.size === 0) {
    return (
      <Panel title="Consent">
        <EmptyState icon={<Users />} title="No guardians yet" description="Add a guardian before recording what the family agreed to." className="py-10" />
      </Panel>
    )
  }

  return (
    <Panel
      title="Consent"
      description="The latest answer from each guardian, for each purpose."
      actions={canManage ? (
        <Select value={method} onValueChange={(value) => setMethod(value as (typeof METHODS)[number])}>
          <SelectTrigger size="sm" className="w-52"><SelectValue /></SelectTrigger>
          <SelectContent>{METHODS.map((m) => <SelectItem key={m} value={m}>{METHOD_LABEL[m]}</SelectItem>)}</SelectContent>
        </Select>
      ) : undefined}
    >
      <div className="grid gap-4">
        {[...people].map(([guardianId, displayName]) => (
          <div key={guardianId}>
            <div className="mb-1.5 flex items-center gap-2 text-[13.5px] font-medium">
              <UserAvatar name={displayName} size="xs" />{displayName}
            </div>
            <ul className="divide-y rounded-xl border">
              {CONSENT_PURPOSES.map((purpose: ConsentPurpose) => {
                const current = rows.find((row) => row.guardianId === guardianId && row.purpose === purpose)
                const given = current?.status === 'given'
                return (
                  <li key={purpose} className="flex flex-wrap items-center gap-2 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px]">{PURPOSE_LABEL[purpose]}</span>
                      <span className="block text-[12.5px] text-muted-foreground">{PURPOSE_DESCRIPTION[purpose]}</span>
                    </span>
                    {current
                      ? <Tag color={given ? 'green' : 'grey'}>{given ? `Given ${formatDate(current.recordedAt)}` : `Withdrawn ${formatDate(current.recordedAt)}`}</Tag>
                      : <Tag color="grey">Not asked</Tag>}
                    {canManage && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={record.isPending}
                        onClick={() => record.mutate({ guardianId, purpose, status: given ? 'withdrawn' : 'given', method })}
                      >
                        {given ? 'Withdraw' : 'Give'}
                      </Button>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </Panel>
  )
}

/**
 * Anonymisation, kept apart from everything else because it cannot be undone. The server refuses
 * while the retention period is still running, so this only ever offers the request.
 */
export function AnonymisePanel({ student }: { student: StudentDetail['student'] }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const anonymise = useMutation({
    mutationFn: (body: Parameters<typeof api.students.anonymise>[2]) => api.students.anonymise(schoolId, student.id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'students'] })
      toast.success('Record anonymised')
      setOpen(false)
    },
    onError: (error) => toast.error(describeError(error)),
  })

  const submit = () => {
    const parsed = AnonymiseRequest.safeParse({ expectedVersion: student.version, reason: reason.trim() })
    if (!parsed.success) {
      setError('Say why this record is being anonymised.')
      return
    }
    setError(null)
    anonymise.mutate(parsed.data)
  }

  return (
    <Panel title="Anonymise record" description="For a student who left long enough ago that the school no longer needs their personal details.">
      <p className="text-[13px] text-muted-foreground">
        The name, admission number, class history and admission dates stay, so the register is still complete.
        Date of birth, address, identifiers, health notes, documents and the guardians' contact details are cleared
        for good.
      </p>
      <Button className="mt-3" variant="destructive" size="sm" onClick={() => { setReason(''); setError(null); setOpen(true) }}>
        <ShieldOff />Anonymise record
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Anonymise this record?</AlertDialogTitle>
            <AlertDialogDescription>
              What stays: name, admission number, status, admission and leaving dates, and class history.
              What goes, permanently: date of birth, gender, category, address, Aadhaar and APAAR, health notes,
              documents, and the personal details of guardians linked to nobody else.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5 px-1">
            <Label>Reason</Label>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Retention period is over" />
            {error && <p className="text-[12px] text-destructive">{error}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={anonymise.isPending} onClick={submit}>
              {anonymise.isPending ? 'Anonymising…' : 'Anonymise record'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  )
}
