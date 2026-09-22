/** The five marks as one segmented control, for one row of a register. */
import { ATTENDANCE_MARKS, type AttendanceMark } from '@erp/contracts'
import { MARK_LABEL, MARK_SHORT } from '@/components/attendance/labels'
import { cn } from '@/lib/utils'

const CHOSEN: Record<AttendanceMark, string> = {
  present: 'bg-tag-green text-background',
  absent: 'bg-tag-red text-background',
  late: 'bg-tag-orange text-background',
  leave: 'bg-tag-blue text-background',
  half_day: 'bg-tag-purple text-background',
}

export function MarkPicker({ name, value, onChange, readOnly }: {
  /** The person this row is about, so the control says whose mark it sets. */
  name: string
  value: AttendanceMark | undefined
  onChange: (mark: AttendanceMark) => void
  readOnly?: boolean
}) {
  if (readOnly) {
    return (
      <div className="flex items-center gap-1.5 text-[13px]" aria-label={`Mark for ${name}`}>
        {value ? MARK_LABEL[value] : <span className="text-muted-foreground/60">Not marked</span>}
      </div>
    )
  }
  return (
    <div role="group" aria-label={`Mark for ${name}`} className="inline-flex items-center gap-0.5 rounded-full border bg-card p-0.5">
      {ATTENDANCE_MARKS.map((mark) => (
        <button
          key={mark}
          type="button"
          aria-pressed={value === mark}
          title={MARK_LABEL[mark]}
          onClick={() => onChange(mark)}
          className={cn(
            'inline-flex h-7 min-w-8 items-center justify-center rounded-full px-2 text-[12.5px] font-medium text-muted-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            value === mark && CHOSEN[mark],
          )}
        >
          {MARK_SHORT[mark]}
        </button>
      ))}
    </div>
  )
}
