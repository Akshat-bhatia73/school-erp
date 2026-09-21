import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  BellSchedule,
  BellScheduleList,
  TimetableBellScheduleRequest,
  TimetableBellScheduleUpdateRequest,
  TimetableYearQuery,
} from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import { ApiFailure, authorizeSchoolAction, lockSchool, writeAudit } from '../shared/index.ts'
import { bumpVersion } from '../shared/version.ts'
import {
  assertYear,
  queryRows,
  requireUuidParam,
  requireUuidValue,
  type ModuleConnection,
} from './shared.ts'

interface BellRow {
  readonly id: string
  readonly academicYearId: string
  readonly name: string
  readonly gradeIds: string[]
  readonly workingDays: (number | string)[]
  readonly periods: unknown
  readonly saturdayPeriodCount: number | null
  readonly version: number
}

/** The rows a write returns: the grade links are written separately. */
type BellWriteRow = Omit<BellRow, 'gradeIds'>

function toBellSchedule(schoolId: string, row: BellRow) {
  return {
    id: row.id,
    schoolId,
    academicYearId: row.academicYearId,
    name: row.name,
    gradeIds: row.gradeIds,
    workingDays: row.workingDays.map(Number),
    periods: row.periods,
    ...(row.saturdayPeriodCount === null ? {} : { saturdayPeriodCount: Number(row.saturdayPeriodCount) }),
    version: Number(row.version),
  }
}

/**
 * The grades a schedule covers live in their own table; the column on
 * bell_schedules is held empty by a database constraint.
 */
const GRADE_IDS = sql`(SELECT coalesce(array_agg(bsg.grade_id::text), '{}')
      FROM bell_schedule_grades bsg
      WHERE bsg.school_id = bell_schedules.school_id AND bsg.bell_schedule_id = bell_schedules.id) AS "gradeIds"`

const SELECT_BELL = sql`SELECT id::text AS "id", academic_year_id::text AS "academicYearId", name,
      ${GRADE_IDS}, working_days AS "workingDays", periods,
      saturday_period_count AS "saturdayPeriodCount", version
    FROM bell_schedules`

async function replaceGradeLinks(
  conn: ModuleConnection,
  schoolId: string,
  bellScheduleId: string,
  gradeIds: readonly string[],
): Promise<void> {
  await conn.client.query(
    'DELETE FROM bell_schedule_grades WHERE school_id = $1 AND bell_schedule_id = $2',
    [schoolId, bellScheduleId],
  )
  for (const gradeId of gradeIds) {
    await conn.client.query(
      'INSERT INTO bell_schedule_grades(school_id, bell_schedule_id, grade_id) VALUES ($1, $2, $3)',
      [schoolId, bellScheduleId, gradeId],
    )
  }
}

function dayArray(days: readonly number[]) {
  if (days.length === 0) return sql`'{}'::smallint[]`
  return sql`ARRAY[${sql.join(days.map((day) => sql`${day}::smallint`), sql`, `)}]::smallint[]`
}

async function listForYear(conn: ModuleConnection, schoolId: string, yearId: string): Promise<BellRow[]> {
  return queryRows<BellRow>(
    conn,
    sql`${SELECT_BELL} WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${yearId}::uuid ORDER BY name`,
  )
}

/** Every grade a schedule claims must be a grade of this school. */
async function assertGrades(conn: ModuleConnection, schoolId: string, gradeIds: readonly string[]): Promise<void> {
  if (gradeIds.length === 0) return
  const checked = gradeIds.map(requireUuidValue)
  const rows = await queryRows<{ total: number }>(
    conn,
    sql`SELECT count(*)::int AS total FROM grades WHERE school_id = ${schoolId}::uuid
          AND id IN (${sql.join(checked.map((id) => sql`${id}::uuid`), sql`, `)})`,
  )
  if ((rows[0]?.total ?? 0) !== new Set(checked).size) throw new ApiFailure('INVALID_REQUEST')
}

export function registerBellScheduleRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  // A bell schedule is school setup rather than a per-teacher record: it is the
  // ringing of the bells for a wing, shared by everyone in the building, so it
  // is read school-wide once timetable.read is held anywhere. OPERATION_COVERAGE
  // says "matched scope"; the plan cannot express that here, because
  // timetable.read is a permission over timetable entries and no read plan can
  // be built for the bell_schedule table. The only thing disclosed beyond the
  // caller's own classes is the period clock and the grade ids it covers.
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/bell-schedules',
    permission: 'timetable.read',
    query: TimetableYearQuery,
    response: BellScheduleList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.read')
        const rows = await listForYear(conn, context.schoolId, requireUuidValue(query.academicYearId))
        return rows.map((row) => toBellSchedule(context.schoolId, row))
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/bell-schedules/for-grade/:gradeId',
    permission: 'timetable.read',
    query: TimetableYearQuery,
    response: BellSchedule,
    handler: async ({ context, query, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.read')
        const gradeId = requireUuidParam(param('gradeId'))
        const rows = await listForYear(conn, context.schoolId, requireUuidValue(query.academicYearId))
        // A named grade wins; the schedule that names no grade is the fallback.
        const match = rows.find((row) => row.gradeIds.includes(gradeId)) ?? rows.find((row) => row.gradeIds.length === 0)
        if (!match) throw new ApiFailure('RESOURCE_NOT_FOUND')
        return toBellSchedule(context.schoolId, match)
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/timetable/bell-schedules',
    permission: 'timetable.manage_periods',
    body: TimetableBellScheduleRequest,
    response: BellSchedule,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.manage_periods')
        await assertYear(conn, context.schoolId, requireUuidValue(body.academicYearId))
        await assertGrades(conn, context.schoolId, body.gradeIds)
        await lockSchool(conn, context.schoolId)
        const inserted = await queryRows<BellWriteRow>(
          conn,
          sql`INSERT INTO bell_schedules
                (school_id, academic_year_id, name, grade_ids, working_days, periods, saturday_period_count)
              VALUES (${context.schoolId}::uuid, ${body.academicYearId}::uuid, ${body.name}::text,
                '{}'::uuid[], ${dayArray(body.workingDays)},
                ${JSON.stringify(body.periods)}::jsonb, ${body.saturdayPeriodCount ?? null}::int)
              RETURNING id::text AS "id", academic_year_id::text AS "academicYearId", name,
                working_days AS "workingDays", periods, saturday_period_count AS "saturdayPeriodCount",
                version`,
        )
        const row = inserted[0]
        if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')
        await replaceGradeLinks(conn, context.schoolId, row.id, body.gradeIds)
        await writeAudit(conn, context, {
          action: 'timetable.manage_periods',
          targetType: 'bell_schedule',
          targetId: row.id,
          summary: 'Created a bell schedule for an academic year',
          safeChanges: { periods: body.periods.length, workingDays: body.workingDays.length },
        })
        return toBellSchedule(context.schoolId, { ...row, gradeIds: [...body.gradeIds] })
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/timetable/bell-schedules/:bellScheduleId',
    permission: 'timetable.manage_periods',
    body: TimetableBellScheduleUpdateRequest,
    response: BellSchedule,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.manage_periods')
        const id = requireUuidParam(param('bellScheduleId'))
        await assertYear(conn, context.schoolId, requireUuidValue(body.academicYearId))
        await assertGrades(conn, context.schoolId, body.gradeIds)
        await lockSchool(conn, context.schoolId)
        // The version in the WHERE clause is the whole concurrency check, so an
        // editor who was looking at an older schedule is told somebody saved
        // first instead of quietly overwriting them.
        await bumpVersion(conn, 'bell_schedules', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: {
            academic_year_id: body.academicYearId,
            name: body.name,
            // The driver sends a number array as an array literal, which the
            // smallint[] column accepts as it is.
            working_days: [...body.workingDays],
            periods: JSON.stringify(body.periods),
            saturday_period_count: body.saturdayPeriodCount ?? null,
          },
        })
        const updated = await queryRows<BellWriteRow>(
          conn,
          sql`SELECT id::text AS "id", academic_year_id::text AS "academicYearId", name,
                working_days AS "workingDays", periods, saturday_period_count AS "saturdayPeriodCount",
                version
              FROM bell_schedules WHERE school_id = ${context.schoolId}::uuid AND id = ${id}::uuid`,
        )
        const row = updated[0]
        if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await replaceGradeLinks(conn, context.schoolId, row.id, body.gradeIds)
        await writeAudit(conn, context, {
          action: 'timetable.manage_periods',
          targetType: 'bell_schedule',
          targetId: row.id,
          summary: 'Updated a bell schedule',
          safeChanges: { periods: body.periods.length, workingDays: body.workingDays.length },
        })
        return toBellSchedule(context.schoolId, { ...row, gradeIds: [...body.gradeIds] })
      }),
  })
}
