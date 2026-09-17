import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { Grade, GradeInput, GradeList, SetupGradeUpdateRequest } from '@erp/contracts'
import { planPredicate } from '@erp/authz'
import { grades } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import { authorizeSchoolAction, readPlan } from '../shared/authorize.ts'
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
  version: number
}

function toGrade(row: GradeRow): GradeResponse {
  const stream = STREAMS.find((value) => value === row.stream)
  return {
    id: row.id,
    schoolId: row.schoolId,
    name: row.name,
    shortName: row.shortName,
    order: row.order,
    ...optional('stream', stream),
    version: row.version,
  } as GradeResponse
}

/** A class cannot go while anything still points at it. */
const GRADE_REFERENCES = [
  { table: 'sections', column: 'grade_id' },
  { table: 'grade_subjects', column: 'grade_id' },
  { table: 'bell_schedule_grades', column: 'grade_id' },
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
        return rows.map(toGrade)
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
          `INSERT INTO grades(school_id, name, short_name, sort_order, stream)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [context.schoolId, body.name, body.shortName, body.order, body.stream ?? null],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'grades.manage',
          targetType: 'grade',
          targetId: id,
          summary: 'Created a class.',
        })
        const rows = await conn.db.select(columns).from(grades).where(eq(grades.id, id)).limit(1)
        return toGrade(requireFound(rows[0]))
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

        await bumpVersion(conn, 'grades', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: {
            name: body.name,
            short_name: body.shortName,
            sort_order: body.order,
            stream: body.stream ?? null,
          },
        })
        await writeAudit(conn, context, {
          action: 'grades.manage',
          targetType: 'grade',
          targetId: id,
          summary: 'Updated a class.',
        })
        const rows = await conn.db.select(columns).from(grades).where(eq(grades.id, id)).limit(1)
        return toGrade(requireFound(rows[0]))
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
