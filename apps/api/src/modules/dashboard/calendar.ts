import { sql } from 'drizzle-orm'
import { holidays as holidaysTable } from '@erp/db/schema'
import { AuthorizationError, type AuthzConnection } from '@erp/authz'
import type { AuthorizedReadPlan } from '@erp/contracts/server'
import type { DashboardDay, DashboardHoliday } from '@erp/contracts'
import { label, predicateFor, rows } from './queries.ts'

/**
 * A block the caller may not read is left out of the response rather than
 * answered with a zero. Only a denial is swallowed: a mis-wired permission or
 * resource type raises another code and must fail loudly.
 */
export async function optionalBlock<T>(build: () => Promise<T>): Promise<T | undefined> {
  try {
    return await build()
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'ACCESS_DENIED') return undefined
    throw error
  }
}

/** An ISO date, moved by whole days, without touching the local clock. */
export function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

/** 0 for Sunday, as the contract counts days. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/**
 * The month and day a birthday falls on in one particular year. A child born
 * on 29 February has no birthday in a common year, so the school marks it on
 * 28 February rather than skipping it for three years out of four.
 */
export function birthdayMonthDay(born: string, onDate: string): string {
  if (born !== '02-29') return born
  const year = Number(onDate.slice(0, 4))
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return leap ? '02-29' : '02-28'
}

/** 'YYYY-MM' for the calendar month a date falls in. */
export function monthKey(date: string): string {
  return date.slice(0, 7)
}

/**
 * Today in the school's own timezone. A school in India must not see its day
 * roll over at a server's midnight, so the instant the request carries is
 * formatted in the timezone the school profile keeps.
 */
export async function todayInSchool(
  conn: AuthzConnection,
  schoolId: string,
  now: string,
): Promise<string> {
  const [row] = await rows<{ timezone: string | null }>(
    conn,
    sql`SELECT timezone FROM schools WHERE id = ${schoolId}::uuid`,
  )
  const zone = row?.timezone ?? 'Asia/Kolkata'
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(now))
  } catch {
    // A school row with an unknown timezone must not take the dashboard down.
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(now))
  }
}

type HolidayRow = {
  id: string
  name: string
  start_date: string
  end_date: string
  type: string
}

const HOLIDAY_TYPES = ['national', 'festival', 'school', 'vacation'] as const

function toHoliday(row: HolidayRow): DashboardHoliday {
  const type = HOLIDAY_TYPES.find((value) => value === row.type) ?? 'school'
  return {
    id: row.id,
    name: label(row.name),
    startDate: row.start_date,
    endDate: row.end_date,
    type,
  }
}

/** Every holiday that touches the window, through the caller's own plan. */
async function holidaysBetween(
  conn: AuthzConnection,
  plan: AuthorizedReadPlan,
  from: string,
  to: string,
): Promise<DashboardHoliday[]> {
  const found = await rows<HolidayRow>(
    conn,
    sql`SELECT ${holidaysTable.id} AS id, ${holidaysTable.name} AS name,
               ${holidaysTable.startDate}::text AS start_date,
               ${holidaysTable.endDate}::text AS end_date,
               ${holidaysTable.type} AS type
          FROM ${holidaysTable}
         WHERE ${predicateFor(plan)}
           AND ${holidaysTable.endDate} >= ${from}::date
           AND ${holidaysTable.startDate} <= ${to}::date
         ORDER BY start_date, name
         LIMIT 200`,
  )
  return found.map(toHoliday)
}

/** The holidays inside the next thirty days, the ones a screen lists. */
export function holidaysAhead(
  found: readonly DashboardHoliday[],
  date: string,
): DashboardHoliday[] {
  const limit = addDays(date, 30)
  return found.filter((holiday) => holiday.endDate >= date && holiday.startDate <= limit)
}

/** How far ahead the next working day is looked for. */
const LOOKAHEAD_DAYS = 60

export interface CalendarView {
  readonly day: DashboardDay
  /** Holidays in the next thirty days; empty when the caller may not read them. */
  readonly holidays: DashboardHoliday[]
}

/**
 * The day a dashboard is about. Sunday is the weekly off, a holiday covers a
 * range of dates, and anything else is a school day. A caller who may not read
 * the calendar still gets an honest answer built from Sundays alone, rather
 * than a school day that is really a holiday they cannot see.
 */
export async function buildCalendar(
  conn: AuthzConnection,
  plan: AuthorizedReadPlan | undefined,
  date: string,
): Promise<CalendarView> {
  const window = plan
    ? await holidaysBetween(conn, plan, date, addDays(date, LOOKAHEAD_DAYS))
    : []
  const covering = window.find(
    (holiday) => holiday.startDate <= date && holiday.endDate >= date,
  )
  const weekday = dayOfWeek(date)
  const kind = weekday === 0 ? 'sunday' : covering ? 'holiday' : 'school_day'

  let nextSchoolDay: DashboardDay['nextSchoolDay']
  for (let ahead = 1; ahead <= LOOKAHEAD_DAYS; ahead += 1) {
    const candidate = addDays(date, ahead)
    const weekdayAhead = dayOfWeek(candidate)
    if (weekdayAhead === 0) continue
    if (window.some((holiday) => holiday.startDate <= candidate && holiday.endDate >= candidate)) {
      continue
    }
    nextSchoolDay = { date: candidate, dayOfWeek: weekdayAhead }
    break
  }

  return {
    day: {
      date,
      dayOfWeek: weekday,
      kind,
      ...(covering ? { holidayName: covering.name } : {}),
      ...(nextSchoolDay ? { nextSchoolDay } : {}),
    },
    holidays: holidaysAhead(window, date),
  }
}

export interface CurrentYear {
  readonly id: string
  readonly name: string
  readonly startDate: string
  readonly endDate: string
}

/**
 * The academic year the school is running. Like the bell schedule, a year is
 * school setup rather than a person's record: a teacher and a parent hold no
 * academic_years.read grant, yet every other block on their dashboard is
 * meaningless without knowing which year "now" is. It is read for this school
 * only, and nothing of it leaves the response beyond its id and name.
 */
export async function currentAcademicYear(
  conn: AuthzConnection,
  schoolId: string,
): Promise<CurrentYear | null> {
  const [row] = await rows<{
    id: string
    name: string
    start_date: string
    end_date: string
  }>(
    conn,
    sql`SELECT id, name, start_date::text AS start_date, end_date::text AS end_date
          FROM academic_years
         WHERE school_id = ${schoolId}::uuid AND status = 'current'
         ORDER BY start_date DESC
         LIMIT 1`,
  )
  if (!row) return null
  return { id: row.id, name: label(row.name), startDate: row.start_date, endDate: row.end_date }
}
