/** A month of a register: one row per person, one narrow column per day, then the totals. */
import type { AttendanceMark, AttendanceSummary } from '@erp/contracts'
import { MARK_LABEL, MARK_SHORT, Percentage } from '@/components/attendance/labels'
import { cn } from '@/lib/utils'

export interface RegisterGridDay {
  date: string
  kind: 'school_day' | 'sunday' | 'holiday' | 'outside_year'
  holidayName?: string
}

export interface RegisterGridCell {
  /** True when the person was on the roster or the register that day. */
  on: boolean
  mark?: AttendanceMark
}

export interface RegisterGridRow {
  id: string
  /** Roll number or employee code, whichever the register is keyed by. */
  lead: string
  name: string
  cells: RegisterGridCell[]
  summary: AttendanceSummary
  to?: string
}

const MARK_TEXT: Record<AttendanceMark, string> = {
  present: 'text-tag-green',
  absent: 'text-tag-red',
  late: 'text-tag-orange',
  leave: 'text-tag-blue',
  half_day: 'text-tag-purple',
}

function DayCell({ day, cell }: { day: RegisterGridDay; cell: RegisterGridCell | undefined }) {
  const off = day.kind !== 'school_day'
  if (!cell || !cell.on) return <td className={cn('border-l px-1 text-center', off && 'bg-muted/40')} />
  if (cell.mark) {
    return (
      <td className={cn('border-l px-1 text-center text-[12px] font-medium', MARK_TEXT[cell.mark], off && 'bg-muted/40')}>
        {MARK_SHORT[cell.mark]}
      </td>
    )
  }
  if (off) return <td className="border-l bg-muted/40 px-1 text-center" />
  return (
    <td className="border-l px-1 text-center">
      <span className="inline-block size-1.5 rounded-full bg-muted-foreground/40" />
    </td>
  )
}

/** The legend under a grid, so the letters need no explaining. */
export function MarkLegend({ className }: { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-muted-foreground', className)}>
      {(Object.keys(MARK_SHORT) as AttendanceMark[]).map((mark) => (
        <span key={mark} className="flex items-center gap-1.5">
          <span className={cn('font-medium', MARK_TEXT[mark])}>{MARK_SHORT[mark]}</span>
          <span>{MARK_LABEL[mark]}</span>
        </span>
      ))}
      <span className="flex items-center gap-1.5"><span className="inline-block size-1.5 rounded-full bg-muted-foreground/40" />not marked</span>
    </div>
  )
}

export function RegisterGrid({ days, rows, leadLabel }: { days: RegisterGridDay[]; rows: RegisterGridRow[]; leadLabel: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
      <table className="w-full border-separate border-spacing-0 text-[13px]">
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <th className="h-10 border-b bg-card px-3 text-left font-medium text-muted-foreground">{leadLabel}</th>
            <th className="h-10 border-b border-l bg-card px-3 text-left font-medium text-muted-foreground">Name</th>
            {days.map((day) => (
              <th
                key={day.date}
                title={day.holidayName ?? day.kind.replace('_', ' ')}
                className={cn('h-10 w-7 border-b border-l bg-card px-1 text-center text-[12px] font-medium text-muted-foreground', day.kind !== 'school_day' && 'bg-muted/40')}
              >
                {Number(day.date.slice(8, 10))}
              </th>
            ))}
            {['P', 'A', 'L', 'LV', 'H', 'Days', '%'].map((label) => (
              <th key={label} className="h-10 border-b border-l bg-card px-2 text-center font-medium text-muted-foreground">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="hover:bg-accent/40">
              <td className="h-9 border-b px-3 tabular-nums">{row.lead}</td>
              <td className="h-9 border-b border-l px-3 font-medium">{row.name}</td>
              {days.map((day, index) => <DayCell key={day.date} day={day} cell={row.cells[index]} />)}
              <td className="h-9 border-b border-l px-2 text-center tabular-nums">{row.summary.present}</td>
              <td className="h-9 border-b border-l px-2 text-center tabular-nums">{row.summary.absent}</td>
              <td className="h-9 border-b border-l px-2 text-center tabular-nums">{row.summary.late}</td>
              <td className="h-9 border-b border-l px-2 text-center tabular-nums">{row.summary.leave}</td>
              <td className="h-9 border-b border-l px-2 text-center tabular-nums">{row.summary.halfDay}</td>
              <td className="h-9 border-b border-l px-2 text-center tabular-nums">{row.summary.schoolDays}</td>
              <td className="h-9 border-b border-l px-2 text-center"><Percentage value={row.summary.percentage} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
