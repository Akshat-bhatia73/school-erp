/**
 * Setting homework and editing it, in one side sheet.
 *
 * Setting names the class and the subject (or general homework, which only a class teacher or the
 * office sets); editing changes the words, the due date and the files, never the class or the
 * subject. The form checks itself against the same contract the server applies, plus the due date
 * rule, so a mistake shows inline before anything is sent. The server still decides whether this
 * person may set homework for that class and subject.
 *
 * Files: when setting, the picked files wait in the sheet and go up one by one once the item
 * exists. When editing, a file is added or taken off straight away, because each one changes the
 * item's version.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Paperclip, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  HOMEWORK_ATTACHMENTS_MAX,
  HOMEWORK_DUE_MAX_DAYS,
  HOMEWORK_INSTRUCTIONS_MAX,
  HOMEWORK_TITLE_MAX,
  HomeworkCreateRequest,
  HomeworkUpdateRequest,
} from '@erp/contracts'
import { todayIso } from '@/components/attendance/month-chip'
import { formatBytes } from '@/components/messages/labels'
import { Field, FORM_ERROR, validate, type FieldErrors, type FieldLabels } from '@/components/setup/field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { HomeworkRecord } from '@/lib/api/homework'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { addDays, classLabel, fileProblem, GENERAL_LABEL, subjectLabel } from './labels'

/** The value of the subject choice that means general homework. */
const GENERAL = 'general'

const LABELS: FieldLabels = {
  sectionId: { label: 'class', kind: 'select' },
  subjectId: { label: 'subject', kind: 'select' },
  title: 'title',
  instructions: 'instructions',
  dueOn: { label: 'due date', kind: 'date' },
}

/** Every write to homework changes the list, the detail, the sheet and the dashboard cards. */
export function useHomeworkRefresh() {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'homework'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
  }
}

/** The classes of the current year this person can see, labelled "Class 6 A", in the school's order. */
/**
 * The classes of one academic year, in class order. Defaults to the current
 * year, which is the only year homework can be set in; a list filtered to a
 * past year passes that year so its Class chip offers that year's sections.
 */
export function useClassOptions(enabled: boolean, yearId?: string) {
  const { schoolId, hasPermission } = useSchoolContext()
  const { currentYearId } = useAcademicYear()
  const academicYearId = yearId ?? currentYearId ?? undefined
  const sectionParams = { academicYearId }
  const sections = useQuery({
    queryKey: qk.sections(schoolId, sectionParams),
    queryFn: () => api.setup.sections(schoolId, sectionParams),
    enabled: enabled && academicYearId !== undefined && hasPermission('sections.read'),
  })
  const grades = useQuery({
    queryKey: qk.grades(schoolId),
    queryFn: () => api.setup.grades(schoolId),
    enabled: enabled && hasPermission('grades.read'),
  })
  const options = useMemo(() => {
    const gradeList = grades.data ?? []
    const order = new Map(gradeList.map((grade, index) => [grade.id, index]))
    return (sections.data ?? [])
      .map((section) => {
        const grade = gradeList.find((g) => g.id === section.gradeId)
        return { value: section.id, label: classLabel(grade, section), gradeId: section.gradeId, academicYearId: section.academicYearId, rank: order.get(section.gradeId) ?? 999 }
      })
      .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'en-IN', { numeric: true }))
  }, [sections.data, grades.data])
  return { options, isLoading: sections.isLoading || grades.isLoading }
}

export function HomeworkSheet({ open, onOpenChange, homework, onCreated }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing. */
  homework?: HomeworkRecord
  /** Called with the new item once it is set (and its files are up). */
  onCreated?: (homeworkId: string) => void
}) {
  const { schoolId, hasPermission } = useSchoolContext()
  const refresh = useHomeworkRefresh()
  const editing = homework !== undefined
  const classes = useClassOptions(open && !editing)

  const [sectionId, setSectionId] = useState('')
  const [subjectId, setSubjectId] = useState('')
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [pending, setPending] = useState<File[]>([])
  const [errors, setErrors] = useState<FieldErrors>({})
  const fileInput = useRef<HTMLInputElement>(null)

  // Opening the sheet starts from the item, or from a fresh form.
  useEffect(() => {
    if (!open) return
    setSectionId('')
    setSubjectId('')
    setTitle(homework?.title ?? '')
    setInstructions(homework?.instructions ?? '')
    setDueOn(homework?.dueOn ?? addDays(todayIso(), 1))
    setPending([])
    setErrors({})
    // Only a new opening resets the form; a new version of the item after a file change does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, homework?.id])

  // One class: nothing to choose.
  const onlyClass = classes.options.length === 1 ? classes.options[0] : undefined
  const chosenSection = onlyClass?.value ?? sectionId
  const section = classes.options.find((option) => option.value === chosenSection)

  const subjectParams = { academicYearId: section?.academicYearId ?? '', gradeId: section?.gradeId }
  const subjects = useQuery({
    queryKey: qk.gradeSubjects(schoolId, subjectParams),
    queryFn: () => api.setup.gradeSubjects(schoolId, subjectParams),
    enabled: open && !editing && section !== undefined && hasPermission('subjects.read'),
  })
  const subjectOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const row of subjects.data ?? []) if (row.gradeId === section?.gradeId) seen.set(row.subject.id, row.subject.name)
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))
  }, [subjects.data, section?.gradeId])

  const create = useMutation({
    mutationFn: async () => {
      let record = await api.homework.create(schoolId, {
        sectionId: chosenSection,
        subjectId: subjectId === GENERAL ? null : subjectId,
        title: title.trim(),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        dueOn,
      })
      const failed: string[] = []
      for (const file of pending) {
        try {
          record = await api.homework.addAttachment(schoolId, record.id, file, record.version)
        } catch {
          failed.push(file.name)
        }
      }
      return { record, failed }
    },
    onSuccess: ({ record, failed }) => {
      refresh()
      if (failed.length > 0) toast.error(`Homework set, but ${failed.join(', ')} could not be attached. Add it from the homework page.`)
      else toast.success('Homework set')
      onOpenChange(false)
      onCreated?.(record.id)
    },
    onError: (failure) => {
      const message = describeError(failure)
      setErrors({ [FORM_ERROR]: message })
      toast.error(message)
    },
  })

  const update = useMutation({
    mutationFn: (body: { title?: string; instructions?: string; dueOn?: string }) => api.homework.update(schoolId, homework!.id, { expectedVersion: homework!.version, ...body }),
    onSuccess: () => {
      refresh()
      toast.success('Homework saved')
      onOpenChange(false)
    },
    onError: (failure) => {
      const message = describeError(failure)
      setErrors({ [FORM_ERROR]: message })
      toast.error(message)
    },
  })

  const addFile = useMutation({
    mutationFn: (file: File) => api.homework.addAttachment(schoolId, homework!.id, file, homework!.version),
    onSuccess: () => { refresh(); toast.success('File added') },
    onError: (failure) => toast.error(describeError(failure)),
  })
  const removeFile = useMutation({
    mutationFn: (attachmentId: string) => api.homework.removeAttachment(schoolId, homework!.id, attachmentId, homework!.version),
    onSuccess: () => { refresh(); toast.success('File removed') },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const attachedCount = editing ? homework.attachments.length : pending.length
  const onPickFile = (file: File | undefined) => {
    if (!file) return
    const problem = fileProblem(file, attachedCount)
    if (problem) { toast.error(problem); return }
    if (editing) addFile.mutate(file)
    else setPending([...pending, file])
  }

  /** The due date rule the server applies, counted from today (the server uses the school's today). */
  const dueProblem = (value: string, setOn: string): string | null => {
    if (!value) return null
    if (value < setOn || value > addDays(setOn, HOMEWORK_DUE_MAX_DAYS)) {
      return `Choose a due date from ${setOn === todayIso() ? 'today' : 'the day it was set'} to ${HOMEWORK_DUE_MAX_DAYS} days after.`
    }
    return null
  }

  const submit = () => {
    const found: FieldErrors = {}
    if (editing) {
      const body = {
        ...(title.trim() !== homework.title ? { title: title.trim() } : {}),
        ...(instructions.trim() !== homework.instructions ? { instructions: instructions.trim() } : {}),
        ...(dueOn !== homework.dueOn ? { dueOn } : {}),
      }
      if (Object.keys(body).length === 0) { onOpenChange(false); return }
      const checked = validate(HomeworkUpdateRequest, { expectedVersion: homework.version, ...body }, LABELS)
      if (!checked.ok) Object.assign(found, checked.errors)
      const due = dueProblem(dueOn, homework.setOn)
      if (due && !found.dueOn) found.dueOn = due
      if (Object.keys(found).length > 0) { setErrors(found); return }
      setErrors({})
      update.mutate(body)
      return
    }
    const checked = validate(HomeworkCreateRequest, {
      sectionId: chosenSection || undefined,
      subjectId: subjectId === GENERAL ? null : subjectId || undefined,
      title,
      ...(instructions.trim() ? { instructions } : {}),
      dueOn: dueOn || undefined,
    }, LABELS)
    if (!checked.ok) Object.assign(found, checked.errors)
    if (!subjectId && !found.subjectId) found.subjectId = 'Choose a subject, or general homework'
    const due = dueProblem(dueOn, todayIso())
    if (due && !found.dueOn) found.dueOn = due
    if (Object.keys(found).length > 0) { setErrors(found); return }
    setErrors({})
    create.mutate()
  }

  const busy = create.isPending || update.isPending || addFile.isPending || removeFile.isPending

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{editing ? 'Edit homework' : 'Set homework'}</SheetTitle>
          <SheetDescription>
            {editing
              ? `${classLabel(homework.grade, homework.section)} · ${subjectLabel(homework.subject)}. The class and subject stay as they are.`
              : 'Families see it in the app, and get it in the evening homework message.'}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6">
          {!editing && (
            <>
              <Field label="Class" error={errors.sectionId}>
                {onlyClass ? (
                  <div className="flex h-9 items-center rounded-lg border px-3 text-[13.5px]">{onlyClass.label}</div>
                ) : classes.options.length === 0 && !classes.isLoading ? (
                  <p className="text-[13px] text-muted-foreground">No class to set homework for this year.</p>
                ) : (
                  <Select value={sectionId} onValueChange={(value) => { setSectionId(value); setSubjectId('') }}>
                    <SelectTrigger className="w-full" aria-label="Class" aria-invalid={!!errors.sectionId}><SelectValue placeholder="Choose a class" /></SelectTrigger>
                    <SelectContent>{classes.options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </Field>
              <Field label="Subject" error={errors.subjectId} hint="General homework has no subject. Only the class teacher or the office sets it.">
                <Select value={subjectId} onValueChange={setSubjectId} disabled={!section}>
                  <SelectTrigger className="w-full" aria-label="Subject" aria-invalid={!!errors.subjectId}><SelectValue placeholder={section ? 'Choose a subject' : 'Choose a class first'} /></SelectTrigger>
                  <SelectContent>
                    {subjectOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                    <SelectItem value={GENERAL}>{GENERAL_LABEL} (no subject)</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}
          <Field label="Title" error={errors.title}>
            <Input aria-label="Title" maxLength={HOMEWORK_TITLE_MAX} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Exercise 4.2, questions 1 to 10" />
          </Field>
          <Field label="Instructions" error={errors.instructions} hint="Optional.">
            <Textarea aria-label="Instructions" rows={6} maxLength={HOMEWORK_INSTRUCTIONS_MAX} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
          </Field>
          <Field label="Due on" error={errors.dueOn} hint={errors.dueOn ? undefined : `Up to ${HOMEWORK_DUE_MAX_DAYS} days after it is set.`}>
            <Input type="date" aria-label="Due on" value={dueOn} onChange={(event) => setDueOn(event.target.value)} />
          </Field>
          <Field label="Files" hint={`PDF, JPEG or PNG, up to 4 MB each, at most ${HOMEWORK_ATTACHMENTS_MAX}.`}>
            <div className="space-y-2">
              {editing
                ? homework.attachments.map((file) => (
                    <FileRow key={file.id} name={file.fileName} size={file.sizeBytes} disabled={busy} onRemove={() => removeFile.mutate(file.id)} />
                  ))
                : pending.map((file, index) => (
                    <FileRow key={`${file.name}-${index}`} name={file.name} size={file.size} disabled={busy} onRemove={() => setPending(pending.filter((_, i) => i !== index))} />
                  ))}
              {attachedCount < HOMEWORK_ATTACHMENTS_MAX && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    aria-label="Add file"
                    accept="application/pdf,image/jpeg,image/png"
                    className="hidden"
                    onChange={(event) => { onPickFile(event.target.files?.[0]); event.target.value = '' }}
                  />
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip />Add file</Button>
                </>
              )}
            </div>
          </Field>
          {errors[FORM_ERROR] && <p role="alert" className="text-[12px] text-tag-red">{errors[FORM_ERROR]}</p>}
        </div>
        <SheetFooter className="flex-row justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>
            {editing ? (update.isPending ? 'Saving…' : 'Save changes') : (create.isPending ? 'Setting…' : 'Set homework')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function FileRow({ name, size, disabled, onRemove }: { name: string; size: number; disabled: boolean; onRemove: () => void }) {
  return (
    <div className="flex h-10 items-center gap-2 rounded-lg border px-3 text-[13px]">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="text-muted-foreground">{formatBytes(size)}</span>
      <Button variant="ghost" size="icon" aria-label={`Remove ${name}`} disabled={disabled} onClick={onRemove}><Trash2 /></Button>
    </div>
  )
}
