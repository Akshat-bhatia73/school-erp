import type { FastifyInstance } from 'fastify'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  Holiday,
  HolidayInput,
  HolidayList,
  SetupHolidayListQuery,
  SetupHolidayUpdateRequest,
  type PermissionKey,
} from '@erp/contracts'
import { planPredicate } from '@erp/authz'
import { holidays } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import {
  allowedActionsFor,
  allowedActionsForMany,
  authorizeSchoolAction,
  readPlan,
} from '../shared/authorize.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { bumpVersion } from '../shared/version.ts'
import { ApiFailure, requireFound } from '../shared/errors.ts'
import { isoDate, requireQueryUuid, requireReference, requireUuid, scopedTable } from './common.ts'

type HolidayResponse = z.infer<typeof Holiday>

const columns = {
  id: holidays.id,
  schoolId: holidays.schoolId,
  academicYearId: holidays.academicYearId,
  name: holidays.name,
  startDate: isoDate(holidays.startDate),
  endDate: isoDate(holidays.endDate),
  type: sql<string>`${holidays.type}`,
  version: holidays.version,
}

const TYPES = ['national', 'festival', 'school', 'vacation'] as const

function toHoliday(
  row: {
    id: string
    schoolId: string
    academicYearId: string
    name: string
    startDate: string
    endDate: string
    type: string
    version: number
  },
  allowedActions: readonly PermissionKey[],
): HolidayResponse {
  const type = TYPES.find((value) => value === row.type)
  if (!type) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return { ...row, type, allowedActions: [...allowedActions] }
}

export function registerHolidayRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/holidays',
    permission: 'holidays.read',
    query: SetupHolidayListQuery,
    response: HolidayList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'holidays.read', 'holiday')
        const filters: SQL[] = [planPredicate(plan, scopedTable('holiday'))]
        if (query.academicYearId) {
          filters.push(eq(holidays.academicYearId, requireQueryUuid(query.academicYearId)))
        }
        const rows = await conn.db
          .select(columns)
          .from(holidays)
          .where(and(...filters))
          .orderBy(holidays.startDate)
        const actions = await allowedActionsForMany(conn, context, 'holiday', rows.map((row) => row.id))
        return rows.map((row) => toHoliday(row, actions.get(row.id) ?? []))
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/holidays',
    permission: 'holidays.manage',
    body: HolidayInput,
    response: Holiday,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'holidays.manage')
        await requireReference(conn, 'academic_years', context.schoolId, body.academicYearId)

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO holidays(school_id, academic_year_id, name, start_date, end_date, type)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [context.schoolId, body.academicYearId, body.name, body.startDate, body.endDate, body.type],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'holidays.manage',
          targetType: 'holiday',
          targetId: id,
          summary: 'Added a holiday to the school calendar.',
          safeChanges: { type: body.type },
        })
        const rows = await conn.db.select(columns).from(holidays).where(eq(holidays.id, id)).limit(1)
        const actions = await allowedActionsFor(conn, context, {
          schoolId: context.schoolId,
          resourceType: 'holiday',
          id,
        })
        return toHoliday(requireFound(rows[0]), actions)
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/holidays/:holidayId',
    permission: 'holidays.manage',
    body: SetupHolidayUpdateRequest,
    response: Holiday,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('holidayId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'holidays.manage')
        await requireReference(conn, 'academic_years', context.schoolId, body.academicYearId)

        await bumpVersion(conn, 'holidays', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: {
            academic_year_id: body.academicYearId,
            name: body.name,
            start_date: body.startDate,
            end_date: body.endDate,
            type: body.type,
          },
        })
        await writeAudit(conn, context, {
          action: 'holidays.manage',
          targetType: 'holiday',
          targetId: id,
          summary: 'Updated a holiday in the school calendar.',
          safeChanges: { type: body.type },
        })
        const rows = await conn.db.select(columns).from(holidays).where(eq(holidays.id, id)).limit(1)
        const actions = await allowedActionsFor(conn, context, {
          schoolId: context.schoolId,
          resourceType: 'holiday',
          id,
        })
        return toHoliday(requireFound(rows[0]), actions)
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/holidays/:holidayId',
    permission: 'holidays.manage',
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('holidayId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'holidays.manage')
        const removed = await conn.client.query('DELETE FROM holidays WHERE school_id = $1 AND id = $2', [
          context.schoolId,
          id,
        ])
        if (removed.rowCount === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await writeAudit(conn, context, {
          action: 'holidays.manage',
          targetType: 'holiday',
          targetId: id,
          summary: 'Removed a holiday from the school calendar.',
        })
        return null
      }),
  })
}
