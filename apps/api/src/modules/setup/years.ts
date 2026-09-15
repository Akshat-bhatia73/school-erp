import type { FastifyInstance } from 'fastify'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  AcademicYear,
  AcademicYearInput,
  AcademicYearList,
  CurrentAcademicYear,
  SetupAcademicYearUpdateRequest,
} from '@erp/contracts'
import { planPredicate } from '@erp/authz'
import { academicYears, schools } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import { authorizeSchoolAction, readPlan } from '../shared/authorize.ts'
import { lockSchool, writeAudit, type TenantConnection } from '../shared/audit.ts'
import { bumpVersion } from '../shared/version.ts'
import { ApiFailure, requireFound } from '../shared/errors.ts'
import { isoDate, requireUuid, scopedTable } from './common.ts'

type Year = z.infer<typeof AcademicYear>
type YearStatus = Year['status']

const columns = {
  id: academicYears.id,
  schoolId: academicYears.schoolId,
  name: academicYears.name,
  startDate: isoDate(academicYears.startDate),
  endDate: isoDate(academicYears.endDate),
  status: sql<string>`${academicYears.status}`,
  version: academicYears.version,
}

const STATUSES = ['upcoming', 'current', 'closed'] as const

/** A status the database holds but the contract does not know reads as closed. */
function statusOf(value: string): YearStatus {
  return STATUSES.find((status) => status === value) ?? 'closed'
}

interface YearRow {
  id: string
  schoolId: string
  name: string
  startDate: string
  endDate: string
  status: string
  version: number
}

function toYear(row: YearRow): Year {
  return { ...row, status: statusOf(row.status) }
}

/**
 * Exactly one year is current. Making one current closes the one that was,
 * and points the school at the new one, all inside the caller's transaction so
 * the school never has two current years even for an instant.
 */
async function makeCurrent(
  conn: TenantConnection,
  schoolId: string,
  yearId: string,
): Promise<readonly string[]> {
  // The years this closes are reported back so the one audit row can name
  // them. Without that, the trail would not say which year stopped being
  // current, and an editor holding it open would meet an unexplained
  // VERSION_CONFLICT on their next save.
  const closed = await conn.client.query<{ id: string }>(
    `UPDATE academic_years SET status = 'closed', version = version + 1, updated_at = now()
      WHERE school_id = $1 AND status = 'current' AND id <> $2 RETURNING id`,
    [schoolId, yearId],
  )
  await conn.client.query(`UPDATE schools SET current_academic_year_id = $2, updated_at = now() WHERE id = $1`, [
    schoolId,
    yearId,
  ])
  return closed.rows.map((row) => row.id)
}

/** Stop naming this year as the school's current one. */
async function clearPointer(conn: TenantConnection, schoolId: string, yearId: string): Promise<void> {
  await conn.client.query(
    `UPDATE schools SET current_academic_year_id = NULL, updated_at = now()
      WHERE id = $1 AND current_academic_year_id = $2`,
    [schoolId, yearId],
  )
}

export function registerAcademicYearRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/academic-years',
    permission: 'academic_years.read',
    response: AcademicYearList,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'academic_years.read', 'academic_year')
        const rows = await conn.db
          .select(columns)
          .from(academicYears)
          .where(planPredicate(plan, scopedTable('academic_year')))
          .orderBy(academicYears.startDate)
        return rows.map(toYear)
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/academic-years/current',
    permission: 'academic_years.read',
    response: CurrentAcademicYear,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'academic_years.read', 'academic_year')
        const predicate = planPredicate(plan, scopedTable('academic_year'))
        const chosen = await conn.db
          .select({ id: schools.currentAcademicYearId })
          .from(schools)
          .where(eq(schools.id, context.schoolId))
          .limit(1)
        const pointed = chosen[0]?.id ?? null
        // The school's own pointer wins; a school that has never set one falls
        // back to whichever year still calls itself current.
        const match = pointed
          ? and(predicate, eq(academicYears.id, pointed))
          : and(predicate, eq(academicYears.status, 'current'))
        const rows = await conn.db.select(columns).from(academicYears).where(match).limit(1)
        const row = rows[0]
        return row ? toYear(row) : null
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/academic-years',
    permission: 'academic_years.manage',
    body: AcademicYearInput,
    response: AcademicYear,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'academic_years.manage')
        const duplicate = await conn.client.query(
          'SELECT 1 FROM academic_years WHERE school_id = $1 AND name = $2',
          [context.schoolId, body.name],
        )
        if (duplicate.rowCount !== null && duplicate.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO academic_years(school_id, name, start_date, end_date, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [context.schoolId, body.name, body.startDate, body.endDate, body.status],
        )
        const id = requireFound(inserted.rows[0]).id
        const closed = body.status === 'current' ? await makeCurrent(conn, context.schoolId, id) : []
        await writeAudit(conn, context, {
          action: 'academic_years.manage',
          targetType: 'academic_year',
          targetId: id,
          summary: 'Created an academic year.',
          safeChanges: { status: body.status, closedYearIds: closed },
        })
        const rows = await conn.db
          .select(columns)
          .from(academicYears)
          .where(eq(academicYears.id, id))
          .limit(1)
        return toYear(requireFound(rows[0]))
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/academic-years/:academicYearId',
    permission: 'academic_years.manage',
    body: SetupAcademicYearUpdateRequest,
    response: AcademicYear,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('academicYearId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'academic_years.manage')
        const clash = await conn.client.query(
          'SELECT 1 FROM academic_years WHERE school_id = $1 AND name = $2 AND id <> $3',
          [context.schoolId, body.name, id],
        )
        if (clash.rowCount !== null && clash.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')

        await bumpVersion(conn, 'academic_years', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: {
            name: body.name,
            start_date: body.startDate,
            end_date: body.endDate,
            status: body.status,
          },
        })
        const closed = body.status === 'current' ? await makeCurrent(conn, context.schoolId, id) : []
        // A year that stops being current must stop being the school's pointer
        // too, or the school would still name a closed year as its current one.
        if (body.status !== 'current') await clearPointer(conn, context.schoolId, id)
        await writeAudit(conn, context, {
          action: 'academic_years.manage',
          targetType: 'academic_year',
          targetId: id,
          summary: 'Updated an academic year.',
          safeChanges: { status: body.status, closedYearIds: closed },
        })
        const rows = await conn.db
          .select(columns)
          .from(academicYears)
          .where(eq(academicYears.id, id))
          .limit(1)
        return toYear(requireFound(rows[0]))
      }),
  })
}
