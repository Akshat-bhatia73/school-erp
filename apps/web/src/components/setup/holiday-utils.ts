import type { Holiday } from '@erp/shared'
import { formatDate } from '@/lib/utils'

const DAY = 86_400_000

/** Inclusive number of days a holiday covers. */
export function holidayDays(h: { startDate: string; endDate: string }) {
  const a = new Date(h.startDate).getTime()
  const b = new Date(h.endDate).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 1
  return Math.max(1, Math.round((b - a) / DAY) + 1)
}

/** "14 Apr 2026" for a single day, "18 May – 30 Jun 2026" for a range. */
export function holidayRange(h: { startDate: string; endDate: string }) {
  if (h.startDate === h.endDate) return formatDate(h.startDate)
  const start = new Date(h.startDate)
  const end = new Date(h.endDate)
  const startLabel = start.getFullYear() === end.getFullYear()
    ? start.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : formatDate(h.startDate)
  return `${startLabel} – ${formatDate(h.endDate)}`
}

/** Holiday days falling in each April→March month of the year starting `startYear`. */
export function monthCounts(holidays: Holiday[], startYear: number) {
  const months = Array.from({ length: 12 }, (_, i) => {
    const m = (3 + i) % 12
    const y = startYear + (3 + i >= 12 ? 1 : 0)
    return { key: `${y}-${m}`, label: new Date(y, m, 1).toLocaleDateString('en-IN', { month: 'short' }), year: y, month: m, days: 0 }
  })
  const index = new Map(months.map((m, i) => [m.key, i]))
  for (const h of holidays) {
    const d = new Date(h.startDate)
    const end = new Date(h.endDate)
    while (d <= end) {
      const i = index.get(`${d.getFullYear()}-${d.getMonth()}`)
      if (i !== undefined) months[i]!.days += 1
      d.setDate(d.getDate() + 1)
    }
  }
  return months
}
