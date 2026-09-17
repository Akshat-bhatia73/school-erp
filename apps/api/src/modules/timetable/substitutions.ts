import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  AbsentTeacherPeriodList,
  EmptySuccess,
  NotificationMarkResult,
  Substitution,
  SubstitutionDay,
  TimetableAbsentPeriodQuery,
  TimetableDateQuery,
  TimetableNotifyRequest,
  TimetableSubstitutionRequest,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { planPredicate, scopedTableFor } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  authorizeSchoolAction,
  lockSchool,
  protectedRoute,
  readPlan,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  CELL_COLUMNS,
  CELL_JOINS,
  aggregateAllowedActions,
  assertSectionInYear,
  assertStaff,
  assertSubject,
  personName,
  queryRows,
  requireUuidParam,
  requireUuidValue,
  sectionName,
  toCell,
  yearForDate,
  type CellRow,
  type ModuleConnection,
} from './shared.ts'

interface SubstitutionRow {
  readonly id: string
  readonly date: string
  readonly periodIndex: number
  readonly notified: boolean
  readonly sectionId: string
  readonly sectionName: string
  readonly gradeName: string
  readonly subjectId: string
  readonly subjectName: string
  readonly absentId: string
  readonly absentFirstName: string
  readonly absentLastName: string | null
  readonly substituteId: string | null
  readonly substituteFirstName: string | null
  readonly substituteLastName: string | null
}

function toSubstitution(row: SubstitutionRow) {
  const substituteName = personName(row.substituteFirstName, row.substituteLastName)
  return {
    id: row.id,
    date: row.date,
    section: { id: row.sectionId, name: sectionName(row.gradeName, row.sectionName) },
    subject: { id: row.subjectId, name: row.subjectName },
    absentTeacher: { id: row.absentId, name: personName(row.absentFirstName, row.absentLastName) },
    substituteTeacher:
      row.substituteId === null || substituteName === '' ? null : { id: row.substituteId, name: substituteName },
    periodIndex: Number(row.periodIndex),
    notified: row.notified === true,
  }
}

const SUBSTITUTION_SELECT = sql`SELECT substitutions.id::text AS "id", substitutions.date::text AS "date",
      substitutions.period_index::int AS "periodIndex", substitutions.notified AS "notified",
      sections.id::text AS "sectionId", sections.name AS "sectionName", grades.name AS "gradeName",
      subjects.id::text AS "subjectId", subjects.name AS "subjectName",
      absent_staff.id::text AS "absentId", absent_staff.first_name AS "absentFirstName",
      absent_staff.last_name AS "absentLastName",
      substitute_staff.id::text AS "substituteId", substitute_staff.first_name AS "substituteFirstName",
      substitute_staff.last_name AS "substituteLastName"
    FROM substitutions
    JOIN sections ON sections.school_id = substitutions.school_id AND sections.id = substitutions.section_id
    JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
    JOIN subjects ON subjects.school_id = substitutions.school_id AND subjects.id = substitutions.subject_id
    JOIN staff absent_staff ON absent_staff.school_id = substitutions.school_id
      AND absent_staff.id = substitutions.absent_staff_id
    LEFT JOIN staff substitute_staff ON substitute_staff.school_id = substitutions.school_id
      AND substitute_staff.id = substitutions.substitute_staff_id`

export function registerSubstitutionRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/substitutions',
    permission: 'timetable.read',
    query: TimetableDateQuery,
    response: SubstitutionDay,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const visible = await substitutionPredicate(conn, context)
        const rows = await queryRows<SubstitutionRow>(
          conn,
          sql`${SUBSTITUTION_SELECT}
              WHERE substitutions.school_id = ${context.schoolId}::uuid
                AND substitutions.date = ${query.date}::date AND ${visible}
              ORDER BY substitutions.period_index, substitutions.id`,
        )
        return {
          substitutions: rows.map(toSubstitution),
          allowedActions: await aggregateAllowedActions(conn, context, 'substitution'),
        }
      }),
  })

  // OPERATION_COVERAGE names timetable.read / school for this read. It is
  // gated on timetable.manage_substitutions instead, which is strictly
  // stricter: the query names any staff member, so only the people who arrange
  // cover may ask where somebody else was meant to be.
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/substitutions/absent-periods',
    permission: 'timetable.manage_substitutions',
    query: TimetableAbsentPeriodQuery,
    response: AbsentTeacherPeriodList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.manage_substitutions')
        const staffId = requireUuidValue(query.staffId)
        const yearId = await yearForDate(conn, context.schoolId, query.date)
        const rows = await queryRows<CellRow>(
          conn,
          sql`SELECT ${CELL_COLUMNS} ${CELL_JOINS}
              WHERE timetable_entries.school_id = ${context.schoolId}::uuid
                AND timetable_entries.academic_year_id = ${yearId}::uuid
                AND timetable_entries.staff_id = ${staffId}::uuid
                AND timetable_entries.day_of_week = extract(isodow from ${query.date}::date)::int
              ORDER BY timetable_entries.period_index`,
        )
        return rows.map(toCell)
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/timetable/substitutions',
    permission: 'timetable.manage_substitutions',
    body: TimetableSubstitutionRequest,
    response: Substitution,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.manage_substitutions')
        const sectionId = requireUuidValue(body.sectionId)
        const subjectId = requireUuidValue(body.subjectId)
        const absentStaffId = requireUuidValue(body.absentStaffId)
        const yearId = await yearForDate(conn, context.schoolId, body.date)
        await assertSectionInYear(conn, context.schoolId, sectionId, yearId)
        await assertSubject(conn, context.schoolId, subjectId)
        await assertStaff(conn, context.schoolId, absentStaffId)
        const substituteStaffId = body.substituteStaffId === undefined ? null : requireUuidValue(body.substituteStaffId)
        if (substituteStaffId !== null) {
          await assertStaff(conn, context.schoolId, substituteStaffId)
          await assertSubstituteIsFree(conn, context.schoolId, {
            staffId: substituteStaffId,
            yearId,
            date: body.date,
            periodIndex: body.periodIndex,
          })
        }
        await lockSchool(conn, context.schoolId)
        const inserted = await queryRows<{ id: string }>(
          conn,
          sql`INSERT INTO substitutions
                (school_id, date, section_id, period_index, subject_id, absent_staff_id, substitute_staff_id, reason)
              VALUES (${context.schoolId}::uuid, ${body.date}::date, ${sectionId}::uuid, ${body.periodIndex},
                ${subjectId}::uuid, ${absentStaffId}::uuid, ${substituteStaffId}::uuid, ${body.reason ?? null}::text)
              RETURNING id::text AS "id"`,
        )
        const id = inserted[0]?.id
        if (!id) throw new ApiFailure('SERVICE_UNAVAILABLE')
        await writeAudit(conn, context, {
          action: 'timetable.manage_substitutions',
          targetType: 'substitution',
          targetId: id,
          summary: 'Arranged cover for one period of one class',
          safeChanges: { periodIndex: body.periodIndex, substituteNamed: substituteStaffId !== null },
        })
        const rows = await queryRows<SubstitutionRow>(
          conn,
          sql`${SUBSTITUTION_SELECT} WHERE substitutions.school_id = ${context.schoolId}::uuid
                AND substitutions.id = ${id}::uuid`,
        )
        const row = rows[0]
        if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')
        return toSubstitution(row)
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/timetable/substitutions/:substitutionId',
    permission: 'timetable.manage_substitutions',
    response: EmptySuccess,
    successStatus: 204,
    handler: async ({ context, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.manage_substitutions')
        const id = requireUuidParam(param('substitutionId'))
        await lockSchool(conn, context.schoolId)
        const removed = await queryRows<{ id: string }>(
          conn,
          sql`DELETE FROM substitutions WHERE school_id = ${context.schoolId}::uuid AND id = ${id}::uuid
              RETURNING id::text AS "id"`,
        )
        if (!removed[0]) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await writeAudit(conn, context, {
          action: 'timetable.manage_substitutions',
          targetType: 'substitution',
          targetId: id,
          summary: 'Removed a cover arrangement',
        })
        return null
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/timetable/substitutions/notify',
    permission: 'timetable.notify_substitutions',
    body: TimetableNotifyRequest,
    response: NotificationMarkResult,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.notify_substitutions')
        await lockSchool(conn, context.schoolId)
        const marked = await queryRows<{ id: string }>(
          conn,
          sql`UPDATE substitutions SET notified = true, updated_at = now()
              WHERE school_id = ${context.schoolId}::uuid AND date = ${body.date}::date AND notified = false
              RETURNING id::text AS "id"`,
        )
        // A day with nothing left to notify is not a write, so it leaves no
        // audit row: the log records changes, not attempts.
        if (marked.length > 0) {
          await writeAudit(conn, context, {
            action: 'timetable.notify_substitutions',
            targetType: 'substitution',
            targetId: null,
            summary: 'Marked one day of cover arrangements as notified',
            safeChanges: { queued: marked.length },
          })
        }
        return { queued: marked.length }
      }),
  })
}

/**
 * A substitution is visible when the period it covers is visible, because the
 * two describe the same lesson. Everything the caller may see - their own
 * periods through the self scope, their classes, their children's class, and
 * every deny exception that removes one - comes from the shared plan applied
 * to the entry table, so the list can never widen what the grid refuses.
 */
async function substitutionPredicate(conn: ModuleConnection, context: RequestContext) {
  const table = scopedTableFor('timetable')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const plan = await readPlan(conn, context, 'timetable.read', 'timetable')
  const predicate = planPredicate(plan, table)
  return sql`EXISTS (SELECT 1 FROM timetable_entries
      WHERE timetable_entries.school_id = substitutions.school_id
        AND timetable_entries.section_id = substitutions.section_id
        AND timetable_entries.period_index = substitutions.period_index
        AND timetable_entries.day_of_week = extract(isodow from substitutions.date)::int
        AND ${predicate})`
}

/** A stand-in who is already teaching, or already covering, is not free. */
async function assertSubstituteIsFree(
  conn: ModuleConnection,
  schoolId: string,
  input: { staffId: string; yearId: string; date: string; periodIndex: number },
): Promise<void> {
  const clashes = await queryRows<{ ok: number }>(
    conn,
    sql`SELECT 1 AS ok FROM timetable_entries
         WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${input.yearId}::uuid
           AND staff_id = ${input.staffId}::uuid AND period_index = ${input.periodIndex}
           AND day_of_week = extract(isodow from ${input.date}::date)::int
        UNION ALL
        SELECT 1 AS ok FROM substitutions
         WHERE school_id = ${schoolId}::uuid AND date = ${input.date}::date
           AND period_index = ${input.periodIndex} AND substitute_staff_id = ${input.staffId}::uuid`,
  )
  if (clashes.length > 0) throw new ApiFailure('INVALID_REQUEST')
}
