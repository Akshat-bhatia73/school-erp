import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  FeeDeleteQuery,
  FeeHead,
  FeeHeadCreateRequest,
  FeeHeadList,
  FeeHeadUpdateRequest,
  FeeStructure,
  FeeStructureCreateRequest,
  FeeStructureList,
  FeeStructureListRequest,
  FeeStructureUpdateRequest,
} from '@erp/contracts'
import type { AuthorizationDecision, RequestContext } from '@erp/contracts/server'
import { feeScopedTable, planPredicate } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import {
  allowedActionsFor,
  allowedActionsForMany,
  ApiFailure,
  assertUuidParam,
  assertVersion,
  authorizeSchoolAction,
  bumpVersion,
  decideResource,
  lockSchool,
  protectedRoute,
  readPlan,
  requireFound,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  FEE_HEAD_COLUMNS,
  projectFeeHead,
  projectFeeStructure,
  type FeeHeadRow,
  type FeeStructureRow,
} from './project.ts'

/**
 * What the school charges: its own list of fee heads, and the amount of each
 * head for an academic year and a class. Nothing here is about one pupil and
 * nothing here is money that has moved; both of those live in their own files.
 */

/** The connection withTenantTransaction hands a module handler. */
interface FeeConnection {
  readonly client: PoolClient
  readonly db: NodePgDatabase
}

/** The decision for one fee record this caller named in the path. */
async function decide(
  conn: FeeConnection,
  context: RequestContext,
  id: string,
): Promise<AuthorizationDecision> {
  return decideResource(conn, context, 'fees.manage', 'fee', id)
}

/**
 * A refusal on a record somebody named is the same answer as a record that is
 * not there, so holding the permission never tells a caller which records
 * exist. Two-step verification is the one refusal worth saying out loud.
 */
function assertRecordAllowed(decision: AuthorizationDecision): void {
  if (decision.allowed) return
  throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
}

/** The school already has a head by this name, ignoring case and spaces. */
async function assertNameFree(
  conn: FeeConnection,
  schoolId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const clash = await conn.client.query(
    `SELECT 1 FROM fee_heads
      WHERE school_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND ($3::uuid IS NULL OR id <> $3)
      LIMIT 1`,
    [schoolId, name, exceptId],
  )
  if (clash.rowCount !== null && clash.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')
}

/** A row of this school, or a plain bad request when the body named another. */
async function assertInSchool(
  conn: FeeConnection,
  table: 'academic_years' | 'grades' | 'fee_heads',
  schoolId: string,
  id: string,
): Promise<void> {
  const found = await conn.client.query(`SELECT 1 FROM ${table} WHERE school_id = $1 AND id = $2`, [
    schoolId,
    id,
  ])
  if (found.rowCount === 0) throw new ApiFailure('INVALID_REQUEST')
}

/** The head as it now stands, with what this caller may still do to it. */
async function readHead(
  conn: FeeConnection,
  context: RequestContext,
  id: string,
) {
  const result = await conn.db.execute<FeeHeadRow>(
    sql`SELECT ${sql.raw(FEE_HEAD_COLUMNS)} FROM fee_heads
         WHERE fee_heads.school_id = ${context.schoolId}::uuid AND fee_heads.id = ${id}::uuid`,
  )
  const actions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'fee',
    id,
  })
  return projectFeeHead(requireFound(result.rows[0]), actions)
}

const STRUCTURE_COLUMNS = sql`fee_structures.id, fee_structures.academic_year_id, y.name AS academic_year_name,
         fee_structures.fee_head_id, h.name AS fee_head_name, h.frequency, h.applies_to,
         fee_structures.grade_id, g.name AS grade_name, fee_structures.amount_paise, fee_structures.version`

const STRUCTURE_JOINS = sql`FROM fee_structures
        JOIN academic_years y ON y.school_id = fee_structures.school_id AND y.id = fee_structures.academic_year_id
        JOIN fee_heads h ON h.school_id = fee_structures.school_id AND h.id = fee_structures.fee_head_id
        LEFT JOIN grades g ON g.school_id = fee_structures.school_id AND g.id = fee_structures.grade_id`

/** The amount as it now stands, with what this caller may still do to it. */
async function readStructure(
  conn: FeeConnection,
  context: RequestContext,
  id: string,
) {
  const result = await conn.db.execute<FeeStructureRow>(
    sql`SELECT ${STRUCTURE_COLUMNS} ${STRUCTURE_JOINS}
         WHERE fee_structures.school_id = ${context.schoolId}::uuid AND fee_structures.id = ${id}::uuid`,
  )
  const actions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'fee',
    id,
  })
  return projectFeeStructure(requireFound(result.rows[0]), actions)
}

export function registerFeeSetupRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/fees/heads',
    permission: 'fees.read',
    response: FeeHeadList,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'fees.read', 'fee')
        // A parent's plan reaches no head at all, by design: they see the
        // names of the fees their own child is charged, on the statement.
        const result = await conn.db.execute<FeeHeadRow>(
          sql`SELECT ${sql.raw(FEE_HEAD_COLUMNS)} FROM fee_heads
               WHERE ${planPredicate(plan, feeScopedTable('head'))}
               ORDER BY fee_heads.name, fee_heads.id`,
        )
        const rows = [...result.rows]
        const actions = await allowedActionsForMany(
          conn,
          context,
          'fee',
          rows.map((row) => row.id),
        )
        return rows.map((row) => projectFeeHead(row, actions.get(row.id) ?? []))
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/heads',
    permission: 'fees.manage',
    body: FeeHeadCreateRequest,
    response: FeeHead,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'fees.manage')
        await assertNameFree(conn, context.schoolId, body.name, null)

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO fee_heads(school_id, name, category, applies_to, frequency)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [context.schoolId, body.name, body.category, body.appliesTo, body.frequency],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Added a fee head.',
          safeChanges: {
            feeHeadId: id,
            category: body.category,
            appliesTo: body.appliesTo,
            frequency: body.frequency,
          },
        })
        return readHead(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/fees/heads/:headId',
    permission: 'fees.manage',
    body: FeeHeadUpdateRequest,
    response: FeeHead,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = assertUuidParam(param('headId'))
        await lockSchool(conn, context.schoolId)
        assertRecordAllowed(await decide(conn, context, id))
        await assertNameFree(conn, context.schoolId, body.name, id)

        await bumpVersion(conn, 'fee_heads', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: { name: body.name, category: body.category, active: body.active },
        })
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Changed a fee head.',
          safeChanges: { feeHeadId: id, category: body.category, active: body.active },
        })
        return readHead(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/fees/heads/:headId',
    permission: 'fees.manage',
    query: FeeDeleteQuery,
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, query, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = assertUuidParam(param('headId'))
        await lockSchool(conn, context.schoolId)
        assertRecordAllowed(await decide(conn, context, id))

        const existing = await conn.client.query<{ version: number }>(
          'SELECT version FROM fee_heads WHERE school_id = $1 AND id = $2',
          [context.schoolId, id],
        )
        assertVersion(query.expectedVersion, Number(requireFound(existing.rows[0]).version))
        // A head that anything still stands on stays: retiring it (active =
        // false) is how a school stops charging it without rewriting history.
        for (const table of ['fee_structures', 'fee_student_heads', 'fee_concessions', 'fee_receipt_lines']) {
          const used = await conn.client.query(
            `SELECT 1 FROM ${table} WHERE school_id = $1 AND fee_head_id = $2 LIMIT 1`,
            [context.schoolId, id],
          )
          if (used.rowCount !== null && used.rowCount > 0) {
            throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_head_in_use')
          }
        }

        await conn.client.query('DELETE FROM fee_heads WHERE school_id = $1 AND id = $2', [
          context.schoolId,
          id,
        ])
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Removed a fee head.',
          safeChanges: { feeHeadId: id },
        })
        return null
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/fees/structures',
    permission: 'fees.read',
    query: FeeStructureListRequest,
    response: FeeStructureList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'fees.read', 'fee')
        // A class filter keeps the rows for that class and the rows for every
        // class, because both of them charge a pupil sitting in it.
        const grade =
          query.gradeId === undefined
            ? sql`TRUE`
            : sql`(fee_structures.grade_id = ${query.gradeId}::uuid OR fee_structures.grade_id IS NULL)`
        const result = await conn.db.execute<FeeStructureRow>(
          sql`SELECT ${STRUCTURE_COLUMNS} ${STRUCTURE_JOINS}
               WHERE ${planPredicate(plan, feeScopedTable('structure'))}
                 AND fee_structures.academic_year_id = ${query.academicYearId}::uuid
                 AND ${grade}
               ORDER BY h.name, g.name NULLS FIRST, fee_structures.id`,
        )
        const rows = [...result.rows]
        const actions = await allowedActionsForMany(
          conn,
          context,
          'fee',
          rows.map((row) => row.id),
        )
        return rows.map((row) => projectFeeStructure(row, actions.get(row.id) ?? []))
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/structures',
    permission: 'fees.manage',
    body: FeeStructureCreateRequest,
    response: FeeStructure,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'fees.manage')
        await assertInSchool(conn, 'academic_years', context.schoolId, body.academicYearId)
        await assertInSchool(conn, 'fee_heads', context.schoolId, body.feeHeadId)
        if (body.gradeId !== undefined) {
          await assertInSchool(conn, 'grades', context.schoolId, body.gradeId)
        }

        const duplicate = await conn.client.query(
          `SELECT 1 FROM fee_structures
            WHERE school_id = $1 AND academic_year_id = $2 AND fee_head_id = $3
              AND grade_id IS NOT DISTINCT FROM $4::uuid
            LIMIT 1`,
          [context.schoolId, body.academicYearId, body.feeHeadId, body.gradeId ?? null],
        )
        if (duplicate.rowCount !== null && duplicate.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO fee_structures(school_id, academic_year_id, fee_head_id, grade_id, amount_paise)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            context.schoolId,
            body.academicYearId,
            body.feeHeadId,
            body.gradeId ?? null,
            body.amountPaise,
          ],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Set a fee amount for a class.',
          safeChanges: {
            feeStructureId: id,
            academicYearId: body.academicYearId,
            feeHeadId: body.feeHeadId,
            gradeId: body.gradeId ?? null,
          },
        })
        return readStructure(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/fees/structures/:structureId',
    permission: 'fees.manage',
    body: FeeStructureUpdateRequest,
    response: FeeStructure,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = assertUuidParam(param('structureId'))
        await lockSchool(conn, context.schoolId)
        assertRecordAllowed(await decide(conn, context, id))

        await bumpVersion(conn, 'fee_structures', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: { amount_paise: body.amountPaise },
        })
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Changed a fee amount.',
          safeChanges: { feeStructureId: id },
        })
        return readStructure(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/fees/structures/:structureId',
    permission: 'fees.manage',
    query: FeeDeleteQuery,
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, query, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = assertUuidParam(param('structureId'))
        await lockSchool(conn, context.schoolId)
        assertRecordAllowed(await decide(conn, context, id))

        const existing = await conn.client.query<{
          version: number
          academic_year_id: string
          fee_head_id: string
        }>(
          'SELECT version, academic_year_id, fee_head_id FROM fee_structures WHERE school_id = $1 AND id = $2',
          [context.schoolId, id],
        )
        const row = requireFound(existing.rows[0])
        assertVersion(query.expectedVersion, Number(row.version))
        // Money already taken against this fee this year stands on the amount,
        // so the amount is changed rather than taken away.
        const paid = await conn.client.query(
          `SELECT 1 FROM fee_receipt_lines line
             JOIN fee_receipts r ON r.school_id = line.school_id AND r.id = line.receipt_id
            WHERE line.school_id = $1 AND line.fee_head_id = $2 AND r.academic_year_id = $3
            LIMIT 1`,
          [context.schoolId, row.fee_head_id, row.academic_year_id],
        )
        if (paid.rowCount !== null && paid.rowCount > 0) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_structure_has_payments')
        }

        await conn.client.query('DELETE FROM fee_structures WHERE school_id = $1 AND id = $2', [
          context.schoolId,
          id,
        ])
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Removed a fee amount.',
          safeChanges: {
            feeStructureId: id,
            academicYearId: row.academic_year_id,
            feeHeadId: row.fee_head_id,
          },
        })
        return null
      }),
  })
}
