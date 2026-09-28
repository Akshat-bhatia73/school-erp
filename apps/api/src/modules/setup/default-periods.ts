import type { z } from 'zod'
import type { BellPeriod } from '@erp/contracts'
import type { TenantConnection } from '../shared/audit.ts'

type Period = z.infer<typeof BellPeriod>

const PERIOD_MINUTES = 40
const BREAK_MINUTES = 15
const LUNCH_MINUTES = 30
const FIRST_BELL = 8 * 60

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/**
 * The day a new academic year starts with (decision 3 of the admin feedback
 * pass): eight periods of forty minutes from 08:00, a fifteen minute break
 * after period 2 and a thirty minute lunch after period 4. The office changes
 * it on the Periods screen; this only saves them from starting on a blank page.
 */
export function defaultPeriods(): Period[] {
  const periods: Period[] = []
  let at = FIRST_BELL
  const add = (name: string, type: Period['type'], minutes: number) => {
    periods.push({ index: periods.length, name, startTime: clock(at), endTime: clock(at + minutes), type })
    at += minutes
  }
  for (let period = 1; period <= 8; period += 1) {
    add(`Period ${period}`, 'period', PERIOD_MINUTES)
    if (period === 2) add('Short break', 'break', BREAK_MINUTES)
    if (period === 4) add('Lunch', 'lunch', LUNCH_MINUTES)
  }
  return periods
}

/** Monday to Saturday, the same periods every day. */
const WORKING_DAYS = [1, 2, 3, 4, 5, 6]

/**
 * Gives a year the default schedule when it has none, inside the caller's
 * transaction. The schedule names no class, which is how the schedule model
 * says "every class", so a class added later is covered too. Returns the new
 * schedule's id for the caller's single audit row, or null when the year
 * already had a schedule.
 */
export async function ensureDefaultPeriods(
  conn: TenantConnection,
  schoolId: string,
  academicYearId: string,
): Promise<{ id: string; periods: number } | null> {
  const existing = await conn.client.query(
    'SELECT 1 FROM bell_schedules WHERE school_id = $1 AND academic_year_id = $2 LIMIT 1',
    [schoolId, academicYearId],
  )
  if (existing.rowCount !== null && existing.rowCount > 0) return null
  const periods = defaultPeriods()
  const inserted = await conn.client.query<{ id: string }>(
    `INSERT INTO bell_schedules
       (school_id, academic_year_id, name, grade_ids, working_days, periods, saturday_period_count)
     VALUES ($1, $2, 'Regular', '{}'::uuid[], $3::smallint[], $4::jsonb, NULL)
     RETURNING id`,
    [schoolId, academicYearId, WORKING_DAYS, JSON.stringify(periods)],
  )
  const id = inserted.rows[0]?.id
  if (!id) throw new Error('the default bell schedule was not created')
  return { id, periods: periods.filter((period) => period.type === 'period').length }
}
