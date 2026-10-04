/**
 * The check-off sheet: the class roster on the due date, one status and an optional remark each.
 *
 * Only the lines that changed are sent, each with the version of the check-off the screen read (0
 * for a pupil not checked yet), in one save. A line is never un-checked: once a pupil has a status
 * the choice can change but not go back to empty. Whether this person may save now (from the due
 * date, until the teacher's window closes, or at any time for the office) is the server's answer in
 * `window.check`; without it the sheet is read only and says why.
 */
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCheck, ClipboardCheck } from 'lucide-react'
import { toast } from 'sonner'
import {
  HOMEWORK_REMARK_MAX,
  HomeworkCheckSaveRequest,
  type HomeworkCheckLine,
  type HomeworkCheckStatus,
} from '@erp/contracts'
import { EmptyState, Panel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { HomeworkSheet, HomeworkSheetRow } from '@/lib/api/homework'
import { describeError, isApiError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn, formatDate } from '@/lib/utils'
import { useHomeworkRefresh } from './homework-sheet'
import { CHECK_OPTIONS, PupilStatusTag } from './labels'

interface Draft { status?: HomeworkCheckStatus; remark: string }

function draftOf(row: HomeworkSheetRow): Draft {
  return { status: row.check?.status, remark: row.check?.remark ?? '' }
}

/** The lines to send: the rows whose status or remark differs from what was read. */
export function changedLines(rows: readonly HomeworkSheetRow[], drafts: Readonly<Record<string, Draft>>): { lines: HomeworkCheckLine[]; missingStatus: string[] } {
  const lines: HomeworkCheckLine[] = []
  const missingStatus: string[] = []
  for (const row of rows) {
    const draft = drafts[row.student.id]
    if (!draft) continue
    const remark = draft.remark.trim()
    const savedRemark = row.check?.remark ?? ''
    const statusChanged = draft.status !== row.check?.status
    const remarkChanged = remark !== savedRemark
    if (!statusChanged && !remarkChanged) continue
    if (!draft.status) {
      // A remark with no status cannot be saved; the screen asks for a status.
      if (remark) missingStatus.push(row.student.id)
      continue
    }
    lines.push({
      studentId: row.student.id,
      status: draft.status,
      ...(remark ? { remark } : savedRemark ? { remark: null } : {}),
      expectedVersion: row.check?.version ?? 0,
    })
  }
  return { lines, missingStatus }
}

const WINDOW_TEXT = {
  not_due: (dueOn: string) => `Pupils can be checked off from ${formatDate(dueOn)}, the day it is due.`,
  closed: (closesOn: string) => `Teachers could change check-offs until ${formatDate(closesOn)}. Ask the school office to change them now.`,
} as const

export function CheckOffSheet({ homeworkId, dueOn }: { homeworkId: string; dueOn: string }) {
  const { schoolId } = useSchoolContext()
  const refresh = useHomeworkRefresh()
  const sheetQuery = useQuery({ queryKey: qk.homework.checks(schoolId, homeworkId), queryFn: () => api.homework.checks(schoolId, homeworkId) })
  const sheet = sheetQuery.data
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<string[]>([])

  // A fresh read (after a save, or somebody else's) starts the drafts again from what is stored.
  useEffect(() => {
    if (!sheet) return
    setDrafts(Object.fromEntries(sheet.rows.map((row) => [row.student.id, draftOf(row)])))
    setMissing([])
  }, [sheet])

  const canSave = sheet?.window.check === true
  const { lines, missingStatus } = useMemo(() => (sheet ? changedLines(sheet.rows, drafts) : { lines: [], missingStatus: [] }), [sheet, drafts])
  const dirty = lines.length > 0 || missingStatus.length > 0

  const save = useMutation({
    mutationFn: (entries: HomeworkCheckLine[]) => api.homework.saveChecks(schoolId, homeworkId, { entries }),
    onSuccess: () => {
      refresh()
      setError(null)
      toast.success('Check-offs saved')
    },
    onError: (failure) => {
      const message = describeError(failure)
      setError(message)
      toast.error(message)
      // Somebody else saved first: read the sheet again so the next save starts from theirs.
      if (isApiError(failure, 'VERSION_CONFLICT')) refresh()
    },
  })

  const setRow = (studentId: string, patch: Partial<Draft>) => {
    setDrafts((current) => ({ ...current, [studentId]: { ...(current[studentId] ?? { remark: '' }), ...patch } }))
    if (patch.status) setMissing((ids) => ids.filter((id) => id !== studentId))
  }

  const markAllDone = () => {
    if (!sheet) return
    setDrafts((current) => {
      const next = { ...current }
      for (const row of sheet.rows) {
        const draft = next[row.student.id] ?? { remark: '' }
        if (!draft.status) next[row.student.id] = { ...draft, status: 'done' }
      }
      return next
    })
    setMissing([])
  }

  const submit = () => {
    if (!sheet) return
    const { lines: entries, missingStatus } = changedLines(sheet.rows, drafts)
    if (missingStatus.length > 0) {
      setMissing(missingStatus)
      setError('Choose Done, Partly done or Not done for each pupil with a remark.')
      return
    }
    if (entries.length === 0) return
    const checked = HomeworkCheckSaveRequest.safeParse({ entries })
    if (!checked.success) {
      setError(`A remark can be up to ${HOMEWORK_REMARK_MAX} characters.`)
      return
    }
    setError(null)
    save.mutate(entries)
  }

  if (sheetQuery.isError) {
    return <Panel title="Check-offs"><EmptyState icon={<ClipboardCheck />} title="The check-offs are not available" description={describeError(sheetQuery.error)} className="py-8" /></Panel>
  }
  if (!sheet) {
    return <Panel title="Check-offs"><Skeleton className="h-40 w-full" /></Panel>
  }

  const notice = sheet.window.state === 'not_due'
    ? WINDOW_TEXT.not_due(dueOn)
    : !canSave && sheet.window.state === 'closed'
      ? WINDOW_TEXT.closed(sheet.window.teacherClosesOn)
      : null
  const checkedCount = sheet.rows.filter((row) => row.check).length

  return (
    <Panel
      title="Check-offs"
      description={`${checkedCount} of ${sheet.rows.length} ${sheet.rows.length === 1 ? 'pupil' : 'pupils'} checked`}
      actions={canSave && sheet.rows.length > 0 ? (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={markAllDone}><CheckCheck />Mark all done</Button>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={submit}>{save.isPending ? 'Saving…' : 'Save changes'}</Button>
        </div>
      ) : undefined}
      bodyClassName="px-0 md:px-0"
    >
      {notice && <p className="px-3 pb-3 text-[13px] text-muted-foreground md:px-4">{notice}</p>}
      {error && <p role="alert" className="px-3 pb-3 text-[12.5px] text-tag-red md:px-4">{error}</p>}
      {sheet.rows.length === 0 ? (
        <EmptyState icon={<ClipboardCheck />} title="No pupils on the roster" description="Nobody was enrolled in this class on the due date." className="py-8" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="border-y bg-muted/30 text-left text-[12px] text-muted-foreground">
                <th className="w-14 border-r px-3 py-2 font-medium">Roll</th>
                <th className="border-r px-3 py-2 font-medium">Pupil</th>
                <th className="border-r px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Remark</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row) => (
                <CheckRow
                  key={row.student.id}
                  row={row}
                  draft={drafts[row.student.id] ?? draftOf(row)}
                  editable={canSave}
                  missing={missing.includes(row.student.id)}
                  onChange={(patch) => setRow(row.student.id, patch)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function CheckRow({ row, draft, editable, missing, onChange }: {
  row: HomeworkSheet['rows'][number]
  draft: Draft
  editable: boolean
  missing: boolean
  onChange: (patch: Partial<Draft>) => void
}) {
  const name = row.student.name
  return (
    <tr className="border-b last:border-b-0">
      <td className="border-r px-3 py-1.5 tabular-nums text-muted-foreground">{row.student.rollNumber ?? '—'}</td>
      <td className="border-r px-3 py-1.5">
        <span className="block truncate font-medium">{name}</span>
        <span className="block truncate font-mono text-[12px] text-muted-foreground">{row.student.admissionNumber}</span>
      </td>
      <td className="border-r px-3 py-1.5">
        {editable ? (
          <div role="radiogroup" aria-label={`Status for ${name}`} className={cn('inline-flex h-7 items-center rounded-lg border p-0.5', missing && 'border-tag-red')}>
            {CHECK_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={draft.status === option.value}
                onClick={() => onChange({ status: option.value })}
                className={cn('h-6 whitespace-nowrap rounded-md px-2 text-[12.5px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', draft.status === option.value ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <PupilStatusTag status={row.check?.status ?? 'not_checked'} />
        )}
      </td>
      <td className="px-3 py-1.5">
        {editable ? (
          <Input aria-label={`Remark for ${name}`} className="h-8 min-w-48" maxLength={HOMEWORK_REMARK_MAX} value={draft.remark} onChange={(event) => onChange({ remark: event.target.value })} />
        ) : (
          <span className="text-muted-foreground">{row.check?.remark ?? ''}</span>
        )}
      </td>
    </tr>
  )
}
