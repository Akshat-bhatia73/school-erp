/**
 * The marks sheet grid: roster down, components across, a subject total at the end.
 *
 * A cell holds what the person typed. A number with at most one decimal is a mark; a status is
 * picked from the small menu (or typed as A, M or E). The total is worked out with the same
 * scoring rule the server and the report card use.
 */
import { MarkValue, markFitsComponent, scoreParts, type ExamComponent, type ExamSheet, type MarkStatus } from '@erp/contracts'
import { ChevronDown } from 'lucide-react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { markText, percentText, STATUS_LABELS } from './labels'
import { MarkHistory } from './mark-history'

/** `studentId:component`. */
export type CellKey = string
export const cellKey = (studentId: string, component: ExamComponent): CellKey => `${studentId}:${component}`

/** What a cell holds while editing: '' is empty, a status key, or the digits typed. */
export type Draft = Record<CellKey, string>

const STATUSES = Object.keys(STATUS_LABELS) as MarkStatus[]

/** The saved sheet as a draft, so an untouched cell compares equal to what the server holds. */
export function draftFromSheet(sheet: ExamSheet): Draft {
  const draft: Draft = {}
  for (const row of sheet.rows) {
    for (const cell of row.cells) draft[cellKey(row.student.id, cell.component)] = String(cell.value)
  }
  return draft
}

/** The value a draft cell stands for, null when empty, or 'invalid' when it cannot be sent. */
export function parseCell(text: string | undefined, component: ExamComponent): MarkValue | null | 'invalid' {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return null
  if ((STATUSES as string[]).includes(trimmed)) return trimmed as MarkStatus
  if (!/^\d+(\.\d)?$/.test(trimmed)) return 'invalid'
  const parsed = MarkValue.safeParse(Number(trimmed))
  if (!parsed.success || !markFitsComponent(component, parsed.data)) return 'invalid'
  return parsed.data
}

/** A typed A, M or E becomes the status; anything else is left as typed. */
function normalise(previous: string, typed: string): string {
  const text = typed.trim().toLowerCase()
  // Deleting from a status empties the cell rather than leaving half a word.
  if ((STATUSES as string[]).includes(previous) && text.length < STATUS_LABELS[previous as MarkStatus].length) return ''
  if (text === 'a') return 'absent'
  if (text === 'm') return 'medical'
  if (text === 'e') return 'exempt'
  return typed.replace(/[^\d.]/g, '')
}

export function MarksGrid({ sheet, draft, editable, onChange }: {
  sheet: ExamSheet
  draft: Draft
  editable: boolean
  onChange: (key: CellKey, value: string) => void
}) {
  const components = sheet.components
  const th = 'sticky top-0 z-10 border-b border-r bg-card px-2 py-2 text-left text-[12px] font-medium text-muted-foreground'
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <table className="w-full min-w-[40rem] border-collapse text-[13.5px]">
        <thead>
          <tr>
            <th className={cn(th, 'w-16')}>Roll no</th>
            <th className={th}>Name</th>
            {components.map((component) => (
              <th key={component.key} className={cn(th, 'w-40')}>
                {component.label}
                <span className="block text-[11.5px] font-normal">out of {component.maxMarks}</span>
              </th>
            ))}
            <th className={cn(th, 'w-24 text-right')}>Total</th>
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row) => {
            const parts = components.map((component) => {
              const value = parseCell(draft[cellKey(row.student.id, component.key)], component.key)
              return { component: component.key, value: value === 'invalid' ? null : value }
            })
            const total = scoreParts(parts)
            return (
              <tr key={row.student.id} className="hover:bg-accent/40">
                <td className="border-r border-b px-2 py-1 tabular-nums text-muted-foreground">{row.student.rollNumber ?? '—'}</td>
                <td className="border-r border-b px-2 py-1">
                  <span className="block truncate">{row.student.name}</span>
                  <span className="block font-mono text-[11.5px] text-muted-foreground">{row.student.admissionNumber}</span>
                </td>
                {components.map((component) => {
                  const key = cellKey(row.student.id, component.key)
                  const text = draft[key] ?? ''
                  const saved = row.cells.find((cell) => cell.component === component.key)
                  const invalid = parseCell(text, component.key) === 'invalid'
                  const changed = saved !== undefined && text !== String(saved.value)
                  return (
                    <td key={component.key} className="border-r border-b px-1.5 py-1">
                      <div className="flex items-center gap-1">
                        {editable ? (
                          <>
                            <input
                              aria-label={`${component.label} for ${row.student.name}`}
                              aria-invalid={invalid || undefined}
                              inputMode="decimal"
                              value={(STATUSES as string[]).includes(text) ? STATUS_LABELS[text as MarkStatus] : text}
                              onChange={(event) => onChange(key, normalise(text, event.target.value))}
                              className={cn(
                                'h-8 w-full min-w-0 rounded-md border bg-background px-2 text-[13.5px] tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                invalid && 'border-tag-red text-tag-red',
                                changed && !invalid && 'border-tag-orange',
                              )}
                            />
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button type="button" aria-label={`Set a status for ${row.student.name}`} className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent">
                                  <ChevronDown className="size-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                {STATUSES.map((status) => (
                                  <DropdownMenuItem key={status} onClick={() => onChange(key, status)}>{STATUS_LABELS[status]}</DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </>
                        ) : (
                          <span className={cn('flex-1 px-1 tabular-nums', saved === undefined && 'text-muted-foreground/60')}>{markText(saved?.value)}</span>
                        )}
                        {saved && saved.revision > 1 && <MarkHistory paperId={sheet.paper.id} studentId={row.student.id} component={component.key} />}
                      </div>
                    </td>
                  )
                })}
                <td className="border-b px-2 py-1 text-right tabular-nums">{percentText(total.percentage)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
