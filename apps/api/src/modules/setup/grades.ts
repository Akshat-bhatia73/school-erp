import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { Grade, GradeInput, GradeList, SetupGradeUpdateRequest, type PermissionKey } from '@erp/contracts'
import { planPredicate } from '@erp/authz'
import { grades } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import { allowedActionsFor, allowedActionsForMany, authorizeSchoolAction, readPlan } from '../shared/authorize.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { bumpVersion } from '../shared/version.ts'
import { ApiFailure, requireFound } from '../shared/errors.ts'
import { optional, refuseWhenReferenced, requireUuid, scopedTable } from './common.ts'

type GradeResponse = z.infer<typeof Grade>

const columns = {
  id: grades.id,
  schoolId: grades.schoolId,
  name: grades.name,
  shortName: grades.shortName,
  order: grades.sortOrder,
  stream: grades.stream,
  level: grades.level,
  version: grades.version,
}

const STREAMS = ['science', 'commerce', 'arts'] as const

interface GradeRow {
  id: string
  schoolId: string
  name: string
  shortName: string
  order: number
  stream: string | null
  level: number | null
  version: number
}

function toGrade(row: GradeRow, allowedActions: readonly PermissionKey[]): GradeResponse {
  const stream = STREAMS.find((value) => value === row.stream)
  return {
    id: row.id,
    schoolId: row.schoolId,
    name: row.name,
    shortName: row.shortName,
    order: row.order,
    ...optional('stream', stream),
    ...optional('level', row.level),
    version: row.version,
    allowedActions: [...allowedActions],
  } as GradeResponse
}

/** A class cannot go while anything still points at it. */
const GRADE_REFERENCES = [
  { table: 'sections', column: 'grade_id', reason: 'grade_has_sections' },
  { table: 'grade_subjects', column: 'grade_id', reason: 'grade_has_subjects' },
  { table: 'bell_schedule_grades', column: 'grade_id', reason: 'grade_has_bell_schedule' },
] as const

export function registerGradeRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/grades',
    permission: 'grades.read',
    response: GradeList,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'grades.read', 'grade')
        const rows = await conn.db
          .select(columns)
          .from(grades)
          .where(planPredicate(plan, scopedTable('grade')))
          .orderBy(grades.sortOrder)
        // One decision pass for the page, so every row says what this caller
        // may do to that class.
        const actions = await allowedActionsForMany(conn, context, 'grade', rows.map((row) => row.id))
        return rows.map((row) => toGrade(row, actions.get(row.id) ?? []))
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/grades',
    permission: 'grades.manage',
    body: GradeInput,
    response: Grade,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'grades.manage')
        const duplicate = await conn.client.query('SELECT 1 FROM grades WHERE school_id = $1 AND name = $2', [
          context.schoolId,
          body.name,
        ])
        if (duplicate.rowCount !== null && duplicate.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO grades(school_id, name, short_name, sort_order, stream, level)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [context.schoolId, body.name, body.shortName, body.order, body.stream ?? null, body.level ?? null],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'grades.manage',
          targetType: 'grade',
          targetId: id,
          summary: 'Created a class.',
          ...(body.level === undefined ? {} : { safeChanges: { level: body.level } }),
        })
        const rows = await conn.db.select(columns).from(grades).where(eq(grades.id, id)).limit(1)
        const actions = await allowedActionsFor(conn, context, {
          schoolId: context.schoolId,
          resourceType: 'grade',
          id,
        })
        return toGrade(requireFound(rows[0]), actions)
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/grades/:gradeId',
    permission: 'grades.manage',
    body: SetupGradeUpdateRequest,
    response: Grade,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('gradeId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'grades.manage')
        const clash = await conn.client.query(
          'SELECT 1 FROM grades WHERE school_id = $1 AND name = $2 AND id <> $3',
          [context.schoolId, body.name, id],
        )
        if (clash.rowCount !== null && clash.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')
        // The class number decides which pupils may have their own login, so a
        // change to it is recorded on the audit row. Left out means none.
        const before = await conn.client.query<{ level: number | null }>(
          'SELECT level FROM grades WHERE school_id = $1 AND id = $2',
          [context.schoolId, id],
        )
        const levelBefore = before.rows[0]?.level ?? null
        const levelAfter = body.level ?? null

        await bumpVersion(conn, 'grades', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: {
            name: body.name,
            short_name: body.shortName,
            sort_order: body.order,
            stream: body.stream ?? null,
            level: levelAfter,
          },
        })
        await writeAudit(conn, context, {
          action: 'grades.manage',
          targetType: 'grade',
          targetId: id,
          summary: 'Updated a class.',
          ...(levelBefore === levelAfter ? {} : { safeChanges: { level: levelAfter, previousLevel: levelBefore } }),
        })
        const rows = await conn.db.select(columns).from(grades).where(eq(grades.id, id)).limit(1)
        const actions = await allowedActionsFor(conn, context, {
          schoolId: context.schoolId,
          resourceType: 'grade',
          id,
        })
        return toGrade(requireFound(rows[0]), actions)
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/grades/:gradeId',
    permission: 'grades.manage',
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('gradeId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'grades.manage')
        const existing = await conn.client.query('SELECT 1 FROM grades WHERE school_id = $1 AND id = $2', [
          context.schoolId,
          id,
        ])
        if (existing.rowCount === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await refuseWhenReferenced(conn, context.schoolId, GRADE_REFERENCES, id)

        await conn.client.query('DELETE FROM grades WHERE school_id = $1 AND id = $2', [context.schoolId, id])
        await writeAudit(conn, context, {
          action: 'grades.manage',
          targetType: 'grade',
          targetId: id,
          summary: 'Removed a class that nothing referred to.',
        })
        return null
      }),
  })
}
