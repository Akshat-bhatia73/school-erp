/**
 * One marks sheet: one exam, one class, one subject.
 *
 * The server says in `paper.window` what this person may do today. While the window is open the
 * subject teacher saves the whole sheet; after the re-check deadline only the office corrects it,
 * naming the changed cells and why. Anybody else sees the marks read-only with the reason.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import type { ExamMarkLine, ExamReasonKind } from '@erp/contracts'
import { Download, NotebookPen, PencilLine } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { examLabel, EnteredBar, PaperStatusTag, reasonText, STALE_MARKS_MESSAGE } from '@/components/exams/labels'
import { cellKey, draftFromSheet, MarksGrid, parseCell, type Draft } from '@/components/exams/marks-grid'
import { ReasonDialog } from '@/components/exams/reason-dialog'
import { useExportDownload } from '@/components/shared/export-download'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { colorFor, Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { ExamSheetResult } from '@/lib/api/exams'
import { describeError, isApiError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_app/exams/papers/$paperId')({ component: Page })

/**
 * The cells that are filled and valid, and what is wrong with the rest. Each line carries the
 * revision of the cell this sheet read (0 for an empty one), so a stale save is refused.
 */
function linesOf(sheet: ExamSheetResult, draft: Draft) {
  const lines: ExamMarkLine[] = []
  const changed: ExamMarkLine[] = []
  let invalid = 0
  let emptied = 0
  for (const row of sheet.rows) {
    for (const component of sheet.components) {
      const value = parseCell(draft[cellKey(row.student.id, component.key)], component.key)
      const saved = row.cells.find((cell) => cell.component === component.key)
      if (value === 'invalid') { invalid += 1; continue }
      if (value === null) { if (saved) emptied += 1; continue }
      const line = { studentId: row.student.id, component: component.key, value, expectedRevision: saved?.revision ?? 0 }
      lines.push(line)
      if (saved && String(saved.value) !== String(value)) changed.push(line)
      if (!saved) changed.push(line)
    }
  }
  const changedSaved = changed.filter((line) => sheet.rows.find((row) => row.student.id === line.studentId)?.cells.some((cell) => cell.component === line.component))
  return { lines, changed, changedSaved, invalid, emptied }
}

function Page() {
  const { paperId } = Route.useParams()
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const exportFile = useExportDownload({ className: 'px-4 py-2' })
  const sheetQuery = useQuery({ queryKey: qk.examSheet(schoolId, paperId), queryFn: () => api.exams.sheet(schoolId, paperId) })
  const sheet = sheetQuery.data
  const [draft, setDraft] = useState<Draft>({})
  const [correcting, setCorrecting] = useState(false)
  const [reasonOpen, setReasonOpen] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    if (sheet) setDraft(draftFromSheet(sheet))
  }, [sheet])

  const summary = useMemo(() => (sheet ? linesOf(sheet, draft) : null), [sheet, draft])

  const afterWrite = (fresh: ExamSheetResult, message: string) => {
    queryClient.setQueryData(qk.examSheet(schoolId, paperId), fresh)
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'exams'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'reportCards'] })
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
    setReasonOpen(false)
    setCorrecting(false)
    setProblem(null)
    toast.success(message)
  }

  const failed = (failure: unknown) => {
    // Somebody saved after this sheet was read: fetch their marks, which replace the draft.
    if (isApiError(failure, 'VERSION_CONFLICT')) {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'exams'] })
      setReasonOpen(false)
      setProblem(STALE_MARKS_MESSAGE)
      toast.error(STALE_MARKS_MESSAGE)
      return
    }
    const text = describeError(failure)
    setProblem(text)
    toast.error(text)
  }

  const saveMarks = useMutation({
    mutationFn: (change?: { reasonKind: ExamReasonKind; reason: string }) =>
      api.exams.saveMarks(schoolId, paperId, { entries: summary?.lines ?? [], change }),
    onSuccess: (fresh) => afterWrite(fresh, 'Marks saved'),
    onError: failed,
  })

  const correct = useMutation({
    mutationFn: (change: { reasonKind: ExamReasonKind; reason: string }) =>
      api.exams.correct(schoolId, paperId, { entries: summary?.changed ?? [], ...change }),
    onSuccess: (fresh) => afterWrite(fresh, 'Marks corrected'),
    onError: failed,
  })

  const startExport = useMutation({
    mutationFn: () => api.exams.exportRegister(schoolId, paperId),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const crumbs = [{ label: 'Exams', to: '/exams', icon: <NotebookPen /> }]
  if (sheetQuery.isError) {
    return <><PageHeader crumbs={[...crumbs, { label: 'Not available' }]} /><EmptyState icon={<NotebookPen />} title="This marks sheet is not available" description={describeError(sheetQuery.error)} /></>
  }
  if (!sheet || !summary) {
    return <><PageHeader crumbs={[...crumbs, { label: 'Loading…' }]} /><div className="space-y-3 p-3 md:p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-96 w-full" /></div></>
  }

  const { paper } = sheet
  const { window } = paper
  const recording = window.record
  const editable = recording || (correcting && window.correct)
  const classLabel = `${paper.grade.name} - ${paper.section.name}`
  const canExport = allows(paper.allowedActions, 'exams.export')

  const windowSentence =
    window.state === 'open'
      ? recording
        ? `You can change these marks until the end of ${formatDate(paper.exam.recheckDeadline, 'long')}.`
        : `Marks are being entered until the end of ${formatDate(paper.exam.recheckDeadline, 'long')}.`
      : window.state === 'locked'
        ? 'The re-check deadline has passed. Only the office can change these marks now.'
        : `This exam starts on ${formatDate(paper.exam.startsOn, 'long')}. Marks can be entered from that day.`
  const blocked = !recording && !window.correct ? reasonText(window.recordBlockedBy ?? window.correctBlockedBy) : undefined

  const submit = () => {
    setProblem(null)
    if (summary.invalid > 0) {
      setProblem(`${summary.invalid} ${summary.invalid === 1 ? 'mark is' : 'marks are'} not right. A mark is a number with at most one decimal, no higher than what that part is out of.`)
      return
    }
    if (summary.emptied > 0) {
      setProblem('A saved mark cannot be emptied. Enter a mark or a status instead.')
      return
    }
    if (correcting) {
      if (summary.changed.length === 0) { setProblem('Nothing has changed yet.'); return }
      setReasonOpen(true)
      return
    }
    if (summary.changedSaved.length > 0) { setReasonOpen(true); return }
    saveMarks.mutate(undefined)
  }

  const busy = saveMarks.isPending || correct.isPending
  const actions = (
    <>
      {canExport && <Button size="sm" variant="outline" disabled={startExport.isPending} onClick={() => startExport.mutate()}><Download />Download register</Button>}
      {!recording && window.correct && !correcting && <Button size="sm" variant="outline" onClick={() => setCorrecting(true)}><PencilLine />Correct marks</Button>}
      {correcting && <Button size="sm" variant="ghost" onClick={() => { setCorrecting(false); setDraft(draftFromSheet(sheet)); setProblem(null) }}>Cancel</Button>}
      {editable && <Button size="sm" disabled={busy} onClick={submit}>{correcting ? 'Save corrections' : 'Save marks'}</Button>}
    </>
  )

  return (
    <>
      <PageHeader crumbs={[...crumbs, { label: `${examLabel(paper.exam.kind)} · ${classLabel} · ${paper.subject.name}` }]} actions={actions} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-3 py-3 md:px-5">
        <div className="min-w-0">
          <h1 className="text-[16px] font-semibold">{paper.subject.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            <span>{examLabel(paper.exam.kind)}</span>
            <Tag color={colorFor(classLabel)}>{classLabel}</Tag>
            <PaperStatusTag state={window.state} published={paper.published} />
            <span>Re-check deadline {formatDate(paper.exam.recheckDeadline)}</span>
          </div>
        </div>
        <div className="ml-auto"><EnteredBar entered={paper.entered} expected={paper.expected} /></div>
        <p className="w-full text-[13px] text-muted-foreground">
          {windowSentence}
          {blocked && window.state !== 'locked' ? ` ${blocked}` : ''}
          {correcting ? ' Change only the marks that are wrong; you will be asked why.' : ''}
        </p>
        {problem && <p role="alert" className="w-full text-[12.5px] text-tag-red">{problem}</p>}
      </div>
      {exportFile.status}
      {sheet.rows.length === 0 ? (
        <EmptyState icon={<NotebookPen />} title="Nobody on this roster" description="No pupil was in this class on the first day of the exam." />
      ) : (
        <MarksGrid sheet={sheet} draft={draft} editable={editable} onChange={(key, value) => setDraft((current) => ({ ...current, [key]: value }))} />
      )}
      <div className="flex shrink-0 items-center justify-between border-t bg-card px-4 py-2 text-[12.5px] text-muted-foreground">
        <span>{sheet.rows.length} {sheet.rows.length === 1 ? 'pupil' : 'pupils'} on the roster</span>
        <span>{paper.entered} of {paper.expected} entered</span>
      </div>
      <ReasonDialog
        key={reasonOpen ? 'open' : 'closed'}
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={correcting ? 'Correct these marks?' : 'Change saved marks?'}
        description={`${correcting ? summary.changed.length : summary.changedSaved.length} saved ${(correcting ? summary.changed.length : summary.changedSaved.length) === 1 ? 'mark' : 'marks'} will change. The old marks stay on record with the reason you give.`}
        submitLabel={correcting ? 'Save corrections' : 'Save marks'}
        busy={busy}
        onSubmit={(change) => (correcting ? correct.mutate(change) : saveMarks.mutate(change))}
      />
    </>
  )
}
