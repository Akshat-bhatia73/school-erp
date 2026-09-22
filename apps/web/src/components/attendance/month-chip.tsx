/** Moving one month or one day at a time, the way every register screen does it. */
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Today in the browser, as `YYYY-MM-DD`. The server still decides what today means for a write. */
export function todayIso(): string {
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function monthOf(dateIso: string): string {
  return dateIso.slice(0, 7)
}

export function currentMonth(): string {
  return monthOf(todayIso())
}

/** `2026-09` a few months either way. */
export function shiftMonth(month: string, by: number): string {
  const year = Number(month.slice(0, 4))
  const index = Number(month.slice(5, 7)) - 1 + by
  const shifted = new Date(Date.UTC(year, index, 1))
  return `${shifted.getUTCFullYear()}-${`${shifted.getUTCMonth() + 1}`.padStart(2, '0')}`
}

export function shiftDate(dateIso: string, by: number): string {
  const moved = new Date(`${dateIso}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + by)
  return moved.toISOString().slice(0, 10)
}

/** "September 2026". */
export function monthLabel(month: string): string {
  const index = Number(month.slice(5, 7)) - 1
  return `${MONTH_NAMES[index] ?? month} ${month.slice(0, 4)}`
}

/** The months of an Indian academic year named "2026-27": April to the following March. */
export function monthsOfYearName(name: string): string[] {
  const match = /^(\d{4})\s*[-/]\s*(\d{2,4})$/.exec(name.trim())
  if (!match) return []
  const start = Number(match[1])
  return Array.from({ length: 12 }, (_, i) => shiftMonth(`${start}-04`, i))
}

const arrow = 'inline-flex size-8 shrink-0 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

/** Previous month, the month's name, next month. */
export function MonthChip({ month, onChange, min, max, className }: {
  month: string
  onChange: (month: string) => void
  /** The earliest and latest month that may be asked for, when the screen knows them. */
  min?: string
  max?: string
  className?: string
}) {
  const previous = shiftMonth(month, -1)
  const next = shiftMonth(month, 1)
  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      <button type="button" aria-label="Previous month" disabled={min !== undefined && previous < min} onClick={() => onChange(previous)} className={arrow}>
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-36 text-center text-[13.5px] font-medium">{monthLabel(month)}</span>
      <button type="button" aria-label="Next month" disabled={max !== undefined && next > max} onClick={() => onChange(next)} className={arrow}>
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}

/** Previous day, the date, next day, and a way back to today. */
export function DateChip({ date, onChange, max, className }: {
  date: string
  onChange: (date: string) => void
  max?: string
  className?: string
}) {
  const next = shiftDate(date, 1)
  const today = todayIso()
  return (
    <div className={cn('inline-flex items-center gap-1.5', className)}>
      <button type="button" aria-label="Previous day" onClick={() => onChange(shiftDate(date, -1))} className={arrow}>
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-32 text-center text-[13.5px] font-medium tabular-nums">{new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      <button type="button" aria-label="Next day" disabled={max !== undefined && next > max} onClick={() => onChange(next)} className={arrow}>
        <ChevronRight className="size-4" />
      </button>
      {date !== today && (
        <button type="button" onClick={() => onChange(today)} className="inline-flex h-8 shrink-0 items-center rounded-full border bg-card px-3 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          Today
        </button>
      )}
    </div>
  )
}
