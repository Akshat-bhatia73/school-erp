import { sql } from 'drizzle-orm'
import { BellPeriod } from '@erp/contracts'
import type { AuthzConnection } from '@erp/authz'
import type { z } from 'zod'
import { rows } from './queries.ts'

export type Period = z.infer<typeof BellPeriod>

export interface Schedule {
  readonly id: string
  readonly gradeIds: readonly string[]
  readonly periods: readonly Period[]
  readonly workingDays: readonly number[]
  readonly saturdayPeriodCount: number | null
}

/**
 * The bell schedules of one academic year. A bell schedule is school setup
 * rather than a person's record: it is when the bells ring for a wing, shared
 * by everyone in the building, so it is read for this school once the caller
 * holds timetable.read somewhere, exactly as the bell schedule route does.
 */
export async function loadSchedules(
  conn: AuthzConnection,
  schoolId: string,
  academicYearId: string,
): Promise<Schedule[]> {
  const found = await rows<{
    id: string
    grade_ids: string[] | null
    linked_grade_ids: string[] | null
    periods: unknown
    working_days: number[] | null
    saturday_period_count: number | null
  }>(
    conn,
    sql`SELECT bs.id AS id, bs.grade_ids::text[] AS grade_ids,
               (SELECT coalesce(array_agg(bsg.grade_id::text), '{}')
                  FROM bell_schedule_grades bsg
                 WHERE bsg.school_id = bs.school_id AND bsg.bell_schedule_id = bs.id) AS linked_grade_ids,
               bs.periods AS periods, bs.working_days::int[] AS working_days,
               bs.saturday_period_count::int AS saturday_period_count
          FROM bell_schedules bs
         WHERE bs.school_id = ${schoolId}::uuid AND bs.academic_year_id = ${academicYearId}::uuid
         ORDER BY bs.name`,
  )
  return found.map((row) => {
    const parsed = BellPeriod.array().safeParse(row.periods)
    const gradeIds = new Set([...(row.grade_ids ?? []), ...(row.linked_grade_ids ?? [])])
    return {
      id: row.id,
      gradeIds: [...gradeIds],
      periods: parsed.success ? [...parsed.data].sort((a, b) => a.index - b.index) : [],
      workingDays: (row.working_days ?? []).map(Number),
      saturdayPeriodCount:
        row.saturday_period_count === null ? null : Number(row.saturday_period_count),
    }
  })
}

/** The schedule that names this grade, or the one that names no grade at all. */
export function scheduleForGrade(
  schedules: readonly Schedule[],
  gradeId: string,
): Schedule | null {
  return (
    schedules.find((schedule) => schedule.gradeIds.includes(gradeId)) ??
    schedules.find((schedule) => schedule.gradeIds.length === 0) ??
    null
  )
}

/** How many teaching periods a day of the week holds under this schedule. */
export function teachingPeriodsOn(schedule: Schedule, day: number): number {
  if (!schedule.workingDays.includes(day)) return 0
  const teaching = schedule.periods.filter((period) => period.type === 'period')
  if (day === 6 && schedule.saturdayPeriodCount !== null) {
    return Math.min(teaching.length, schedule.saturdayPeriodCount)
  }
  return teaching.length
}

/** Every slot a section is expected to fill in a week. */
export function weeklyTeachingSlots(schedule: Schedule): number {
  return schedule.workingDays.reduce((total, day) => total + teachingPeriodsOn(schedule, day), 0)
}
