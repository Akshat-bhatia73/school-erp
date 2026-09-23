import type { FastifyInstance } from 'fastify'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { SetupSchoolProfile, UpdateSchoolRequest, type PermissionKey } from '@erp/contracts'
import { schools } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import { allowedActionsFor, authorizeSchoolAction } from '../shared/authorize.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { bumpVersion } from '../shared/version.ts'
import { requireFound } from '../shared/errors.ts'
import { optional } from './common.ts'

type Profile = z.infer<typeof SetupSchoolProfile>

/**
 * The address is stored as a small object so it can grow later. An older row
 * may hold a plain string instead; it reads as that text, so opening the
 * profile and saving it does not wipe the address.
 */
const ADDRESS_LINE = sql<string | null>`CASE WHEN jsonb_typeof(${schools.address}) = 'string'
  THEN ${schools.address} #>> '{}' ELSE ${schools.address}->>'line' END`

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
  readonly version: number
  readonly logoContentType: string | null
  readonly logoUpdatedAt: string | null
}

/** The profile as the contract wants it, read the same way before and after a save. */
const columns = {
  id: schools.id,
  name: schools.name,
  shortName: schools.shortName,
  board: schools.board,
  address: ADDRESS_LINE,
  phone: schools.phone,
  email: schools.email,
  affiliationNumber: schools.affiliationNumber,
  udiseCode: schools.udiseCode,
  version: schools.version,
  // Whether there is a logo and when it changed; the key itself stays here.
  logoContentType: sql<string | null>`CASE WHEN ${schools.logoStorageKey} IS NULL THEN NULL ELSE ${schools.logoContentType} END`,
  logoUpdatedAt: sql<string | null>`to_char(${schools.logoUpdatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
}

const BOARDS = ['cbse', 'icse', 'state', 'ib', 'other'] as const
type Board = (typeof BOARDS)[number]

/** A board nobody has chosen yet reads as "other" rather than failing. */
function boardOf(value: string | null): Board {
  return BOARDS.find((board) => board === value) ?? 'other'
}

function toProfile(row: SchoolRow, allowedActions: readonly PermissionKey[]): Profile {
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
    version: row.version,
    ...((row.logoContentType === 'image/png' || row.logoContentType === 'image/jpeg') && row.logoUpdatedAt !== null
      ? { logo: { contentType: row.logoContentType, updatedAt: row.logoUpdatedAt } }
      : {}),
    allowedActions: [...allowedActions],
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
          .select(columns)
          .from(schools)
          .where(eq(schools.id, context.schoolId))
          .limit(1)
        const actions = await allowedActionsFor(conn, context, {
          schoolId: context.schoolId,
          resourceType: 'school',
          id: context.schoolId,
        })
        return toProfile(requireFound(rows[0]), actions)
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
        // The school is its own tenant, so the version is keyed by the school
        // id alone. bumpVersion answers VERSION_CONFLICT when somebody saved
        // first, so an editor holding an older profile never overwrites them.
        await bumpVersion(conn, 'schools', {
          schoolId: context.schoolId,
          id: context.schoolId,
          expectedVersion: body.expectedVersion,
          set: {
            name: body.name,
            short_name: body.shortName,
            board: body.board,
            // A jsonb column takes an already stringified value, the same
            // small object the profile has always stored.
            address: JSON.stringify({ line: body.address }),
            phone: body.phone,
            email: body.email,
            affiliation_number: body.affiliationNumber ?? null,
            udise_code: body.udiseCode ?? null,
          },
        })
        await writeAudit(conn, context, {
          action: 'school.update',
          targetType: 'school',
          targetId: context.schoolId,
          summary: 'Updated the school profile details.',
          safeChanges: { fields: Object.keys(body).filter((key) => key !== 'expectedVersion') },
        })
        const rows = await conn.db
          .select(columns)
          .from(schools)
          .where(eq(schools.id, context.schoolId))
          .limit(1)
        const actions = await allowedActionsFor(conn, context, {
          schoolId: context.schoolId,
          resourceType: 'school',
          id: context.schoolId,
        })
        return toProfile(requireFound(rows[0]), actions)
      }),
  })
}
