/**
 * The whole-page form for writing a message: who it is for, the words, the files, and when it
 * goes. The new-message screen and the edit screen both use it; the edit screen hands it the
 * saved draft or scheduled message.
 *
 * Nothing here decides who may send to whom. The audience choices come from the server, the
 * live count under them comes from the server, and the server decides everything again on save.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  MESSAGE_ATTACHMENTS_MAX,
  MESSAGE_BODY_MAX,
  MESSAGE_SCHEDULE_MIN_MINUTES,
  MESSAGE_TITLE_MAX,
  unknownPlaceholders,
} from '@erp/contracts'
import { FileText, Paperclip, Search, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  attachmentProblem,
  audienceInputOf,
  AUDIENCE_KIND_LABEL,
  formatBytes,
  isoToLocalInput,
  localInputToIso,
  noticePlaceholders,
  previewSentence,
  type AudienceChoice,
} from '@/components/messages/labels'
import { PlaceholderList } from '@/components/messages/placeholder-list'
import { Panel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { MessageRecord } from '@/lib/api/messages'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn } from '@/lib/utils'

const NO_TEMPLATE = '__none__'

function choiceOf(message: MessageRecord | undefined): AudienceChoice {
  const audience = message?.audience
  const kind = audience && audience.kind !== 'staff_member' ? audience.kind : null
  return { kind, gradeId: audience?.gradeId ?? '', sectionId: audience?.sectionId ?? '', studentId: audience?.studentId ?? '' }
}

interface Errors {
  audience?: string
  title?: string
  body?: string
  when?: string
}

export function MessageForm({ message }: { message?: MessageRecord }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  // The saved message this form is writing to, once there is one. Adding a file saves a new
  // draft first, so this can change without leaving the page.
  const [saved, setSaved] = useState<MessageRecord | undefined>(message)
  const [choice, setChoice] = useState<AudienceChoice>(() => choiceOf(message))
  const [pupilName, setPupilName] = useState(message?.audience.kind === 'pupil' ? message.audience.label : '')
  const [title, setTitle] = useState(message?.title ?? '')
  const [body, setBody] = useState(message?.body ?? '')
  const [templateId, setTemplateId] = useState<string | undefined>(message?.templateId)
  const [mode, setMode] = useState<'now' | 'schedule'>(message?.status === 'scheduled' ? 'schedule' : 'now')
  const [when, setWhen] = useState(message?.sendAt ? isoToLocalInput(message.sendAt) : '')
  const [errors, setErrors] = useState<Errors>({})
  const fileInput = useRef<HTMLInputElement>(null)

  const optionsQuery = useQuery({ queryKey: qk.messages.audiences(schoolId), queryFn: () => api.messages.audiences(schoolId) })
  const options = optionsQuery.data
  const templatesQuery = useQuery({
    queryKey: qk.messages.templates(schoolId, { kind: 'notice' }),
    queryFn: () => api.messages.templates(schoolId, { kind: 'notice' }),
  })

  const audience = audienceInputOf(choice)
  const previewQuery = useQuery({
    queryKey: qk.messages.audiencePreview(schoolId, audience ?? undefined),
    queryFn: () => api.messages.audiencePreview(schoolId, audience!),
    enabled: audience !== null,
  })

  const allowedPlaceholders = noticePlaceholders(choice.kind)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: [schoolId, 'messages'] })

  /** Every problem this screen can see before asking the server. */
  function validate(forSend: boolean): Errors {
    const next: Errors = {}
    if (!audience) next.audience = 'Choose who the message is for.'
    const cleanTitle = title.trim()
    if (!cleanTitle) next.title = 'Give the message a title.'
    else if (cleanTitle.length > MESSAGE_TITLE_MAX) next.title = `A title can be at most ${MESSAGE_TITLE_MAX} characters.`
    const cleanBody = body.trim()
    if (!cleanBody) next.body = 'Write the message.'
    else if (cleanBody.length > MESSAGE_BODY_MAX) next.body = `A message can be at most ${MESSAGE_BODY_MAX} characters.`
    if (choice.kind) {
      const unknownTitle = unknownPlaceholders(title, 'notice', choice.kind)
      const unknownBody = unknownPlaceholders(body, 'notice', choice.kind)
      if (unknownTitle.length > 0) next.title = `This message cannot use ${unknownTitle.map((p) => `{${p}}`).join(', ')}.`
      if (unknownBody.length > 0) next.body = `This message cannot use ${unknownBody.map((p) => `{${p}}`).join(', ')}.`
    }
    if (forSend && mode === 'schedule') {
      const iso = localInputToIso(when)
      if (!iso) next.when = 'Choose the date and time it should go.'
      else if (new Date(iso).getTime() < Date.now() + MESSAGE_SCHEDULE_MIN_MINUTES * 60_000) next.when = `Choose a time at least ${MESSAGE_SCHEDULE_MIN_MINUTES} minutes from now.`
    }
    return next
  }

  /** Save the words: a new draft the first time, a change after that. */
  async function persist(): Promise<MessageRecord> {
    const input = audience!
    if (!saved) {
      return api.messages.create(schoolId, { audience: input, title: title.trim(), body: body.trim(), ...(templateId ? { templateId } : {}) })
    }
    return api.messages.update(schoolId, saved.id, {
      expectedVersion: saved.version,
      audience: input,
      title: title.trim(),
      body: body.trim(),
      templateId: templateId ?? null,
    })
  }

  const saveDraft = useMutation({
    mutationFn: persist,
    onSuccess: (record) => {
      setSaved(record)
      void invalidate()
      toast.success('Draft saved')
      if (!message) void navigate({ to: '/messages/$messageId/edit', params: { messageId: record.id }, replace: true })
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const send = useMutation({
    mutationFn: async () => {
      const record = await persist()
      setSaved(record)
      const sendAt = mode === 'schedule' ? localInputToIso(when) ?? undefined : undefined
      return api.messages.send(schoolId, record.id, { expectedVersion: record.version, ...(sendAt ? { sendAt } : {}) })
    },
    onSuccess: (record) => {
      void invalidate()
      toast.success(record.status === 'scheduled' ? 'Message scheduled' : 'Message sent')
      void navigate({ to: '/messages/$messageId', params: { messageId: record.id } })
    },
    onError: (failure) => {
      void invalidate()
      toast.error(describeError(failure))
    },
  })

  const addFile = useMutation({
    mutationFn: async (file: File) => {
      // A new message has nowhere to put a file yet, so it is saved as a draft first.
      const record = saved ?? (await persist())
      setSaved(record)
      return api.messages.addAttachment(schoolId, record.id, file, record.version)
    },
    onSuccess: (record) => {
      setSaved(record)
      void invalidate()
      toast.success('File added')
      if (!message) void navigate({ to: '/messages/$messageId/edit', params: { messageId: record.id }, replace: true })
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const removeFile = useMutation({
    mutationFn: (attachmentId: string) => api.messages.removeAttachment(schoolId, saved!.id, attachmentId, saved!.version),
    onSuccess: (record) => {
      setSaved(record)
      void invalidate()
      toast.success('File removed')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const busy = saveDraft.isPending || send.isPending || addFile.isPending || removeFile.isPending

  function onPickFile(file: File | undefined) {
    if (!file) return
    const problem = attachmentProblem(file, saved?.attachments.length ?? 0)
    if (problem) {
      toast.error(problem)
      return
    }
    // A new draft needs a finished audience and words before it can be saved.
    if (!saved) {
      const found = validate(false)
      setErrors(found)
      if (Object.keys(found).length > 0) return
    }
    addFile.mutate(file)
  }

  function onSave() {
    const found = validate(false)
    setErrors(found)
    if (Object.keys(found).length === 0) saveDraft.mutate()
  }

  function onSend() {
    const found = validate(true)
    setErrors(found)
    if (Object.keys(found).length === 0) send.mutate()
  }

  function applyTemplate(id: string) {
    if (id === NO_TEMPLATE) {
      setTemplateId(undefined)
      return
    }
    const template = templatesQuery.data?.items.find((t) => t.id === id)
    if (!template) return
    setTemplateId(template.id)
    setTitle(template.title)
    setBody(template.body)
  }

  if (optionsQuery.isLoading) {
    return <div className="space-y-3 p-3 md:p-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div>
  }
  if (optionsQuery.isError || !options) {
    return <p className="p-4 text-[13px] text-muted-foreground">{describeError(optionsQuery.error)}</p>
  }

  const kinds = (['school', 'staff', 'grade', 'section', 'pupil'] as const).filter((kind) =>
    kind === 'school' ? options.school
      : kind === 'staff' ? options.staff
        : kind === 'grade' ? options.grades.length > 0
          : kind === 'section' ? options.sections.length > 0
            : options.pupils,
  )
  const attachments = saved?.attachments ?? []

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <Panel title="Who it is for">
          {kinds.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">There is nobody you can send a message to right now.</p>
          ) : (
            <div className="space-y-3">
              <RadioGroup
                value={choice.kind ?? ''}
                onValueChange={(value) => setChoice({ ...choice, kind: value as AudienceChoice['kind'] })}
                className="gap-2.5"
              >
                {kinds.map((kind) => (
                  <Label key={kind} className="flex items-center gap-2 text-[13.5px] font-normal"><RadioGroupItem value={kind} />{AUDIENCE_KIND_LABEL[kind]}</Label>
                ))}
              </RadioGroup>

              {choice.kind === 'grade' && (
                <Select value={choice.gradeId || undefined} onValueChange={(gradeId) => setChoice({ ...choice, gradeId })}>
                  <SelectTrigger aria-label="Class" className="w-full sm:w-72"><SelectValue placeholder="Choose a class" /></SelectTrigger>
                  <SelectContent>{options.grades.map((grade) => <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {choice.kind === 'section' && (
                <Select value={choice.sectionId || undefined} onValueChange={(sectionId) => setChoice({ ...choice, sectionId })}>
                  <SelectTrigger aria-label="Section" className="w-full sm:w-72"><SelectValue placeholder="Choose a section" /></SelectTrigger>
                  <SelectContent>{options.sections.map((section) => <SelectItem key={section.id} value={section.id}>{section.grade.name} {section.name}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {choice.kind === 'pupil' && (
                <PupilPicker
                  selectedName={choice.studentId ? pupilName : ''}
                  sectionIds={options.school ? null : options.sections.map((s) => s.id)}
                  canSearch={hasPermission('students.read_basic')}
                  onPick={(id, name) => { setChoice({ ...choice, studentId: id }); setPupilName(name) }}
                  onClear={() => { setChoice({ ...choice, studentId: '' }); setPupilName('') }}
                />
              )}
              {errors.audience && <p role="alert" className="text-[12.5px] text-tag-red">{errors.audience}</p>}
              {audience && (
                <p className="rounded-lg border bg-muted/40 px-3 py-2 text-[13px]" aria-live="polite">
                  {previewQuery.isLoading ? 'Counting who it will reach…'
                    : previewQuery.isError ? describeError(previewQuery.error)
                      : previewQuery.data ? previewSentence(previewQuery.data) : ''}
                </p>
              )}
            </div>
          )}
        </Panel>

        <Panel title="The message">
          <div className="space-y-3">
            {(templatesQuery.data?.items.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="message-template" className="text-[12.5px] text-muted-foreground">Start from a template</Label>
                <Select value={templateId ?? NO_TEMPLATE} onValueChange={applyTemplate}>
                  <SelectTrigger id="message-template" className="w-full sm:w-72"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE}>No template</SelectItem>
                    {templatesQuery.data!.items.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="message-title" className="text-[12.5px] text-muted-foreground">Title</Label>
              <Input id="message-title" value={title} maxLength={MESSAGE_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} aria-invalid={!!errors.title} />
              {errors.title && <p role="alert" className="text-[12.5px] text-tag-red">{errors.title}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="message-body" className="text-[12.5px] text-muted-foreground">Message</Label>
              <Textarea id="message-body" value={body} rows={10} maxLength={MESSAGE_BODY_MAX} onChange={(e) => setBody(e.target.value)} aria-invalid={!!errors.body} />
              {errors.body && <p role="alert" className="text-[12.5px] text-tag-red">{errors.body}</p>}
<p className="text-[12px] text-muted-foreground">
                You can use these placeholders.{choice.kind !== 'pupil' && ' A message to one pupil\'s family may also name the pupil.'}
              </p>
              <PlaceholderList names={allowedPlaceholders} />
            </div>
          </div>
        </Panel>

        <Panel title="Files" description={`PDF, JPEG or PNG, up to 2 MB each, at most ${MESSAGE_ATTACHMENTS_MAX}.`}>
          <div className="space-y-2">
            {attachments.map((file) => (
              <div key={file.id} className="flex h-10 items-center gap-2 rounded-lg border px-3 text-[13px]">
                <FileText className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
                <span className="text-muted-foreground">{formatBytes(file.sizeBytes)}</span>
                <Button variant="ghost" size="icon" aria-label={`Remove ${file.fileName}`} disabled={busy} onClick={() => removeFile.mutate(file.id)}><Trash2 /></Button>
              </div>
            ))}
            {attachments.length < MESSAGE_ATTACHMENTS_MAX && (
              <>
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  className="hidden"
                  onChange={(e) => { onPickFile(e.target.files?.[0]); e.target.value = '' }}
                />
                <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip />Add file</Button>
              </>
            )}
          </div>
        </Panel>

        <Panel title="When it goes">
          <div className="space-y-3">
            <RadioGroup value={mode} onValueChange={(value) => setMode(value as 'now' | 'schedule')} className="gap-2.5">
              <Label className="flex items-center gap-2 text-[13.5px] font-normal"><RadioGroupItem value="now" />Send now</Label>
              <Label className="flex items-center gap-2 text-[13.5px] font-normal"><RadioGroupItem value="schedule" />Schedule</Label>
            </RadioGroup>
            {mode === 'schedule' && (
              <div className="space-y-1.5">
                <Input type="datetime-local" aria-label="Date and time" className="w-full sm:w-72" value={when} onChange={(e) => setWhen(e.target.value)} aria-invalid={!!errors.when} />
                <p className="text-[12px] text-muted-foreground">In the school's time, at least {MESSAGE_SCHEDULE_MIN_MINUTES} minutes from now and at most 60 days ahead.</p>
                {errors.when && <p role="alert" className="text-[12.5px] text-tag-red">{errors.when}</p>}
              </div>
            )}
          </div>
        </Panel>

        <div className="flex flex-wrap justify-end gap-2 pb-6">
          <Button variant="outline" disabled={busy} onClick={onSave}>Save draft</Button>
          <Button disabled={busy} onClick={onSend}>{mode === 'schedule' ? 'Schedule message' : 'Send message'}</Button>
        </div>
      </div>
    </div>
  )
}

/**
 * Find one pupil by name or admission number. A teacher's search is narrowed to the sections
 * they may send to; the server decides the pupil again when the message is saved.
 */
function PupilPicker({ selectedName, sectionIds, canSearch, onPick, onClear }: {
  selectedName: string
  sectionIds: string[] | null
  canSearch: boolean
  onPick: (id: string, name: string) => void
  onClear: () => void
}) {
  const { schoolId } = useSchoolContext()
  const [text, setText] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 250)
    return () => clearTimeout(timer)
  }, [text])
  const searchQuery = useQuery({
    queryKey: qk.studentSearch(schoolId, q),
    queryFn: () => api.search.run(schoolId, q),
    enabled: canSearch && q.length >= 2,
  })
  const results = useMemo(() => {
    const students = searchQuery.data?.students ?? []
    return students
      .filter((s) => s.status === 'active' && (sectionIds === null || (s.enrollment && sectionIds.includes(s.enrollment.section.id))))
      .slice(0, 8)
  }, [searchQuery.data, sectionIds])

  if (selectedName) {
    return (
      <div className="flex h-9 w-full items-center gap-2 rounded-lg border px-3 text-[13.5px] sm:w-72">
        <span className="min-w-0 flex-1 truncate">{selectedName}</span>
        <button type="button" aria-label="Choose another pupil" onClick={onClear} className="rounded p-0.5 text-muted-foreground hover:bg-muted"><X className="size-3.5" /></button>
      </div>
    )
  }
  if (!canSearch) return <p className="text-[13px] text-muted-foreground">You cannot look up pupils.</p>
  return (
    <div className="w-full space-y-1 sm:w-96">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search pupils by name or admission number" aria-label="Search pupils" className="pl-8" maxLength={100} />
      </div>
      {q.length >= 2 && (
        <div className="rounded-lg border bg-card">
          {searchQuery.isLoading ? <p className="px-3 py-2 text-[13px] text-muted-foreground">Searching…</p>
            : results.length === 0 ? <p className="px-3 py-2 text-[13px] text-muted-foreground">No pupil found.</p>
              : results.map((s) => {
                const name = [s.firstName, s.lastName].filter(Boolean).join(' ')
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => { onPick(s.id, name); setText('') }}
                    className={cn('flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13.5px] hover:bg-accent')}
                  >
                    <span className="truncate">{name}</span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">{s.enrollment ? `${s.enrollment.grade.name} ${s.enrollment.section.name}` : s.admissionNumber}</span>
                  </button>
                )
              })}
        </div>
      )}
    </div>
  )
}
