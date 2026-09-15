import { sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import {
  AvailableTeacherSuggestionList,
  BellPeriod,
  EmptySuccess,
  SectionTimetable,
  StaffTimetable,
  TeacherLoadList,
  TimetableConflictList,
  TimetableEntry,
  TimetableEntryRequest,
  TimetableEntrySlotQuery,
  TimetableFreeTeacherQuery,
  TimetableGenerateRequest,
  TimetableGenerationResult,
  TimetableYearQuery,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { planPredicate, scopedTableFor } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  authorizeSchoolAction,
  decideResource,
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
  authorizeEitherSchoolAction,
  assertSectionInYear,
  assertStaff,
  assertSubject,
  assertYear,
  personName,
  queryRows,
  requireUuidParam,
  requireUuidValue,
  sectionName,
  toCell,
  type CellRow,
  type ModuleConnection,
  type TimetableCellDto,
} from './shared.ts'

/** The one predicate every timetable read adds to its WHERE clause. */
async function timetablePredicate(conn: ModuleConnection, context: RequestContext): Promise<SQL> {
  const table = scopedTableFor('timetable')
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const plan = await readPlan(conn, context, 'timetable.read', 'timetable')
  return planPredicate(plan, table)
}

async function readCells(conn: ModuleConnection, where: SQL): Promise<TimetableCellDto[]> {
  const rows = await queryRows<CellRow>(
    conn,
    sql`SELECT ${CELL_COLUMNS} ${CELL_JOINS} WHERE ${where}
        ORDER BY timetable_entries.day_of_week, timetable_entries.period_index`,
  )
  return rows.map(toCell)
}

interface AssignmentRow {
  readonly subjectId: string
  readonly staffId: string
}

/** The teacher who holds this section+subject for the year, if anybody does. */
async function assignedTeacher(
  conn: ModuleConnection,
  schoolId: string,
  input: { sectionId: string; subjectId: string; academicYearId: string; staffId: string },
): Promise<boolean> {
  const rows = await queryRows<{ ok: number }>(
    conn,
    sql`SELECT 1 AS ok FROM teaching_assignments
         WHERE school_id = ${schoolId}::uuid AND staff_id = ${input.staffId}::uuid
           AND section_id = ${input.sectionId}::uuid AND subject_id = ${input.subjectId}::uuid
           AND academic_year_id = ${input.academicYearId}::uuid`,
  )
  return rows.length > 0
}

export function registerGridRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/sections/:sectionId',
    permission: 'timetable.read',
    query: TimetableYearQuery,
    response: SectionTimetable,
    handler: async ({ context, query, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const sectionId = requireUuidParam(param('sectionId'))
        const yearId = requireUuidValue(query.academicYearId)
        const predicate = await timetablePredicate(conn, context)
        const cells = await readCells(
          conn,
          sql`${predicate} AND timetable_entries.academic_year_id = ${yearId}::uuid
              AND timetable_entries.section_id = ${sectionId}::uuid`,
        )
        if (cells.length === 0) {
          // An empty grid is only shown to somebody who may see the class at
          // all; to anyone else the section is simply not there.
          const decision = await decideResource(conn, context, 'sections.read', 'section', sectionId)
          if (!decision.allowed) throw new ApiFailure('RESOURCE_NOT_FOUND')
        }
        return { cells, allowedActions: await aggregateAllowedActions(conn, context, 'timetable') }
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/staff/:staffId',
    permission: 'timetable.read',
    query: TimetableYearQuery,
    response: StaffTimetable,
    handler: async ({ context, query, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const staffId = requireUuidParam(param('staffId'))
        const yearId = requireUuidValue(query.academicYearId)
        const predicate = await timetablePredicate(conn, context)
        const cells = await readCells(
          conn,
          sql`${predicate} AND timetable_entries.academic_year_id = ${yearId}::uuid
              AND timetable_entries.staff_id = ${staffId}::uuid`,
        )
        if (cells.length === 0) {
          const decision = await decideResource(conn, context, 'staff.read_directory', 'staff', staffId)
          if (!decision.allowed) throw new ApiFailure('RESOURCE_NOT_FOUND')
        }
        return { cells, allowedActions: await aggregateAllowedActions(conn, context, 'timetable') }
      }),
  })

  // OPERATION_COVERAGE grants this read to timetable.manage_entries OR
  // timetable.manage_substitutions. protectedRoute declares exactly one
  // permission and decides it before the handler runs, so the route is gated on
  // manage_entries and the handler accepts either. Every role template that
  // grants manage_substitutions also grants manage_entries, so only a
  // membership given manage_substitutions alone by an allow exception is
  // narrowed; that is recorded as a deviation rather than worked around here.
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/free-teachers',
    permission: 'timetable.manage_entries',
    query: TimetableFreeTeacherQuery,
    response: AvailableTeacherSuggestionList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeEitherSchoolAction(conn, context, [
          'timetable.manage_entries',
          'timetable.manage_substitutions',
        ])
        const yearId = requireUuidValue(query.academicYearId)
        const subjectId = query.subjectId === undefined ? null : requireUuidValue(query.subjectId)
        await assertYear(conn, context.schoolId, yearId)
        const rows = await queryRows<{
          id: string
          firstName: string
          lastName: string | null
          periodsPerWeek: number
          teachesSubject: boolean
        }>(
          conn,
          sql`SELECT staff.id::text AS "id", staff.first_name AS "firstName", staff.last_name AS "lastName",
                (SELECT count(*)::int FROM timetable_entries load
                   WHERE load.school_id = staff.school_id AND load.staff_id = staff.id
                     AND load.academic_year_id = ${yearId}::uuid) AS "periodsPerWeek",
                (${subjectId}::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM teaching_assignments ta
                   WHERE ta.school_id = staff.school_id AND ta.staff_id = staff.id
                     AND ta.academic_year_id = ${yearId}::uuid
                     AND ta.subject_id = ${subjectId}::uuid)) AS "teachesSubject"
              FROM staff
              WHERE staff.school_id = ${context.schoolId}::uuid AND staff.staff_type = 'teaching'
                AND staff.status = 'active'
                AND NOT EXISTS (SELECT 1 FROM timetable_entries busy
                  WHERE busy.school_id = staff.school_id AND busy.staff_id = staff.id
                    AND busy.academic_year_id = ${yearId}::uuid
                    AND busy.day_of_week = ${query.dayOfWeek} AND busy.period_index = ${query.periodIndex})
              ORDER BY "periodsPerWeek", staff.id LIMIT 100`,
        )
        return rows.map((row) => ({
          teacher: { id: row.id, name: personName(row.firstName, row.lastName) },
          teachesSubject: row.teachesSubject === true,
          periodsPerWeek: Number(row.periodsPerWeek),
        }))
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/timetable/entries',
    permission: 'timetable.manage_entries',
    body: TimetableEntryRequest,
    response: TimetableEntry,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.manage_entries')
        const yearId = requireUuidValue(body.academicYearId)
        const sectionId = requireUuidValue(body.sectionId)
        const subjectId = requireUuidValue(body.subjectId)
        await assertYear(conn, context.schoolId, yearId)
        await assertSectionInYear(conn, context.schoolId, sectionId, yearId)
        await assertSubject(conn, context.schoolId, subjectId)
        const staffId = body.staffId === undefined ? null : requireUuidValue(body.staffId)
        if (staffId !== null) {
          await assertStaff(conn, context.schoolId, staffId)
          // teacher_not_assigned: a teacher may only hold a slot they teach.
          const assigned = await assignedTeacher(conn, context.schoolId, {
            sectionId,
            subjectId,
            academicYearId: yearId,
            staffId,
          })
          if (!assigned) throw new ApiFailure('INVALID_REQUEST')
          // teacher_busy: the same person cannot stand in two rooms at once.
          const clash = await queryRows<{ ok: number }>(
            conn,
            sql`SELECT 1 AS ok FROM timetable_entries
                 WHERE school_id = ${context.schoolId}::uuid AND academic_year_id = ${yearId}::uuid
                   AND staff_id = ${staffId}::uuid AND day_of_week = ${body.dayOfWeek}
                   AND period_index = ${body.periodIndex} AND section_id <> ${sectionId}::uuid`,
          )
          if (clash.length > 0) throw new ApiFailure('INVALID_REQUEST')
        }
        await lockSchool(conn, context.schoolId)
        const written = await queryRows<{ id: string }>(
          conn,
          sql`INSERT INTO timetable_entries
                (school_id, academic_year_id, section_id, day_of_week, period_index, subject_id, staff_id, room_number)
              VALUES (${context.schoolId}::uuid, ${yearId}::uuid, ${sectionId}::uuid, ${body.dayOfWeek},
                ${body.periodIndex}, ${subjectId}::uuid, ${staffId}::uuid, ${body.roomNumber ?? null}::text)
              ON CONFLICT (school_id, academic_year_id, section_id, day_of_week, period_index)
              DO UPDATE SET subject_id = EXCLUDED.subject_id, staff_id = EXCLUDED.staff_id,
                room_number = EXCLUDED.room_number, updated_at = now()
              RETURNING id::text AS "id"`,
        )
        const id = written[0]?.id
        if (!id) throw new ApiFailure('SERVICE_UNAVAILABLE')
        await writeAudit(conn, context, {
          action: 'timetable.manage_entries',
          targetType: 'timetable',
          targetId: id,
          summary: 'Set a timetable slot for a class',
          safeChanges: { dayOfWeek: body.dayOfWeek, periodIndex: body.periodIndex, teacherSet: staffId !== null },
        })
        const cells = await readCells(
          conn,
          sql`timetable_entries.school_id = ${context.schoolId}::uuid AND timetable_entries.id = ${id}::uuid`,
        )
        const cell = cells[0]
        if (!cell) throw new ApiFailure('SERVICE_UNAVAILABLE')
        return cell
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/timetable/entries',
    permission: 'timetable.manage_entries',
    query: TimetableEntrySlotQuery,
    response: EmptySuccess,
    successStatus: 204,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.manage_entries')
        const yearId = requireUuidValue(query.academicYearId)
        const sectionId = requireUuidValue(query.sectionId)
        await lockSchool(conn, context.schoolId)
        const removed = await queryRows<{ id: string }>(
          conn,
          sql`DELETE FROM timetable_entries
               WHERE school_id = ${context.schoolId}::uuid AND academic_year_id = ${yearId}::uuid
                 AND section_id = ${sectionId}::uuid AND day_of_week = ${query.dayOfWeek}
                 AND period_index = ${query.periodIndex}
               RETURNING id::text AS "id"`,
        )
        const id = removed[0]?.id
        if (!id) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await writeAudit(conn, context, {
          action: 'timetable.manage_entries',
          targetType: 'timetable',
          targetId: id,
          summary: 'Cleared a timetable slot for a class',
          safeChanges: { dayOfWeek: query.dayOfWeek, periodIndex: query.periodIndex },
        })
        return null
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/timetable/sections/:sectionId/generate',
    permission: 'timetable.generate',
    body: TimetableGenerateRequest,
    response: TimetableGenerationResult,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.generate')
        const sectionId = requireUuidParam(param('sectionId'))
        const yearId = requireUuidValue(body.academicYearId)
        await assertYear(conn, context.schoolId, yearId)
        await assertSectionInYear(conn, context.schoolId, sectionId, yearId)
        return generateForSection(conn, context, { sectionId, yearId, reason: body.reason })
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/conflicts',
    permission: 'timetable.read_conflicts',
    query: TimetableYearQuery,
    response: TimetableConflictList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.read_conflicts')
        const yearId = requireUuidValue(query.academicYearId)
        return readConflicts(conn, context.schoolId, yearId)
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/timetable/teacher-loads',
    permission: 'timetable.read_teacher_loads',
    query: TimetableYearQuery,
    response: TeacherLoadList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'timetable.read_teacher_loads')
        const yearId = requireUuidValue(query.academicYearId)
        const rows = await queryRows<{
          id: string
          firstName: string
          lastName: string | null
          periodsPerWeek: number
          sectionsCount: number
          subjectsCount: number
        }>(
          conn,
          sql`SELECT staff.id::text AS "id", staff.first_name AS "firstName", staff.last_name AS "lastName",
                count(timetable_entries.id)::int AS "periodsPerWeek",
                count(DISTINCT timetable_entries.section_id)::int AS "sectionsCount",
                count(DISTINCT timetable_entries.subject_id)::int AS "subjectsCount"
              FROM staff
              LEFT JOIN timetable_entries ON timetable_entries.school_id = staff.school_id
                AND timetable_entries.staff_id = staff.id
                AND timetable_entries.academic_year_id = ${yearId}::uuid
              WHERE staff.school_id = ${context.schoolId}::uuid AND staff.staff_type = 'teaching'
                AND staff.status IN ('active', 'on_leave')
              GROUP BY staff.id, staff.first_name, staff.last_name
              ORDER BY "periodsPerWeek" DESC, staff.id`,
        )
        return rows.map((row) => ({
          teacher: { id: row.id, name: personName(row.firstName, row.lastName) },
          periodsPerWeek: Number(row.periodsPerWeek),
          sectionsCount: Number(row.sectionsCount),
          subjectsCount: Number(row.subjectsCount),
        }))
      }),
  })
}

interface ConflictRow {
  readonly dayOfWeek: number
  readonly periodIndex: number
  readonly sectionId: string
  readonly sectionName: string
  readonly gradeName: string
  readonly staffId: string | null
  readonly firstName: string | null
  readonly lastName: string | null
}

function conflictOf(kind: 'teacher_busy' | 'teacher_not_assigned', row: ConflictRow) {
  const name = personName(row.firstName, row.lastName)
  return {
    kind,
    dayOfWeek: Number(row.dayOfWeek),
    periodIndex: Number(row.periodIndex),
    section: { id: row.sectionId, name: sectionName(row.gradeName, row.sectionName) },
    ...(row.staffId === null || name === '' ? {} : { teacher: { id: row.staffId, name } }),
  }
}

/** The two things that make a published week unworkable, school-wide. */
async function readConflicts(conn: ModuleConnection, schoolId: string, yearId: string) {
  const busy = await queryRows<ConflictRow>(
    conn,
    sql`SELECT DISTINCT ON (timetable_entries.staff_id, timetable_entries.day_of_week, timetable_entries.period_index)
          timetable_entries.day_of_week::int AS "dayOfWeek", timetable_entries.period_index::int AS "periodIndex",
          sections.id::text AS "sectionId", sections.name AS "sectionName", grades.name AS "gradeName",
          staff.id::text AS "staffId", staff.first_name AS "firstName", staff.last_name AS "lastName"
        FROM timetable_entries
        JOIN sections ON sections.school_id = timetable_entries.school_id AND sections.id = timetable_entries.section_id
        JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
        JOIN staff ON staff.school_id = timetable_entries.school_id AND staff.id = timetable_entries.staff_id
        WHERE timetable_entries.school_id = ${schoolId}::uuid
          AND timetable_entries.academic_year_id = ${yearId}::uuid
          AND EXISTS (SELECT 1 FROM timetable_entries other
            WHERE other.school_id = timetable_entries.school_id
              AND other.academic_year_id = timetable_entries.academic_year_id
              AND other.staff_id = timetable_entries.staff_id
              AND other.day_of_week = timetable_entries.day_of_week
              AND other.period_index = timetable_entries.period_index
              AND other.section_id <> timetable_entries.section_id)
        ORDER BY timetable_entries.staff_id, timetable_entries.day_of_week, timetable_entries.period_index,
          timetable_entries.section_id`,
  )
  const unassigned = await queryRows<ConflictRow>(
    conn,
    sql`SELECT timetable_entries.day_of_week::int AS "dayOfWeek", timetable_entries.period_index::int AS "periodIndex",
          sections.id::text AS "sectionId", sections.name AS "sectionName", grades.name AS "gradeName",
          staff.id::text AS "staffId", staff.first_name AS "firstName", staff.last_name AS "lastName"
        FROM timetable_entries
        JOIN sections ON sections.school_id = timetable_entries.school_id AND sections.id = timetable_entries.section_id
        JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
        LEFT JOIN staff ON staff.school_id = timetable_entries.school_id AND staff.id = timetable_entries.staff_id
        WHERE timetable_entries.school_id = ${schoolId}::uuid
          AND timetable_entries.academic_year_id = ${yearId}::uuid
          AND (timetable_entries.staff_id IS NULL OR NOT EXISTS (SELECT 1 FROM teaching_assignments ta
            WHERE ta.school_id = timetable_entries.school_id
              AND ta.academic_year_id = timetable_entries.academic_year_id
              AND ta.staff_id = timetable_entries.staff_id
              AND ta.section_id = timetable_entries.section_id
              AND ta.subject_id = timetable_entries.subject_id))
        ORDER BY timetable_entries.day_of_week, timetable_entries.period_index, timetable_entries.section_id`,
  )
  return [
    ...busy.map((row) => conflictOf('teacher_busy', row)),
    ...unassigned.map((row) => conflictOf('teacher_not_assigned', row)),
  ]
}

/**
 * A greedy week: every subject the class studies is offered in turn, and each
 * is placed in the first free slot where its own teacher is also free. What
 * is already on the grid stays, so a generated week never wipes hand work.
 */
async function generateForSection(
  conn: ModuleConnection,
  context: RequestContext,
  input: { sectionId: string; yearId: string; reason: string },
) {
  const schoolId = context.schoolId
  const gradeRows = await queryRows<{ gradeId: string; roomNumber: string | null }>(
    conn,
    sql`SELECT grade_id::text AS "gradeId", room_number AS "roomNumber" FROM sections
         WHERE school_id = ${schoolId}::uuid AND id = ${input.sectionId}::uuid`,
  )
  const grade = gradeRows[0]
  if (!grade) throw new ApiFailure('INVALID_REQUEST')

  const bells = await queryRows<{
    gradeIds: string[]
    workingDays: (number | string)[]
    periods: unknown
    saturdayPeriodCount: number | null
  }>(
    conn,
    sql`SELECT (SELECT coalesce(array_agg(bsg.grade_id::text), '{}') FROM bell_schedule_grades bsg
            WHERE bsg.school_id = bell_schedules.school_id AND bsg.bell_schedule_id = bell_schedules.id) AS "gradeIds",
          working_days AS "workingDays", periods, saturday_period_count AS "saturdayPeriodCount"
        FROM bell_schedules WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${input.yearId}::uuid
        ORDER BY name`,
  )
  const bell = bells.find((row) => row.gradeIds.includes(grade.gradeId)) ?? bells.find((row) => row.gradeIds.length === 0)
  // Without a bell schedule there are no slots to fill, which is bad input
  // rather than a server fault.
  if (!bell) throw new ApiFailure('INVALID_REQUEST')
  const periods = BellPeriod.array().safeParse(bell.periods)
  if (!periods.success) throw new ApiFailure('INVALID_REQUEST')
  const teachingSlots = periods.data
    .filter((period) => period.type === 'period')
    .map((period) => period.index)
    .sort((left, right) => left - right)
  const days = bell.workingDays.map(Number).sort((left, right) => left - right)
  const saturdayLimit = bell.saturdayPeriodCount === null ? null : Number(bell.saturdayPeriodCount)

  const subjects = await queryRows<AssignmentRow>(
    conn,
    // One row per subject, never one per teaching assignment: two teachers on
    // one subject must not give that subject twice its share of the week. The
    // teacher chosen is an active one, so a suspended or departed member of
    // staff is never written into a generated grid.
    sql`SELECT gs.subject_id::text AS "subjectId",
          coalesce((SELECT ta.staff_id::text FROM teaching_assignments ta
             JOIN staff ON staff.school_id = ta.school_id AND staff.id = ta.staff_id
            WHERE ta.school_id = gs.school_id AND ta.subject_id = gs.subject_id
              AND ta.academic_year_id = gs.academic_year_id
              AND ta.section_id = ${input.sectionId}::uuid AND staff.status = 'active'
            ORDER BY ta.effective_from, ta.staff_id LIMIT 1), '') AS "staffId"
        FROM grade_subjects gs
        JOIN subjects ON subjects.school_id = gs.school_id AND subjects.id = gs.subject_id
        WHERE gs.school_id = ${schoolId}::uuid AND gs.grade_id = ${grade.gradeId}::uuid
          AND gs.academic_year_id = ${input.yearId}::uuid
        ORDER BY subjects.name`,
  )

  await lockSchool(conn, schoolId)
  const existing = await queryRows<{ sectionId: string; dayOfWeek: number; periodIndex: number; staffId: string | null }>(
    conn,
    sql`SELECT section_id::text AS "sectionId", day_of_week::int AS "dayOfWeek",
          period_index::int AS "periodIndex", staff_id::text AS "staffId"
        FROM timetable_entries
        WHERE school_id = ${schoolId}::uuid AND academic_year_id = ${input.yearId}::uuid
        FOR UPDATE`,
  )
  const taken = new Set<string>()
  const busy = new Set<string>()
  for (const row of existing) {
    const slot = `${row.dayOfWeek}|${row.periodIndex}`
    if (row.sectionId === input.sectionId) taken.add(slot)
    if (row.staffId !== null) busy.add(`${row.staffId}|${slot}`)
  }

  let placed = 0
  let unplaced = 0
  let cursor = 0
  for (const day of days) {
    for (const periodIndex of teachingSlots) {
      if (day === 6 && saturdayLimit !== null && periodIndex >= saturdayLimit) continue
      const slot = `${day}|${periodIndex}`
      if (taken.has(slot)) continue
      let chosen: AssignmentRow | undefined
      for (let attempt = 0; attempt < subjects.length; attempt += 1) {
        const candidate = subjects[(cursor + attempt) % subjects.length]
        if (!candidate || candidate.staffId === '') continue
        if (busy.has(`${candidate.staffId}|${slot}`)) continue
        chosen = candidate
        cursor = (cursor + attempt + 1) % Math.max(1, subjects.length)
        break
      }
      if (!chosen) {
        unplaced += 1
        continue
      }
      await conn.client.query(
        `INSERT INTO timetable_entries
           (school_id, academic_year_id, section_id, day_of_week, period_index, subject_id, staff_id, room_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [schoolId, input.yearId, input.sectionId, day, periodIndex, chosen.subjectId, chosen.staffId, grade.roomNumber],
      )
      taken.add(slot)
      busy.add(`${chosen.staffId}|${slot}`)
      placed += 1
    }
  }

  await writeAudit(conn, context, {
    action: 'timetable.generate',
    targetType: 'timetable',
    targetId: input.sectionId,
    summary: 'Generated the weekly timetable for a class',
    safeChanges: { placed, unplaced, reasonLength: input.reason.length },
  })
  return { placed, unplaced }
}
