/**
 * One homework item: what was set, its files and, for staff, the check-off sheet; for a family,
 * their child's status. Edit and Remove are offered only where the item's `allowedActions` carry
 * `homework.set`, and the check-off sheet saves only where the server's window says so.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Download, FileText, NotebookText, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CheckOffSheet } from '@/components/homework/check-sheet'
import { HomeworkSheet, useHomeworkRefresh } from '@/components/homework/homework-sheet'
import { classLabel, GENERAL_LABEL, PupilStatusTag, saveFile, subjectLabel } from '@/components/homework/labels'
import { formatBytes, formatDateTime } from '@/components/messages/labels'
import { EmptyState, Facts, PageHeader, Panel } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { HomeworkRecord } from '@/lib/api/homework'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_app/homework/$homeworkId')({ component: Page })

function Page() {
  const { homeworkId } = Route.useParams()
  const { schoolId } = useSchoolContext()
  const [editing, setEditing] = useState(false)
  const [removing, setRemoving] = useState(false)
  const homeworkQuery = useQuery({ queryKey: qk.homework.detail(schoolId, homeworkId), queryFn: () => api.homework.get(schoolId, homeworkId) })
  const homework = homeworkQuery.data

  const download = useMutation({
    mutationFn: (attachmentId: string) => api.homework.downloadAttachment(schoolId, homeworkId, attachmentId),
    onSuccess: (file) => saveFile(file.blob, file.fileName),
    onError: (failure) => toast.error(describeError(failure)),
  })

  const crumbs = [{ label: 'Homework', to: '/homework', icon: <NotebookText /> }, { label: homework?.title ?? 'Homework' }]
  if (homeworkQuery.isError) {
    return <><PageHeader crumbs={crumbs} /><EmptyState icon={<NotebookText />} title="This homework is not available" description={describeError(homeworkQuery.error)} /></>
  }
  if (!homework) {
    return <><PageHeader crumbs={crumbs} /><div className="space-y-3 p-3 md:p-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div></>
  }

  const canSet = allows(homework.allowedActions, 'homework.set') && !homework.removedAt
  // Staff read the roster; a family reads only their own child, so they get no sheet at all.
  const staffView = homework.progress !== undefined || homework.checkWindow !== undefined
  const children = homework.children ?? (homework.child ? [homework.child] : [])

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        actions={canSet ? (
          <>
            <Button size="sm" variant="outline" onClick={() => setRemoving(true)}><Trash2 />Remove</Button>
            <Button size="sm" onClick={() => setEditing(true)}><Pencil />Edit</Button>
          </>
        ) : undefined}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <div className="mx-auto max-w-4xl space-y-4">
          <header className="flex flex-col gap-2">
            <h1 className="text-[18px] font-semibold leading-tight">{homework.title}</h1>
            <div className="flex flex-wrap items-center gap-2">
              <Tag>{classLabel(homework.grade, homework.section)}</Tag>
              {homework.subject ? <Tag color="blue">{homework.subject.name}</Tag> : <Tag>{GENERAL_LABEL}</Tag>}
              {homework.removedAt && <Tag color="red">Removed</Tag>}
              <span className="text-[13px] text-muted-foreground">Due {formatDate(homework.dueOn)}</span>
            </div>
          </header>

          {homework.removedAt && (
            <p className="rounded-lg border px-3 py-2 text-[13px] text-muted-foreground">
              Removed {formatDateTime(homework.removedAt)}{homework.removedBy ? ` by ${homework.removedBy}` : ''}. Families no longer see it, and it is left out of the figures.
            </p>
          )}

          {!staffView && children.length > 0 && (
            <Panel title={children.length === 1 ? 'Status' : 'Your children'}>
              <div className="flex flex-col divide-y">
                {children.map((child) => (
                  <div key={child.student.id} className="flex flex-wrap items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0 flex-1 truncate font-medium">{child.student.name}</span>
                    <PupilStatusTag status={child.status} />
                    {child.remark && <span className="w-full text-[13px] text-muted-foreground">Teacher's remark: {child.remark}</span>}
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel title="Instructions">
            {homework.instructions
              ? <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{homework.instructions}</p>
              : <p className="text-[13px] text-muted-foreground">No instructions. The title says it all.</p>}
            {homework.attachments.length > 0 && (
              <div className="mt-4 space-y-2 border-t pt-3">
                {homework.attachments.map((file) => (
                  <div key={file.id} className="flex h-10 items-center gap-2 rounded-lg border px-3 text-[13px]">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
                    <span className="text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                    <Button variant="ghost" size="sm" aria-label={`Download ${file.fileName}`} disabled={download.isPending} onClick={() => download.mutate(file.id)}><Download />Download</Button>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Details">
            <Facts
              items={[
                { label: 'Class', value: classLabel(homework.grade, homework.section) },
                { label: 'Subject', value: subjectLabel(homework.subject) },
                { label: 'Set on', value: formatDate(homework.setOn) },
                { label: 'Due on', value: formatDate(homework.dueOn) },
                ...(homework.setBy ? [{ label: 'Set by', value: homework.setBy }] : []),
                { label: 'Academic year', value: homework.academicYear.name },
                ...(homework.updatedBy ? [{ label: 'Last changed by', value: `${homework.updatedBy}, ${formatDateTime(homework.updatedAt)}` }] : []),
              ]}
            />
          </Panel>

          {staffView && !homework.removedAt && <CheckOffSheet homeworkId={homework.id} dueOn={homework.dueOn} />}
        </div>
      </div>
      {canSet && <HomeworkSheet open={editing} onOpenChange={setEditing} homework={homework} />}
      {canSet && <RemoveDialog homework={homework} open={removing} onOpenChange={setRemoving} />}
    </>
  )
}

/** Removing is for good. The reason, when given, goes to the audit note. */
function RemoveDialog({ homework, open, onOpenChange }: { homework: HomeworkRecord; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { schoolId } = useSchoolContext()
  const refresh = useHomeworkRefresh()
  const navigate = useNavigate()
  const [reason, setReason] = useState('')
  const remove = useMutation({
    mutationFn: () => api.homework.remove(schoolId, homework.id, { expectedVersion: homework.version, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    onSuccess: () => {
      refresh()
      toast.success('Homework removed')
      onOpenChange(false)
      void navigate({ to: '/homework' })
    },
    onError: (failure) => toast.error(describeError(failure)),
  })
  return (
    <AlertDialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) setReason('') }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this homework?</AlertDialogTitle>
          <AlertDialogDescription>
            Families stop seeing it and it is left out of the figures. The school keeps it and its check-offs on record. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Textarea aria-label="Reason (optional)" placeholder="Reason (optional)" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>Remove homework</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
