/**
 * Co-scholastic grades inside a change card: one row per pupil with the same four grade pickers
 * as the entries screen. Remarks the change would alter start open with the saved remark above
 * the new one, so nothing the assistant wrote goes unseen; unchanged remarks stay folded away
 * until somebody opens them.
 */
import { CO_SCHOLASTIC_AREAS, CoScholasticArea, type CoScholasticGrade, type CoScholasticPreview } from '@erp/contracts'
import { MessageSquareText } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { FieldErrors } from '@/lib/validation'
import { cn } from '@/lib/utils'
import { gradesChange } from './model'
import { CHANGED_ROW, SCROLL_BOX, Was } from './parts'

const AREAS = CoScholasticArea.options
const NOT_GRADED = 'none'

type Row = CoScholasticPreview['rows'][number]

const remarksDiffer = (row: Row) => (row.proposedRemarks ?? '').trim() !== (row.currentRemarks ?? '').trim()

export function CoScholasticBody({ preview, onChange, errors, readOnly, idBase }: {
  preview: CoScholasticPreview
  onChange: (next: CoScholasticPreview) => void
  errors: FieldErrors
  readOnly: boolean
  /** Unique to the card, for the ids an error message is found by. */
  idBase: string
}) {
  // Opened once, from the change as it came: editing a remark back to what is saved does not fold it away mid-word.
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(preview.rows.filter(remarksDiffer).map((row) => [row.studentId, true])),
  )
  const th = 'sticky top-0 z-10 border-b bg-card px-2 py-2 text-left text-[12px] font-medium text-muted-foreground'

  const update = (index: number, change: Partial<Row>) =>
    onChange({ ...preview, rows: preview.rows.map((row, i) => (i === index ? { ...row, ...change } : row)) })

  return (
    <div className={SCROLL_BOX}>
      <table className="w-full min-w-[36rem] border-separate border-spacing-0 text-[13.5px]">
        <thead>
          <tr>
            <th className={th}>Pupil</th>
            {AREAS.map((area) => <th key={area} className={cn(th, 'w-24 border-l')}>{CO_SCHOLASTIC_AREAS[area]}</th>)}
            <th className={cn(th, 'w-10 border-l')}><span className="sr-only">Remarks</span></th>
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, index) => {
            const changed = gradesChange(row)
            const remarksChanged = remarksDiffer(row)
            const remarksError = errors[`rows.${index}.proposedRemarks`]
            const remarksErrorId = `${idBase}-remarks-${index}-error`
            const expanded = open[row.studentId] || !!remarksError
            return (
              <Fragment key={row.studentId}>
                <tr className={cn(changed && CHANGED_ROW)} data-changed={changed || undefined}>
                  <td className="h-10 border-b px-2">
                    <span className="block truncate font-medium">{row.rollNumber === null ? '' : `${row.rollNumber}. `}{row.name}</span>
                  </td>
                  {AREAS.map((area) => {
                    const proposed = row.proposed[area]
                    const current = row.current[area]
                    return (
                      <td key={area} className="h-10 border-b border-l px-1.5">
                        <div className="flex items-center gap-1.5">
                          {readOnly ? (
                            <span className="px-1">{proposed ?? '—'}</span>
                          ) : (
                            <Select
                              value={proposed ?? NOT_GRADED}
                              onValueChange={(grade) => update(index, { proposed: { ...row.proposed, [area]: grade === NOT_GRADED ? null : (grade as CoScholasticGrade) } })}
                            >
                              <SelectTrigger size="sm" aria-label={`${CO_SCHOLASTIC_AREAS[area]} for ${row.name}`} className="w-14 px-2"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NOT_GRADED}>Not graded</SelectItem>
                                <SelectItem value="A">A</SelectItem>
                                <SelectItem value="B">B</SelectItem>
                                <SelectItem value="C">C</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                          {proposed !== current && <Was>{current ?? '—'}</Was>}
                        </div>
                      </td>
                    )
                  })}
                  <td className="h-10 border-b border-l px-1 text-center">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      onClick={() => setOpen((old) => ({ ...old, [row.studentId]: !expanded }))}
                      className={cn(
                        'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        (remarksChanged || expanded) && 'text-foreground',
                      )}
                    >
                      <MessageSquareText className="size-3.5" />
                      <span className="sr-only">Remarks for {row.name}{remarksChanged ? ', changed' : ''}</span>
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr className={cn(changed && CHANGED_ROW)}>
                    <td colSpan={AREAS.length + 2} className="border-b px-2 py-2">
                      {remarksChanged && (
                        <p className="mb-1.5 text-[12px] break-words text-muted-foreground">
                          <span aria-hidden>Was: </span>
                          {row.currentRemarks?.trim() ? <Was>{row.currentRemarks}</Was> : <span><span className="sr-only">was </span>no remarks</span>}
                        </p>
                      )}
                      {readOnly ? (
                        <p className="text-[13px] whitespace-pre-wrap text-muted-foreground">{row.proposedRemarks || 'No remarks.'}</p>
                      ) : (
                        <Textarea
                          aria-label={`Remarks for ${row.name}`}
                          aria-invalid={!!remarksError || undefined}
                          aria-describedby={remarksError ? remarksErrorId : undefined}
                          rows={2}
                          maxLength={1000}
                          value={row.proposedRemarks ?? ''}
                          onChange={(event) => update(index, { proposedRemarks: event.target.value === '' ? null : event.target.value })}
                          className="min-h-9 text-[13px]"
                        />
                      )}
                      {remarksError && <p id={remarksErrorId} className="mt-1 text-[12.5px] text-tag-red">{remarksError}</p>}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
