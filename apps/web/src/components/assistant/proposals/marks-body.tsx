/**
 * A marks sheet inside a change card: one row per pupil, one cell per component the change is
 * about. A cell with a proposed mark stands out with the saved mark struck through beside it; a
 * cell left as it is looks read-only but can still be typed into. Typing works as on the marks
 * sheet: digits with one decimal, or A, M or E for a status, which the small menu also sets.
 */
import type { ExamMarksPreview, MarkStatus, MarkValue } from '@erp/contracts'
import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import { markText, STATUS_LABELS } from '@/components/exams/labels'
import { normalise, parseCell } from '@/components/exams/marks-grid'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { FieldErrors } from '@/lib/validation'
import { cn } from '@/lib/utils'
import { cellChanges } from './model'
import { CHANGED_ROW, SCROLL_BOX, Was } from './parts'

const STATUSES = Object.keys(STATUS_LABELS) as MarkStatus[]

const isStatus = (text: string): text is MarkStatus => (STATUSES as string[]).includes(text)

/** A cell's value as typed: empty leaves the cell as it is, a status is itself, anything else is the number it reads as. */
function valueOf(text: string): MarkValue | null {
  const trimmed = text.trim()
  if (trimmed === '') return null
  if (isStatus(trimmed)) return trimmed
  return Number(trimmed)
}

function textOf(value: MarkValue | null): string {
  return value === null ? '' : String(value)
}

function withCell(preview: ExamMarksPreview, r: number, c: number, proposed: MarkValue | null): ExamMarksPreview {
  return {
    ...preview,
    rows: preview.rows.map((row, i) => (i !== r ? row : { ...row, cells: row.cells.map((cell, j) => (j === c ? { ...cell, proposed } : cell)) })),
  }
}

export function MarksBody({ preview, onChange, errors, readOnly }: {
  preview: ExamMarksPreview
  onChange: (next: ExamMarksPreview) => void
  errors: FieldErrors
  readOnly: boolean
}) {
  // What each cell shows while it is typed into ("7." on the way to "7.5"); the preview holds the value.
  const [typed, setTyped] = useState<Record<string, string>>({})
  const th = 'sticky top-0 z-10 border-b bg-card px-2 py-2 text-left text-[12px] font-medium text-muted-foreground'

  const set = (r: number, c: number, text: string) => {
    setTyped((old) => ({ ...old, [`${r}:${c}`]: text }))
    onChange(withCell(preview, r, c, valueOf(text)))
  }

  return (
    <div className={SCROLL_BOX}>
      <table className="w-full min-w-[32rem] border-separate border-spacing-0 text-[13.5px]">
        <thead>
          <tr>
            <th className={cn(th, 'w-14')}>Roll no</th>
            <th className={cn(th, 'border-l')}>Name</th>
            {preview.components.map((component) => (
              <th key={component.component} className={cn(th, 'w-36 border-l')}>
                {component.label}
                <span className="block text-[11.5px] font-normal">out of {component.maxMarks}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, r) => {
            const rowChanged = row.cells.some(cellChanges)
            return (
              <tr key={row.studentId} className={cn(rowChanged && CHANGED_ROW)} data-changed={rowChanged || undefined}>
                <td className="h-10 border-b px-2 tabular-nums text-muted-foreground">{row.rollNumber ?? '—'}</td>
                <td className="h-10 border-b border-l px-2"><span className="block truncate font-medium">{row.name}</span></td>
                {preview.components.map((component) => {
                  const c = row.cells.findIndex((cell) => cell.component === component.component)
                  const cell = row.cells[c]
                  if (!cell) return <td key={component.component} className="h-10 border-b border-l px-2 text-muted-foreground/60">—</td>
                  const changed = cellChanges(cell)
                  const text = typed[`${r}:${c}`] ?? textOf(cell.proposed)
                  const invalid = !!errors[`rows.${r}.cells.${c}.proposed`] || (text !== '' && parseCell(text, component.component) === 'invalid')
                  const label = `${component.label} for ${row.name}`
                  return (
                    <td key={component.component} className="h-10 border-b border-l px-1.5">
                      {readOnly ? (
                        <span className="flex items-center gap-1.5 px-1 tabular-nums">
                          <span className={cn(cell.proposed === null && 'text-muted-foreground')}>{markText(cell.proposed ?? cell.current)}</span>
                          {changed && cell.current !== null && <Was>{markText(cell.current)}</Was>}
                        </span>
                      ) : (
                        <div className="flex items-center gap-1">
                          <input
                            aria-label={label}
                            aria-invalid={invalid || undefined}
                            inputMode="decimal"
                            value={isStatus(text) ? STATUS_LABELS[text] : text}
                            placeholder={cell.current === null ? undefined : markText(cell.current)}
                            onChange={(event) => set(r, c, normalise(text, event.target.value))}
                            className={cn(
                              'h-7 w-full min-w-0 rounded-md border px-1.5 text-[13.5px] tabular-nums outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring',
                              changed ? 'border-input bg-background font-medium' : 'border-transparent bg-transparent hover:border-input',
                              invalid && 'border-tag-red text-tag-red',
                            )}
                          />
                          {changed && cell.current !== null && <Was>{markText(cell.current)}</Was>}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button type="button" aria-label={`Set a status for ${row.name}, ${component.label}`} className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent">
                                <ChevronDown className="size-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {STATUSES.map((status) => (
                                <DropdownMenuItem key={status} onClick={() => set(r, c, status)}>{STATUS_LABELS[status]}</DropdownMenuItem>
                              ))}
                              {cell.proposed !== null && (
                                <DropdownMenuItem onClick={() => set(r, c, '')}>Leave as it is</DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
