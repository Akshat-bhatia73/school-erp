/**
 * A day's register inside a change card, for pupils or for staff: the same five-mark picker as
 * the register screen, one row each, with the mark saved now struck through beside a changed one.
 */
import type { AttendanceDayPreview, AttendanceMark, StaffAttendanceDayPreview } from '@erp/contracts'
import { useState } from 'react'
import { MARK_LABEL } from '@/components/attendance/labels'
import { MarkPicker } from '@/components/attendance/mark-picker'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import type { FieldErrors } from '@/lib/validation'
import { cn } from '@/lib/utils'
import { CHANGED_ROW, LONG_LIST, SCROLL_BOX, Was } from './parts'

type RegisterPreview = AttendanceDayPreview | StaffAttendanceDayPreview

interface Line {
  id: string
  lead: string
  name: string
  sub?: string
  current: AttendanceMark | null
  proposed: AttendanceMark
}

function linesOf(preview: RegisterPreview): Line[] {
  if (preview.kind === 'attendance_day') {
    return preview.rows.map((row) => ({ id: row.studentId, lead: row.rollNumber === null ? '—' : String(row.rollNumber), name: row.name, current: row.current, proposed: row.proposed }))
  }
  return preview.rows.map((row) => ({ id: row.staffId, lead: '', name: row.name, sub: row.designation ?? undefined, current: row.current, proposed: row.proposed }))
}

/** The preview with one row's proposed mark set, or every row's when `index` is 'all'. */
function withMark<P extends RegisterPreview>(preview: P, index: number | 'all', mark: AttendanceMark): P {
  const rows = (preview.rows as RegisterPreview['rows']).map((row, i) => (index === 'all' || i === index ? { ...row, proposed: mark } : row))
  return { ...preview, rows } as P
}

export function RegisterBody({ preview, onChange, errors, readOnly }: {
  preview: RegisterPreview
  onChange: (next: RegisterPreview) => void
  errors: FieldErrors
  readOnly: boolean
}) {
  const staff = preview.kind === 'staff_attendance_day'
  const lines = linesOf(preview)
  const [onlyChanges, setOnlyChanges] = useState(false)
  const long = lines.length > LONG_LIST
  const shown = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !(long && onlyChanges) || line.proposed !== line.current)

  return (
    <div>
      {(!readOnly || long) && (
        <div className="flex flex-wrap items-center gap-3 border-b px-3.5 py-2">
          {!readOnly && (
            <Button size="sm" variant="outline" onClick={() => onChange(withMark(preview, 'all', 'present'))}>Mark all present</Button>
          )}
          {long && (
            <Label className="flex items-center gap-2 text-[12.5px] font-normal text-muted-foreground">
              <Checkbox checked={onlyChanges} onCheckedChange={(checked) => setOnlyChanges(checked === true)} />
              Show only changes
            </Label>
          )}
        </div>
      )}
      <div className={SCROLL_BOX}>
        <table className="w-full border-separate border-spacing-0 text-[13.5px]">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              {!staff && <th className="h-9 w-14 border-b bg-card px-3 text-left text-[12px] font-medium text-muted-foreground">Roll no</th>}
              <th className={cn('h-9 border-b bg-card px-3 text-left text-[12px] font-medium text-muted-foreground', !staff && 'border-l')}>Name</th>
              <th className="h-9 border-b border-l bg-card px-3 text-left text-[12px] font-medium text-muted-foreground">Mark</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ line, index }) => {
              const changed = line.proposed !== line.current
              const invalid = errors[`rows.${index}.proposed`]
              return (
                <tr key={line.id} className={cn(changed && CHANGED_ROW)} data-changed={changed || undefined}>
                  {!staff && <td className="h-10 border-b px-3 tabular-nums text-muted-foreground">{line.lead}</td>}
                  <td className={cn('h-10 border-b px-3', !staff && 'border-l')}>
                    <div className="min-w-0 truncate font-medium">{line.name}</div>
                    {line.sub && <div className="truncate text-[12px] text-muted-foreground">{line.sub}</div>}
                  </td>
                  <td className={cn('h-10 border-b border-l px-3', invalid && 'text-tag-red')}>
                    <div className="flex items-center gap-2">
                      <MarkPicker name={line.name} value={line.proposed} readOnly={readOnly} onChange={(mark) => onChange(withMark(preview, index, mark))} />
                      {changed && <Was>{line.current ? MARK_LABEL[line.current] : 'Not marked'}</Was>}
                    </div>
                  </td>
                </tr>
              )
            })}
            {shown.length === 0 && (
              <tr><td colSpan={staff ? 2 : 3} className="px-3 py-6 text-center text-[13px] text-muted-foreground">No mark changes yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
