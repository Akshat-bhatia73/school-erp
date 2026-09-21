/** Timetable days are 1 (Monday) to 6 (Saturday); Sunday has no school day number. */
export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/** Today as a timetable day number, or null on a Sunday. */
export function todayDayOfWeek(now: Date = new Date()): number | null {
  const day = now.getDay()
  return day === 0 ? null : day
}

export function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek - 1] ?? `Day ${dayOfWeek}`
}

/** Short day names, indexed the same way as DAY_NAMES (1 = Monday). */
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

export function dayShort(dayOfWeek: number): string {
  return DAY_SHORT[dayOfWeek - 1] ?? `D${dayOfWeek}`
}
