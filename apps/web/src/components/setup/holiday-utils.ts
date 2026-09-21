import { formatDate } from '@/lib/utils'

const DAY = 86_400_000

/**
 * A 'YYYY-MM-DD' date as a local calendar date. `new Date('2026-08-15')` is midnight UTC, which is
 * the day before anywhere west of Greenwich, so every date here is built from its own parts.
 */
export function parseDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return new Date(NaN)
  return new Date(year, month - 1, day)
}

/** The April-March year today sits in: January to March belongs to the previous start year. */
export function currentStartYear() {
  const now = new Date()
  return now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear()
}

/** Inclusive number of days a holiday covers. */
export function holidayDays(h: { startDate: string; endDate: string }) {
  const a = parseDate(h.startDate).getTime()
  const b = parseDate(h.endDate).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 1
  return Math.max(1, Math.round((b - a) / DAY) + 1)
}

/** "14 Apr 2026" for a single day, "18 May – 30 Jun 2026" for a range. */
export function holidayRange(h: { startDate: string; endDate: string }) {
  if (h.startDate === h.endDate) return formatDate(h.startDate)
  const start = parseDate(h.startDate)
  const end = parseDate(h.endDate)
  const startLabel = start.getFullYear() === end.getFullYear()
    ? start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : formatDate(h.startDate)
  return `${startLabel} – ${formatDate(h.endDate)}`
}

/** Holiday days falling in each April→March month of the year starting `startYear`. */
export function monthCounts(holidays: Array<{ startDate: string; endDate: string }>, startYear: number) {
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = (3 + i) % 12
    const y = startYear + (3 + i >= 12 ? 1 : 0)
    return { key: `${y}-${m}`, label: new Date(y, m, 1).toLocaleDateString('en-IN', { month: 'short' }), year: y, month: m, days: 0 }
  })
  const index = new Map(months.map((m, i) => [m.key, i]))
  for (const h of holidays) {
    const d = parseDate(h.startDate)
    const end = parseDate(h.endDate)
    while (d <= end) {
      const i = index.get(`${d.getFullYear()}-${d.getMonth()}`)
      if (i !== undefined) months[i]!.days += 1
      d.setDate(d.getDate() + 1)
    }
  }
  return months
}
