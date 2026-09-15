import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { SetupSchoolProfile, UpdateSchoolRequest } from '@erp/contracts'
import { schools } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import { authorizeSchoolAction } from '../shared/authorize.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { assertVersion } from '../shared/version.ts'
import { ApiFailure, requireFound } from '../shared/errors.ts'
import { optional, touchVersion, TOUCH_VERSION_SQL } from './common.ts'

type Profile = z.infer<typeof SetupSchoolProfile>

/** The address is stored as a small object so it can grow later. */
const ADDRESS_LINE = sql<string | null>`${schools.address}->>'line'`

interface SchoolRow {
  readonly id: string
  readonly name: string
  readonly shortName: string
  readonly board: string | null
  readonly address: string | null
  readonly phone: string | null
  readonly email: string | null
  readonly affiliationNumber: string | null
  readonly udiseCode: string | null
  /** Microseconds of the last save, standing in for the missing version column. */
  readonly touched: string
}

const BOARDS = ['cbse', 'icse', 'state', 'ib', 'other'] as const
type Board = (typeof BOARDS)[number]

/** A board nobody has chosen yet reads as "other" rather than failing. */
function boardOf(value: string | null): Board {
  return BOARDS.find((board) => board === value) ?? 'other'
}

function toProfile(row: SchoolRow): Profile {
  return {
    id: row.id,
    name: row.name,
    shortName: row.shortName,
    board: boardOf(row.board),
    address: row.address ?? '',
    ...optional('phone', row.phone),
    ...optional('email', row.email),
    ...optional('affiliationNumber', row.affiliationNumber),
    ...optional('udiseCode', row.udiseCode),
    version: Number(row.touched),
  } as Profile
}

export function registerSchoolProfileRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/school',
    permission: 'school.read',
    response: SetupSchoolProfile,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'school.read')
        const rows = await conn.db
          .select({
            id: schools.id,
            name: schools.name,
            shortName: schools.shortName,
            board: schools.board,
            address: ADDRESS_LINE,
            phone: schools.phone,
            email: schools.email,
            affiliationNumber: schools.affiliationNumber,
            udiseCode: schools.udiseCode,
            touched: touchVersion(schools.updatedAt),
          })
          .from(schools)
          .where(eq(schools.id, context.schoolId))
          .limit(1)
        return toProfile(requireFound(rows[0]))
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/school',
    permission: 'school.update',
    body: UpdateSchoolRequest,
    response: SetupSchoolProfile,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'school.update')
        // The version is the moment of the last save, so an editor who was
        // looking at an older profile loses to whoever saved first instead of
        // overwriting them. The school row itself always exists here, so no
        // rows updated can only mean somebody got in first.
        const current = await conn.client.query<{ touched: string }>(
          `SELECT ${TOUCH_VERSION_SQL} AS touched FROM schools WHERE id = $1`,
          [context.schoolId],
        )
        assertVersion(body.expectedVersion, Number(requireFound(current.rows[0]).touched))

        const updated = await conn.client.query<SchoolRow>(
          `UPDATE schools
              SET name = $2, short_name = $3, board = $4,
                  address = jsonb_build_object('line', $5::text),
                  phone = $6, email = $7, affiliation_number = $8, udise_code = $9,
                  updated_at = clock_timestamp()
            WHERE id = $1 AND ${TOUCH_VERSION_SQL} = $10
        RETURNING id, name, short_name AS "shortName", board, address->>'line' AS address,
                  phone, email, affiliation_number AS "affiliationNumber", udise_code AS "udiseCode",
                  ${TOUCH_VERSION_SQL} AS touched`,
          [
            context.schoolId,
            body.name,
            body.shortName,
            body.board,
            body.address,
            body.phone,
            body.email,
            body.affiliationNumber ?? null,
            body.udiseCode ?? null,
            String(body.expectedVersion),
          ],
        )
        if (updated.rowCount === 0) throw new ApiFailure('VERSION_CONFLICT')
        const row = requireFound(updated.rows[0])
        await writeAudit(conn, context, {
          action: 'school.update',
          targetType: 'school',
          targetId: context.schoolId,
          summary: 'Updated the school profile details.',
          safeChanges: { fields: Object.keys(body).filter((key) => key !== 'expectedVersion') },
        })
        return toProfile(row)
      }),
  })
}
