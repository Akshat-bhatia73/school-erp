/** Small formatting helpers for the dashboard blocks. Indian style, plain English. */

import type { TagColor } from '@/components/shared/tag'

const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'] as const

function parseCalendarDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d))
  return Number.isNaN(date.getTime()) ? null : date
}

/** '2026-09-21' -> 'Monday, 21 Sept' */
export function longDayDate(iso: string): string {
  const date = parseCalendarDate(iso)
  if (!date) return iso
  return `${LONG_DAYS[date.getDay()]}, ${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}`
}

/** '08:00' -> '8:00 am', '13:05' -> '1:05 pm' */
export function timeLabel(time: string): string {
  const match = /^(\d{1,2}):(\d{2})/.exec(time)
  if (!match) return time
  const hours = Number(match[1])
  const minutes = match[2]
  if (hours > 23 || Number(minutes) > 59) return time
  const suffix = hours < 12 ? 'am' : 'pm'
  const display = hours % 12 === 0 ? 12 : hours % 12
  return `${display}:${minutes} ${suffix}`
}

/** '2026-04' -> 'Apr' */
export function monthShort(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return month
  return SHORT_MONTHS[Number(match[2]) - 1] ?? month
}

/** The twelve 'YYYY-MM' keys of an academic year, April to March. */
export function academicMonths(yearStartIso: string): string[] {
  const date = parseCalendarDate(yearStartIso)
  const startYear = date ? date.getFullYear() : new Date().getFullYear()
  const startMonth = date ? date.getMonth() : 3
  const keys: string[] = []
  for (let i = 0; i < 12; i++) {
    const year = startYear + Math.floor((startMonth + i) / 12)
    const month = ((startMonth + i) % 12) + 1
    keys.push(`${year}-${String(month).padStart(2, '0')}`)
  }
  return keys
}

/** plural(1, 'teacher', 'teachers') -> '1 teacher' */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** 'No teachers' / '1 teacher' / '3 teachers' */
export function countOrNone(count: number, one: string, many: string): string {
  return count === 0 ? `No ${many}` : plural(count, one, many)
}

const LONG_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const

/** '2026-09-20' -> 'Sunday' */
export function weekdayName(iso: string): string {
  const date = parseCalendarDate(iso)
  return date ? LONG_DAYS[date.getDay()]! : iso
}

/** '2026-09-20' -> '20 September 2026' */
export function longDate(iso: string): string {
  const date = parseCalendarDate(iso)
  if (!date) return iso
  return `${date.getDate()} ${LONG_MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/** '2026-09-20' -> { day: '20', month: 'Sept' } for a calendar tile. */
export function calendarParts(iso: string): { day: string; month: string } {
  const date = parseCalendarDate(iso)
  if (!date) return { day: '', month: iso }
  return { day: String(date.getDate()), month: SHORT_MONTHS[date.getMonth()]! }
}

/** '2026-09' -> 'September 2026' */
export function monthLong(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return month
  const name = LONG_MONTHS[Number(match[2]) - 1]
  return name ? `${name} ${match[1]}` : month
}

/**
 * A stable colour for a subject that never lands on an alert hue (red, orange) or grey,
 * so a cover duty's orange stays the only warning colour on a timetable.
 * Same hash as `colorFor`, a narrower palette.
 */
export function subjectColor(name: string): TagColor {
  const palette: TagColor[] = ['blue', 'teal', 'purple', 'indigo', 'cyan', 'green', 'pink', 'yellow']
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return palette[h % palette.length]!
}
