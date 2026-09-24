/** One message: the words and files, and for its sender or the office the delivery record. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import { EmailStatus, RecipientOutcome, type MessageCounts } from '@erp/contracts'
import { Ban, Download, FileText, Mail, Pencil, Trash2, Undo2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { audienceLine, EMAIL_LABEL, formatBytes, formatDateTime, KIND_COLOR, kindLabel, OUTCOME_LABEL, recipientRelation, STATUS_COLOR, STATUS_LABEL } from '@/components/messages/labels'
import { DataTable } from '@/components/shared/data-table'
import { useExportDownload } from '@/components/shared/export-download'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { MessageRecord, RecipientRow } from '@/lib/api/messages'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export const Route = createFileRoute('/_app/messages/$messageId/')({ component: Page })

/** Hands the browser the bytes it just fetched. */
function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

function Page() {
  const { messageId } = Route.useParams()
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const messageQuery = useQuery({ queryKey: qk.messages.detail(schoolId, messageId), queryFn: () => api.messages.get(schoolId, messageId) })
  const message = messageQuery.data

  // A recipient opening an unread message marks it read, once per visit.
  const markedRef = useRef<string | null>(null)
  const markRead = useMutation({
    mutationFn: (recipientId: string) => api.messages.markRead(schoolId, recipientId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: [schoolId, 'messages'] }),
  })
  const markReadMutate = markRead.mutate
  useEffect(() => {
    const receipt = message?.myReceipt
    if (!receipt || receipt.readAt || markedRef.current === receipt.recipientId) return
    markedRef.current = receipt.recipientId
    markReadMutate(receipt.recipientId)
  }, [message, markReadMutate])

  const crumbs = [{ label: 'Messages', to: '/messages', icon: <Mail /> }, { label: message?.title || 'Message' }]
  if (messageQuery.isError) {
    return <><PageHeader crumbs={crumbs} /><EmptyState icon={<Mail />} title="This message is not available" description={describeError(messageQuery.error)} /></>
  }
  if (!message) {
    return <><PageHeader crumbs={crumbs} /><div className="space-y-3 p-3 md:p-4"><Skeleton className="h-24 w-full" /><Skeleton className="h-64 w-full" /></div></>
  }
  return <Detail message={message} />
}

function Detail({ message }: { message: MessageRecord }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState<'delete' | 'withdraw' | null>(null)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const exportFile = useExportDownload({ className: 'px-4 pt-2' })

  // The school's own messages are changed under manage; a person's under send.
  const actionKey = message.kind === 'notice' ? 'communication.send' : 'communication.manage'
  const canAct = allows(message.allowedActions, actionKey)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [schoolId, 'messages'] })
  const onError = (failure: unknown) => toast.error(describeError(failure))

  const remove = useMutation({
    mutationFn: () => api.messages.delete(schoolId, message.id, message.version),
    onSuccess: () => {
      void invalidate()
      toast.success('Draft deleted')
      void navigate({ to: '/messages', search: { tab: 'sent' } })
    },
    onError,
  })
  const unschedule = useMutation({
    mutationFn: () => api.messages.unschedule(schoolId, message.id, message.version),
    onSuccess: () => { void invalidate(); toast.success('Schedule cancelled. The message is a draft again.') },
    onError,
  })
  const withdraw = useMutation({
    mutationFn: (text: string) => api.messages.withdraw(schoolId, message.id, { expectedVersion: message.version, reason: text }),
    onSuccess: () => { void invalidate(); setConfirm(null); setReason(''); toast.success('Message withdrawn') },
    onError,
  })
  const startExport = useMutation({
    mutationFn: () => api.messages.export(schoolId, message.id),
    onSuccess: (job) => exportFile.start(job),
    onError,
  })
  const download = useMutation({
    mutationFn: (attachmentId: string) => api.messages.downloadAttachment(schoolId, message.id, attachmentId),
    onSuccess: (file) => saveFile(file.blob, file.fileName),
    onError,
  })

  const actions = canAct ? (
    <>
      {(message.status === 'draft' || message.status === 'scheduled') && (
        <Button variant="outline" size="sm" asChild><Link to="/messages/$messageId/edit" params={{ messageId: message.id }}><Pencil />Edit</Link></Button>
      )}
      {message.status === 'draft' && <Button variant="outline" size="sm" onClick={() => setConfirm('delete')}><Trash2 />Delete</Button>}
      {message.status === 'scheduled' && <Button variant="outline" size="sm" disabled={unschedule.isPending} onClick={() => unschedule.mutate()}><Ban />Cancel schedule</Button>}
      {message.status === 'sent' && <Button variant="outline" size="sm" onClick={() => setConfirm('withdraw')}><Undo2 />Withdraw message</Button>}
    </>
  ) : undefined

  const when = message.status === 'scheduled' ? `Goes ${formatDateTime(message.sendAt)}` : message.sentAt ? `Sent ${formatDateTime(message.sentAt)}` : `Written ${formatDateTime(message.createdAt)}`

  return (
    <>
      <PageHeader crumbs={[{ label: 'Messages', to: '/messages', icon: <Mail /> }, { label: message.title || 'Message' }]} actions={actions} mobileActions={actions} />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <div className="space-y-4 p-3 md:p-4">
          <header className="space-y-1.5">
            <h1 className="text-[18px] font-semibold">{message.title || 'Words removed'}</h1>
            <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
              <Tag color={KIND_COLOR[message.kind]}>{kindLabel(message.kind)}</Tag>
              <Tag color={STATUS_COLOR[message.status]} dot>{STATUS_LABEL[message.status]}</Tag>
              <span>From {message.sender.name}</span>
              <span>·</span>
              <span>To {audienceLine(message.audience)}</span>
              <span>·</span>
              <span>{when}</span>
            </div>
          </header>

          {message.status === 'withdrawn' && (
            <Alert><Undo2 /><AlertTitle>This message was withdrawn</AlertTitle><AlertDescription>It no longer shows in anybody's inbox{message.withdrawnAt ? ` since ${formatDateTime(message.withdrawnAt)}` : ''}. Emails already sent cannot be taken back.</AlertDescription></Alert>
          )}
          {message.status === 'cancelled' && (
            <Alert><Ban /><AlertTitle>This message was not sent</AlertTitle><AlertDescription>When its time came, its author could no longer send to that audience.</AlertDescription></Alert>
          )}
          {message.redacted && (
            <Alert><FileText /><AlertTitle>The words of this message were removed</AlertTitle><AlertDescription>They were removed when a pupil's records were erased.</AlertDescription></Alert>
          )}

          <Panel>
            {message.body ? <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed">{message.body}</p> : <p className="text-[13px] text-muted-foreground">No words to show.</p>}
            {message.attachments.length > 0 && (
              <div className="mt-4 space-y-2 border-t pt-3">
                {message.attachments.map((file) => (
                  <div key={file.id} className="flex h-10 items-center gap-2 rounded-lg border px-3 text-[13px]">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
                    <span className="text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                    <Button variant="ghost" size="sm" disabled={download.isPending} onClick={() => download.mutate(file.id)}><Download />Download</Button>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {message.counts && message.status !== 'draft' && message.status !== 'scheduled' && (
            <>
              <CountStrip counts={message.counts} />
              <Recipients
                message={message}
                exportButton={allows(message.allowedActions, 'communication.export') ? (
                  <Button variant="outline" size="sm" disabled={startExport.isPending} onClick={() => startExport.mutate()}><Download />Export delivery list</Button>
                ) : undefined}
                exportStatus={exportFile.status}
              />
            </>
          )}
        </div>
      </div>

      <AlertDialog open={confirm === 'delete'} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this draft?</AlertDialogTitle>
            <AlertDialogDescription>The draft and its files are removed. Nobody has seen it.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction disabled={remove.isPending} onClick={(event) => { event.preventDefault(); remove.mutate() }}>Delete draft</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === 'withdraw'} onOpenChange={(open) => { if (!open) { setConfirm(null); setReasonError(null) } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this message?</AlertDialogTitle>
            <AlertDialogDescription>It disappears from every inbox. Emails already sent cannot be taken back.</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="withdraw-reason" className="text-[12.5px] text-muted-foreground">Why is it being withdrawn?</Label>
            <Textarea id="withdraw-reason" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-invalid={!!reasonError} />
            {reasonError && <p role="alert" className="text-[12.5px] text-tag-red">{reasonError}</p>}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              disabled={withdraw.isPending}
              onClick={(event) => {
                event.preventDefault()
                const text = reason.trim()
                if (!text) { setReasonError('Give a reason.'); return }
                setReasonError(null)
                withdraw.mutate(text)
              }}
            >
              Withdraw message
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function CountStrip({ counts }: { counts: MessageCounts }) {
  const items: Array<[string, number]> = [
    ['Delivered', counts.delivered],
    ['Pupils', counts.pupils],
    ['In the app', counts.inApp],
    ['Read', counts.read],
    ['Emails sent', counts.emailSent],
    ['Emails waiting', counts.emailPending],
    ['Emails failed', counts.emailFailed],
    ['Not agreed', counts.noConsent],
    ['No contact', counts.noContact],
  ]
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-4 lg:grid-cols-9">
      {items.map(([label, value]) => (
        <div key={label} className="bg-card px-3 py-2.5">
          <p className="text-[12px] text-muted-foreground">{label}</p>
          <p className="text-[16px] font-semibold tabular-nums">{value}</p>
        </div>
      ))}
    </div>
  )
}

const PAGE_SIZE = 50
const OUTCOME_OPTIONS = RecipientOutcome.options.map((value) => ({ value, label: OUTCOME_LABEL[value] }))
const READ_OPTIONS = [{ value: 'read' as const, label: 'Read' }, { value: 'unread' as const, label: 'Not read' }]
const EMAIL_OPTIONS = EmailStatus.options.map((value) => ({ value, label: EMAIL_LABEL[value] }))

function Recipients({ message, exportButton, exportStatus }: { message: MessageRecord; exportButton?: ReactNode; exportStatus: ReactNode }) {
  const { schoolId } = useSchoolContext()
  const [outcome, setOutcome] = useState<RecipientOutcome | undefined>()
  const [read, setRead] = useState<'read' | 'unread' | undefined>()
  const [emailStatus, setEmailStatus] = useState<EmailStatus | undefined>()
  const [page, setPage] = useState(1)
  const params = { outcome, read, emailStatus, page, pageSize: PAGE_SIZE }
  const recipientsQuery = useQuery({
    queryKey: qk.messages.recipients(schoolId, message.id, params),
    queryFn: () => api.messages.recipients(schoolId, message.id, params),
  })
  const data = recipientsQuery.data

  const columns = useMemo<ColumnDef<RecipientRow>[]>(() => [
    {
      id: 'name',
      header: 'Name',
      size: 220,
      cell: ({ row }) => (
        <span className="min-w-0">
          <span className="block truncate">{row.original.name}</span>
          {recipientRelation(row.original) && <span className="block truncate text-[12px] text-muted-foreground">{recipientRelation(row.original)}</span>}
        </span>
      ),
    },
    { id: 'pupil', header: 'Pupil', size: 200, cell: ({ row }) => <span className="truncate">{row.original.pupil && row.original.kind !== 'student' ? `${row.original.pupil.name}${row.original.pupil.section ? `, ${row.original.pupil.section}` : ''}` : ''}</span> },
    { id: 'outcome', header: 'Outcome', size: 130, cell: ({ row }) => <Tag color={row.original.outcome === 'delivered' ? 'green' : 'yellow'}>{OUTCOME_LABEL[row.original.outcome]}</Tag> },
    { id: 'app', header: 'In the app', size: 150, cell: ({ row }) => <span className="text-muted-foreground">{row.original.inApp ? (row.original.readAt ? `Read ${formatDateTime(row.original.readAt)}` : 'Not read yet') : 'No'}</span> },
    { id: 'email', header: 'Email', size: 200, cell: ({ row }) => <span className="truncate text-muted-foreground">{EMAIL_LABEL[row.original.emailStatus]}{row.original.emailMasked ? ` · ${row.original.emailMasked}` : ''}</span> },
  ], [])

  const filter = <T,>(set: (v: T) => void) => (value: T) => { set(value); setPage(1) }

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <Toolbar right={exportButton}>
        <FilterChip label="Outcome" value={outcome} options={OUTCOME_OPTIONS} onChange={filter(setOutcome)} />
        <FilterChip label="Read" value={read} options={READ_OPTIONS} onChange={filter(setRead)} />
        <FilterChip label="Email" value={emailStatus} options={EMAIL_OPTIONS} onChange={filter(setEmailStatus)} />
      </Toolbar>
      {exportStatus}
      {recipientsQuery.isError ? (
        <EmptyState icon={<Mail />} title="The delivery list is not available" description={describeError(recipientsQuery.error)} />
      ) : (
        <DataTable
          columns={columns}
          data={data?.items ?? []}
          isLoading={recipientsQuery.isLoading}
          getRowId={(row) => row.id}
          dense
          mobileRow={(row) => ({ title: row.name, subtitle: row.pupil?.name, trailing: <Tag color={row.outcome === 'delivered' ? 'green' : 'yellow'}>{OUTCOME_LABEL[row.outcome]}</Tag> })}
          emptyState={<EmptyState icon={<Mail />} title="Nobody here" description="Nobody matches these filters." />}
          footer={data ? `${data.total} ${data.total === 1 ? 'person' : 'people'}` : undefined}
          pagination={data && data.total > PAGE_SIZE ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage } : undefined}
        />
      )}
    </section>
  )
}
