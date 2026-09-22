import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  FeeConcession,
  FeeConcessionCreateRequest,
  FeeConcessionRemoveRequest,
  FeeDeleteQuery,
  FeeOptIn,
  FeeOptInCreateRequest,
  FeeOptInUpdateRequest,
} from '@erp/contracts'
import type { AuthorizationDecision, RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  assertUuidParam,
  assertVersion,
  bumpVersion,
  decideResource,
  lockSchool,
  protectedRoute,
  requireFound,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  projectFeeConcession,
  projectFeeOptIn,
  type FeeConcessionRow,
  type FeeOptInRow,
} from './project.ts'

/**
 * One pupil's own fees: the optional heads they take (the bus, a club) and the
 * concessions they are given. Neither is money that has moved; both change
 * what the pupil is charged, so both are `fees.manage` and both leave one
 * audit row that names ids and nothing else.
 *
 * A reason somebody typed goes to the audit note and is stored nowhere else:
 * a hardship story is never a column and never a safe change.
 */

/** The connection withTenantTransaction hands a module handler. */
interface FeeConnection {
  readonly client: PoolClient
  readonly db: NodePgDatabase
}

/**
 * A refusal on a record somebody named is the same answer as a record that is
 * not there. Two-step verification is the one refusal worth saying out loud.
 */
function assertRecordAllowed(decision: AuthorizationDecision): void {
  if (decision.allowed) return
  throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
}

async function decide(
  conn: FeeConnection,
  context: RequestContext,
  id: string,
): Promise<AuthorizationDecision> {
  return decideResource(conn, context, 'fees.manage', 'fee', id)
}

interface YearRow {
  start_date: string
  end_date: string
}

/**
 * The academic year this pupil is being charged in. It must be this school's,
 * and the pupil must have an enrolment in it: a year they never sat in charges
 * them nothing, so an optional fee or a concession there would be a mistake
 * nobody would ever see on a statement.
 */
async function requireEnrolledYear(
  conn: FeeConnection,
  schoolId: string,
  studentId: string,
  academicYearId: string,
): Promise<YearRow> {
  const year = await conn.client.query<YearRow>(
    `SELECT to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date
       FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, academicYearId],
  )
  const row = year.rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  const enrolled = await conn.client.query(
    `SELECT 1 FROM enrollments
      WHERE school_id = $1 AND student_id = $2 AND academic_year_id = $3 LIMIT 1`,
    [schoolId, studentId, academicYearId],
  )
  if (enrolled.rowCount === 0) throw new ApiFailure('INVALID_REQUEST')
  return row
}

/** A head of this school, with the kind of head the route needs. */
async function requireHead(
  conn: FeeConnection,
  schoolId: string,
  feeHeadId: string,
  appliesTo: 'opt_in' | null,
): Promise<void> {
  const head = await conn.client.query<{ applies_to: string }>(
    'SELECT applies_to FROM fee_heads WHERE school_id = $1 AND id = $2',
    [schoolId, feeHeadId],
  )
  const row = head.rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  // Only an optional head can be taken by one pupil; a class head is charged
  // to everybody in the class through the fee structure.
  if (appliesTo !== null && row.applies_to !== appliesTo) throw new ApiFailure('INVALID_REQUEST')
}

/** One optional fee as it now stands. */
async function readOptIn(conn: FeeConnection, schoolId: string, id: string) {
  const result = await conn.db.execute<FeeOptInRow>(
    sql`SELECT o.id, o.fee_head_id, h.name AS fee_head_name, o.amount_paise, o.starts_on, o.ends_on, o.version
          FROM fee_student_heads o
          JOIN fee_heads h ON h.school_id = o.school_id AND h.id = o.fee_head_id
         WHERE o.school_id = ${schoolId}::uuid AND o.id = ${id}::uuid`,
  )
  return projectFeeOptIn(requireFound(result.rows[0]))
}

/** One concession as it now stands. */
async function readConcession(conn: FeeConnection, schoolId: string, id: string) {
  const result = await conn.db.execute<FeeConcessionRow>(
    sql`SELECT c.id, c.fee_head_id, h.name AS fee_head_name, c.category, c.kind,
               c.percent_bp, c.amount_paise, c.version
          FROM fee_concessions c
          LEFT JOIN fee_heads h ON h.school_id = c.school_id AND h.id = c.fee_head_id
         WHERE c.school_id = ${schoolId}::uuid AND c.id = ${id}::uuid`,
  )
  return projectFeeConcession(requireFound(result.rows[0]))
}

export function registerFeePupilRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/students/:studentId/opt-ins',
    permission: 'fees.manage',
    body: FeeOptInCreateRequest,
    response: FeeOptIn,
    successStatus: 201,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const studentId = assertUuidParam(param('studentId'))
        await lockSchool(conn, context.schoolId)
        // The pupil's fee account is the record being changed, so the decision
        // is taken on the pupil and not on the school as a whole.
        assertRecordAllowed(await decide(conn, context, studentId))

        const year = await requireEnrolledYear(conn, context.schoolId, studentId, body.academicYearId)
        await requireHead(conn, context.schoolId, body.feeHeadId, 'opt_in')
        // The instalments charged are bounded by the year, so a start outside
        // it would charge nothing at all.
        if (body.startsOn < year.start_date || body.startsOn > year.end_date) {
          throw new ApiFailure('INVALID_REQUEST')
        }
        const duplicate = await conn.client.query(
          `SELECT 1 FROM fee_student_heads
            WHERE school_id = $1 AND student_id = $2 AND academic_year_id = $3 AND fee_head_id = $4
            LIMIT 1`,
          [context.schoolId, studentId, body.academicYearId, body.feeHeadId],
        )
        if (duplicate.rowCount !== null && duplicate.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO fee_student_heads
             (school_id, student_id, academic_year_id, fee_head_id, amount_paise, starts_on, ends_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            context.schoolId,
            studentId,
            body.academicYearId,
            body.feeHeadId,
            body.amountPaise ?? null,
            body.startsOn,
            body.endsOn ?? null,
          ],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Added an optional fee for a pupil.',
          safeChanges: {
            optInId: id,
            studentId,
            academicYearId: body.academicYearId,
            feeHeadId: body.feeHeadId,
          },
        })
        return readOptIn(conn, context.schoolId, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/fees/opt-ins/:optInId',
    permission: 'fees.manage',
    body: FeeOptInUpdateRequest,
    response: FeeOptIn,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = assertUuidParam(param('optInId'))
        await lockSchool(conn, context.schoolId)
        assertRecordAllowed(await decide(conn, context, id))

        const existing = await conn.client.query<{ starts_on: string }>(
          `SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on
             FROM fee_student_heads WHERE school_id = $1 AND id = $2`,
          [context.schoolId, id],
        )
        const row = requireFound(existing.rows[0])
        // The end date is only ever moved against the start date the row was
        // written with, which the body cannot change.
        if (body.endsOn !== null && body.endsOn < row.starts_on) throw new ApiFailure('INVALID_REQUEST')

        await bumpVersion(conn, 'fee_student_heads', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: { amount_paise: body.amountPaise, ends_on: body.endsOn },
        })
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Changed an optional fee for a pupil.',
          safeChanges: { optInId: id },
        })
        return readOptIn(conn, context.schoolId, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/fees/opt-ins/:optInId',
    permission: 'fees.manage',
    query: FeeDeleteQuery,
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, query, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = assertUuidParam(param('optInId'))
        await lockSchool(conn, context.schoolId)
        assertRecordAllowed(await decide(conn, context, id))

        const existing = await conn.client.query<{
          version: number
          student_id: string
          academic_year_id: string
          fee_head_id: string
        }>(
          `SELECT version, student_id, academic_year_id, fee_head_id
             FROM fee_student_heads WHERE school_id = $1 AND id = $2`,
          [context.schoolId, id],
        )
        const row = requireFound(existing.rows[0])
        assertVersion(query.expectedVersion, Number(row.version))
        // Money already taken for this fee stands on the row, so the row stays
        // and the school gives it an end date instead.
        const paid = await conn.client.query(
          `SELECT 1 FROM fee_receipt_lines line
             JOIN fee_receipts r ON r.school_id = line.school_id AND r.id = line.receipt_id
            WHERE line.school_id = $1 AND line.fee_head_id = $2
              AND r.student_id = $3 AND r.academic_year_id = $4
            LIMIT 1`,
          [context.schoolId, row.fee_head_id, row.student_id, row.academic_year_id],
        )
        if (paid.rowCount !== null && paid.rowCount > 0) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_opt_in_has_payments')
        }

        await conn.client.query('DELETE FROM fee_student_heads WHERE school_id = $1 AND id = $2', [
          context.schoolId,
          id,
        ])
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Removed an optional fee from a pupil.',
          safeChanges: {
            optInId: id,
            studentId: row.student_id,
            academicYearId: row.academic_year_id,
            feeHeadId: row.fee_head_id,
          },
        })
        return null
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/students/:studentId/concessions',
    permission: 'fees.manage',
    body: FeeConcessionCreateRequest,
    response: FeeConcession,
    successStatus: 201,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const studentId = assertUuidParam(param('studentId'))
        await lockSchool(conn, context.schoolId)
        assertRecordAllowed(await decide(conn, context, studentId))

        await requireEnrolledYear(conn, context.schoolId, studentId, body.academicYearId)
        // A concession may name any head, or none at all, in which case it
        // comes off every head the pupil is charged.
        if (body.feeHeadId !== undefined) {
          await requireHead(conn, context.schoolId, body.feeHeadId, null)
        }

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO fee_concessions
             (school_id, student_id, academic_year_id, fee_head_id, category, kind, percent_bp, amount_paise)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            context.schoolId,
            studentId,
            body.academicYearId,
            body.feeHeadId ?? null,
            body.category,
            body.kind,
            body.percentBp ?? null,
            body.amountPaise ?? null,
          ],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Gave a pupil a concession.',
          safeChanges: {
            concessionId: id,
            studentId,
            academicYearId: body.academicYearId,
            feeHeadId: body.feeHeadId ?? null,
            category: body.category,
            kind: body.kind,
          },
          // What somebody typed lives in the note, which can be redacted.
          note: body.reason,
        })
        return readConcession(conn, context.schoolId, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/concessions/:concessionId/remove',
    permission: 'fees.manage',
    body: FeeConcessionRemoveRequest,
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = assertUuidParam(param('concessionId'))
        await lockSchool(conn, context.schoolId)
        assertRecordAllowed(await decide(conn, context, id))

        const existing = await conn.client.query<{
          version: number
          student_id: string
          academic_year_id: string
          fee_head_id: string | null
          category: string
          kind: string
        }>(
          `SELECT version, student_id, academic_year_id, fee_head_id, category, kind
             FROM fee_concessions WHERE school_id = $1 AND id = $2`,
          [context.schoolId, id],
        )
        const row = requireFound(existing.rows[0])
        assertVersion(body.expectedVersion, Number(row.version))

        await conn.client.query('DELETE FROM fee_concessions WHERE school_id = $1 AND id = $2', [
          context.schoolId,
          id,
        ])
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: id,
          summary: 'Took a concession off a pupil.',
          safeChanges: {
            concessionId: id,
            studentId: row.student_id,
            academicYearId: row.academic_year_id,
            feeHeadId: row.fee_head_id,
            category: row.category,
            kind: row.kind,
          },
          note: body.reason,
        })
        return null
      }),
  })
}
