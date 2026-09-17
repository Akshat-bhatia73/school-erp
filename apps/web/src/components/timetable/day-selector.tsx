import { cn } from '@/lib/utils'

/** 1 = Monday … 6 = Saturday, the only days the timetable contracts allow. */
export const DAY_LABELS: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' }

export const WEEK_DAYS = [1, 2, 3, 4, 5, 6]

/** The day of the week a calendar date falls on, in the 1–6 numbering. Sunday answers 0. */
export function dayOfWeekFor(date: string): number {
  const parsed = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return 0
  const day = parsed.getDay()
  return day === 0 ? 0 : day
}

/**
 * Mobile day picker for the timetable. A 6x8 grid cannot be read on a phone, so mobile
 * shows one day at a time and this chooses which.
 */
export function DaySelector({ days, value, onChange, className }: { days: number[]; value: number; onChange: (d: number) => void; className?: string }) {
  return (
    <div role="tablist" aria-label="Day" className={cn('flex shrink-0 items-center gap-1.5 overflow-x-auto border-b bg-card px-3 py-2 no-scrollbar md:hidden', className)}>
      {days.map((d) => (
        <button
          key={d}
          type="button"
          role="tab"
          aria-selected={d === value}
          onClick={() => onChange(d)}
          className={cn(
            'h-8 shrink-0 rounded-full border px-3.5 text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            d === value ? 'border-transparent bg-foreground font-medium text-background' : 'bg-card text-muted-foreground',
          )}
        >
          {DAY_LABELS[d]}
        </button>
      ))}
    </div>
  )
}

/** Today when the school works today, otherwise the first working day. */
export function defaultDay(workingDays: number[]) {
  const today = new Date().getDay()
  return workingDays.includes(today) ? today : (workingDays[0] ?? 1)
}
