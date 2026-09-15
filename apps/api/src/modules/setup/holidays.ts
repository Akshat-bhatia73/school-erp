import type { FastifyInstance } from 'fastify'
import { and, eq, sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  Holiday,
  HolidayInput,
  HolidayList,
  SetupHolidayListQuery,
  SetupHolidayUpdateRequest,
} from '@erp/contracts'
import { planPredicate } from '@erp/authz'
import { holidays } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import { authorizeSchoolAction, readPlan } from '../shared/authorize.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { ApiFailure, requireFound } from '../shared/errors.ts'
import {
  isoDate,
  requireQueryUuid,
  requireReference,
  requireUuid,
  scopedTable,
  TOUCH_VERSION_SQL,
  touchVersion,
} from './common.ts'

type HolidayResponse = z.infer<typeof Holiday>

const columns = {
  id: holidays.id,
  schoolId: holidays.schoolId,
  academicYearId: holidays.academicYearId,
  name: holidays.name,
  startDate: isoDate(holidays.startDate),
  endDate: isoDate(holidays.endDate),
  type: sql<string>`${holidays.type}`,
  // The table has no version column, so the moment of the last save stands in
  // for one and an editor who was looking at an older holiday is refused.
  touched: touchVersion(holidays.updatedAt),
}

const TYPES = ['national', 'festival', 'school', 'vacation'] as const

function toHoliday(row: {
  id: string
  schoolId: string
  academicYearId: string
  name: string
  startDate: string
  endDate: string
  type: string
  touched: string
}): HolidayResponse {
  const type = TYPES.find((value) => value === row.type)
  if (!type) throw new ApiFailure('SERVICE_UNAVAILABLE')
  const { touched, ...rest } = row
  return { ...rest, type, version: Number(touched) }
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
        return rows.map(toHoliday)
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
        return toHoliday(requireFound(rows[0]))
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

        const updated = await conn.client.query(
          `UPDATE holidays
              SET academic_year_id = $3, name = $4, start_date = $5, end_date = $6, type = $7,
                  updated_at = clock_timestamp()
            WHERE school_id = $1 AND id = $2 AND ${TOUCH_VERSION_SQL} = $8`,
          [
            context.schoolId,
            id,
            body.academicYearId,
            body.name,
            body.startDate,
            body.endDate,
            body.type,
            String(body.expectedVersion),
          ],
        )
        // Nothing updated means either the holiday is not there or somebody
        // saved first; the two are told apart rather than guessed at, and a
        // holiday of another school stays invisible.
        if (updated.rowCount === 0) {
          const exists = await conn.client.query('SELECT 1 FROM holidays WHERE school_id = $1 AND id = $2', [
            context.schoolId,
            id,
          ])
          throw new ApiFailure(exists.rowCount === 0 ? 'RESOURCE_NOT_FOUND' : 'VERSION_CONFLICT')
        }
        await writeAudit(conn, context, {
          action: 'holidays.manage',
          targetType: 'holiday',
          targetId: id,
          summary: 'Updated a holiday in the school calendar.',
          safeChanges: { type: body.type },
        })
        const rows = await conn.db.select(columns).from(holidays).where(eq(holidays.id, id)).limit(1)
        return toHoliday(requireFound(rows[0]))
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
