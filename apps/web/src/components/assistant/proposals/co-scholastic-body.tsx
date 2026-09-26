/**
 * Co-scholastic grades inside a change card: one row per pupil with the same four grade pickers
 * as the entries screen, and the remarks folded away under each row until somebody opens them.
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

export function CoScholasticBody({ preview, onChange, errors, readOnly }: {
  preview: CoScholasticPreview
  onChange: (next: CoScholasticPreview) => void
  errors: FieldErrors
  readOnly: boolean
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
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
            const remarksChanged = (row.proposedRemarks ?? '').trim() !== (row.currentRemarks ?? '').trim()
            const remarksError = errors[`rows.${index}.proposedRemarks`]
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
                      aria-label={`Remarks for ${row.name}`}
                      onClick={() => setOpen((old) => ({ ...old, [row.studentId]: !expanded }))}
                      className={cn(
                        'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        (remarksChanged || expanded) && 'text-foreground',
                      )}
                    >
                      <MessageSquareText className="size-3.5" />
                    </button>
                  </td>
                </tr>
                {expanded && (
                  <tr className={cn(changed && CHANGED_ROW)}>
                    <td colSpan={AREAS.length + 2} className="border-b px-2 py-2">
                      {readOnly ? (
                        <p className="text-[13px] whitespace-pre-wrap text-muted-foreground">{row.proposedRemarks || 'No remarks.'}</p>
                      ) : (
                        <Textarea
                          aria-label={`Remarks for ${row.name}`}
                          aria-invalid={!!remarksError || undefined}
                          rows={2}
                          maxLength={1000}
                          value={row.proposedRemarks ?? ''}
                          onChange={(event) => update(index, { proposedRemarks: event.target.value === '' ? null : event.target.value })}
                          className="min-h-9 text-[13px]"
                        />
                      )}
                      {remarksChanged && row.currentRemarks && <p className="mt-1 text-[12px]"><Was>{row.currentRemarks}</Was></p>}
                      {remarksError && <p className="mt-1 text-[12.5px] text-tag-red">{remarksError}</p>}
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
