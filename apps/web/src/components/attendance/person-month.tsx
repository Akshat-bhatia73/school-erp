/** One person's month: the figures it adds up to, and the calendar behind them. */
import type { AttendanceMark, AttendanceSummary } from '@erp/contracts'
import { MarkTag, Percentage } from '@/components/attendance/labels'
import { MarkLegend } from '@/components/attendance/register-grid'
import { Facts } from '@/components/shared/page'
import { cn } from '@/lib/utils'

export interface MonthCalendarDay {
  date: string
  kind: 'school_day' | 'sunday' | 'holiday' | 'outside_year'
  holidayName?: string
  /** True when the person was on the roster or the register that day. */
  on: boolean
  mark?: AttendanceMark
}

export function MonthFacts({ summary }: { summary: AttendanceSummary }) {
  return (
    <Facts
      columns={4}
      items={[
        { label: 'Attendance', value: <Percentage value={summary.percentage} /> },
        { label: 'Present', value: summary.present },
        { label: 'Absent', value: summary.absent },
        { label: 'Late', value: summary.late },
        { label: 'Leave', value: summary.leave },
        { label: 'Half day', value: summary.halfDay },
        { label: 'School days', value: summary.schoolDays },
        { label: 'Not marked', value: summary.unmarked },
      ]}
    />
  )
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** Monday to Sunday, so a week reads the way a wall calendar does. */
function leadingBlanks(firstDate: string): number {
  const day = new Date(`${firstDate}T00:00:00Z`).getUTCDay()
  return (day + 6) % 7
}

export function MonthCalendar({ days }: { days: MonthCalendarDay[] }) {
  const first = days[0]
  if (!first) return <p className="text-[13.5px] text-muted-foreground">There is no calendar for this month.</p>
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-7 gap-1.5">
        {WEEKDAYS.map((name) => (
          <div key={name} className="px-1 text-[12px] text-muted-foreground">{name}</div>
        ))}
        {Array.from({ length: leadingBlanks(first.date) }).map((_, index) => <div key={`blank-${index}`} />)}
        {days.map((day) => (
          <div
            key={day.date}
            className={cn('min-h-16 rounded-lg border p-1.5', day.kind !== 'school_day' && 'bg-muted/40')}
          >
            <div className="text-[12px] tabular-nums text-muted-foreground">{Number(day.date.slice(8, 10))}</div>
            <div className="mt-1 text-[12px]">
              {day.kind === 'holiday' ? (
                <span className="text-muted-foreground">{day.holidayName ?? 'Holiday'}</span>
              ) : day.kind === 'sunday' ? (
                <span className="text-muted-foreground">Sunday</span>
              ) : !day.on ? null : day.mark ? (
                <MarkTag mark={day.mark} />
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <MarkLegend />
    </div>
  )
}
