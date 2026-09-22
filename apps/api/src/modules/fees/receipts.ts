import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import {
  FeeAdjustmentRequest,
  FeeCancelRequest,
  FeeCollectRequest,
  FeeReceiptDetail,
  FeeReceiptListRequest,
  FeeReceiptPage,
  type FeeReceiptSummary,
  FeeRefundRequest,
  type PermissionKey,
} from '@erp/contracts'
import { AuthorizationError, feeScopedTable, planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  allocateReceiptNumber,
  allowedActionsFor,
  allowedActionsForMany,
  ApiFailure,
  assertUuidParam,
  decideResource,
  lockSchool,
  protectedRoute,
  readPlan,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { feeFiguresCte, schoolToday, toPaise } from './charges.ts'

/**
 * The ledger: reading it, and the four ways a row joins it.
 *
 * Nothing here is ever edited. A payment is taken, and a refund, a
 * cancellation or an adjustment is a new row that points back at it. Every
 * read is bounded by the caller's own plans, and every write decides the
 * record again, checks the amount against the balance the shared charges CTE
 * works out, and writes exactly one audit row.
 */

/** The tenant transaction a fee read or write runs on. */
export type FeeConnection = AuthzConnection

/** The longest an unpaged ledger read may be, so a file never asks for all. */
const LEDGER_CAP = 500

function table(kind: 'student' | 'section') {
  const scoped = scopedTableFor(kind)
  if (!scoped) throw new Error(`the authorizer has no scoped table for ${kind}`)
  return scoped
}

/**
 * The two predicates every fee read shares: which pupils this caller may see
 * as people (the fee account plan and the basic student plan together, over
 * the unaliased `students` table), and which ledger rows they may see (over
 * the unaliased `fee_receipts` table).
 */
export interface FeePlans {
  readonly pupils: SQL
  readonly receipts: SQL
}

export async function feePlans(conn: FeeConnection, context: RequestContext): Promise<FeePlans> {
  const account = await readPlan(conn, context, 'fees.read', 'fee')
  const basic = await readPlan(conn, context, 'students.read_basic', 'student')
  return {
    pupils: sql`(${planPredicate(account, feeScopedTable('account'))}) AND (${planPredicate(basic, table('student'))})`,
    receipts: planPredicate(account, feeScopedTable('receipt')),
  }
}

/**
 * Which sections the caller may read, for the class on a fee row. A caller
 * with no section grant at all simply sees no class, exactly as the roster
 * omits one it may not read.
 */
export async function sectionVisibility(conn: FeeConnection, context: RequestContext): Promise<SQL> {
  try {
    return planPredicate(await readPlan(conn, context, 'sections.read', 'section'), table('section'))
  } catch (error) {
    if (error instanceof AuthorizationError) return sql`FALSE`
    throw error
  }
}

/** A row of the ledger read, with everything both the list and the detail need. */
interface ReceiptRow extends Record<string, unknown> {
  id: string
  receipt_number: string
  kind: string
  amount_paise: string
  mode: string | null
  reference: string | null
  payer_name: string | null
  received_on: string
  recorded_at: string
  student_id: string
  first_name: string
  last_name: string | null
  admission_number: string
  year_id: string
  year_name: string
  grade_id: string | null
  grade_name: string | null
  section_id: string | null
  section_name: string | null
  reverses_id: string | null
  reverses_number: string | null
  cancelled: boolean
  refunded_paise: string
}

export interface ReceiptFilters {
  readonly academicYearId?: string
  readonly studentId?: string
  readonly from?: string
  readonly to?: string
  readonly mode?: string
  readonly kind?: string
  readonly q?: string
  readonly ids?: readonly string[]
}

/**
 * The one FROM and WHERE the list, its totals and the detail read all share,
 * so a row appears in a register exactly when its own receipt would open. The
 * ledger table and the students table are unaliased, because that is how both
 * plan predicates name them.
 */
function receiptSource(schoolId: string, plans: FeePlans, sections: SQL, filters: ReceiptFilters): SQL {
  const school = sql`${schoolId}::uuid`
  const parts: SQL[] = [sql`fee_receipts.school_id = ${school}`, plans.receipts, plans.pupils]
  if (filters.academicYearId !== undefined) {
    parts.push(sql`fee_receipts.academic_year_id = ${filters.academicYearId}::uuid`)
  }
  if (filters.studentId !== undefined) {
    parts.push(sql`fee_receipts.student_id = ${filters.studentId}::uuid`)
  }
  if (filters.from !== undefined) parts.push(sql`fee_receipts.received_on >= ${filters.from}::date`)
  if (filters.to !== undefined) parts.push(sql`fee_receipts.received_on <= ${filters.to}::date`)
  if (filters.mode !== undefined) parts.push(sql`fee_receipts.mode = ${filters.mode}`)
  if (filters.kind !== undefined) parts.push(sql`fee_receipts.kind = ${filters.kind}`)
  if (filters.ids !== undefined) {
    if (filters.ids.length === 0) parts.push(sql`FALSE`)
    else {
      const list = sql.join(filters.ids.map((value) => sql`${value}::uuid`), sql`, `)
      parts.push(sql`fee_receipts.id IN (${list})`)
    }
  }
  if (filters.q !== undefined && filters.q !== '') {
    // Only what the row already shows is searchable: the number on it, the
    // pupil's name and their admission number.
    const like = `%${filters.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
    parts.push(
      sql`(fee_receipts.receipt_number ILIKE ${like} ESCAPE '\\'
        OR students.first_name ILIKE ${like} ESCAPE '\\'
        OR students.last_name ILIKE ${like} ESCAPE '\\'
        OR students.admission_number ILIKE ${like} ESCAPE '\\')`,
    )
  }
  const where = parts.reduce((carry, part) => sql`${carry} AND (${part})`)
  return sql`FROM fee_receipts
      JOIN students ON students.school_id = fee_receipts.school_id AND students.id = fee_receipts.student_id
      JOIN academic_years ay ON ay.school_id = fee_receipts.school_id
        AND ay.id = fee_receipts.academic_year_id
      LEFT JOIN LATERAL (
        SELECT en.section_id FROM enrollments en
         WHERE en.school_id = fee_receipts.school_id AND en.student_id = fee_receipts.student_id
           AND en.academic_year_id = fee_receipts.academic_year_id
         ORDER BY (en.left_on IS NULL) DESC, en.joined_on DESC, en.id LIMIT 1
      ) enr ON TRUE
      LEFT JOIN sections ON sections.school_id = fee_receipts.school_id AND sections.id = enr.section_id
        AND (${sections})
      LEFT JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
      LEFT JOIN fee_receipts reversed ON reversed.school_id = fee_receipts.school_id
        AND reversed.id = fee_receipts.reverses_receipt_id
     WHERE ${where}`
}

/** What has happened to a payment since it was taken, as the contract says it. */
function stateOf(row: ReceiptRow): FeeReceiptSummary['state'] {
  if (row.kind !== 'payment') return undefined
  if (row.cancelled) return 'cancelled'
  const refunded = toPaise(row.refunded_paise)
  if (refunded <= 0) return 'standing'
  return refunded >= toPaise(row.amount_paise) ? 'refunded' : 'partly_refunded'
}

function projectSummary(row: ReceiptRow, allowedActions: readonly PermissionKey[]): FeeReceiptSummary {
  const state = stateOf(row)
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    kind: row.kind as FeeReceiptSummary['kind'],
    amountPaise: toPaise(row.amount_paise),
    ...(row.mode === null ? {} : { mode: row.mode as NonNullable<FeeReceiptSummary['mode']> }),
    receivedOn: row.received_on,
    student: {
      id: row.student_id,
      name: [row.first_name, row.last_name].filter((part) => part !== null && part !== '').join(' '),
      admissionNumber: row.admission_number,
      ...(row.grade_id === null || row.grade_name === null
        ? {}
        : { grade: { id: row.grade_id, name: row.grade_name } }),
      ...(row.section_id === null || row.section_name === null
        ? {}
        : { section: { id: row.section_id, name: row.section_name } }),
    },
    academicYear: { id: row.year_id, name: row.year_name },
    ...(state === undefined ? {} : { state }),
    ...(row.reverses_id === null || row.reverses_number === null
      ? {}
      : { reverses: { id: row.reverses_id, receiptNumber: row.reverses_number } }),
    allowedActions: [...allowedActions],
  }
}

const RECEIPT_COLUMNS = sql`SELECT fee_receipts.id, fee_receipts.receipt_number, fee_receipts.kind,
      fee_receipts.amount_paise::text AS amount_paise, fee_receipts.mode, fee_receipts.reference,
      fee_receipts.payer_name,
      to_char(fee_receipts.received_on, 'YYYY-MM-DD') AS received_on,
      to_char(fee_receipts.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF:00') AS recorded_at,
      fee_receipts.student_id, students.first_name, students.last_name, students.admission_number,
      ay.id AS year_id, ay.name AS year_name,
      grades.id AS grade_id, grades.name AS grade_name,
      sections.id AS section_id, sections.name AS section_name,
      reversed.id AS reverses_id, reversed.receipt_number AS reverses_number,
      EXISTS (SELECT 1 FROM fee_receipts cancel
               WHERE cancel.school_id = fee_receipts.school_id
                 AND cancel.reverses_receipt_id = fee_receipts.id
                 AND cancel.kind = 'cancellation') AS cancelled,
      COALESCE((SELECT sum(back.amount_paise) FROM fee_receipts back
                 WHERE back.school_id = fee_receipts.school_id
                   AND back.reverses_receipt_id = fee_receipts.id
                   AND back.kind = 'refund'), 0)::text AS refunded_paise `

/**
 * The ledger rows the caller may read, newest first. Without a page it
 * answers every one of them, capped, which is what a file needs; with a page
 * it answers that page and counts the rest.
 */
export async function listReceipts(
  conn: FeeConnection,
  context: RequestContext,
  filters: ReceiptFilters,
  paging?: { readonly page: number; readonly pageSize: number },
): Promise<{
  items: FeeReceiptSummary[]
  total: number
  totals: { collectedPaise: number; refundedPaise: number; cancelledPaise: number; netPaise: number }
}> {
  const plans = await feePlans(conn, context)
  const sections = await sectionVisibility(conn, context)
  const source = receiptSource(context.schoolId, plans, sections, filters)
  const limit = paging ? paging.pageSize : LEDGER_CAP
  const offset = paging ? (paging.page - 1) * paging.pageSize : 0
  const rows = await conn.db.execute<ReceiptRow>(
    sql`${RECEIPT_COLUMNS} ${source}
        ORDER BY fee_receipts.received_on DESC, fee_receipts.created_at DESC, fee_receipts.id
        LIMIT ${limit} OFFSET ${offset}`,
  )
  // The count and the money are over every row the filters and the plans
  // select, never over the page: a register's footer describes the search.
  const counted = await conn.db.execute<{
    total: number
    collected: string
    refunded: string
    cancelled: string
  }>(
    sql`SELECT count(*)::int AS total,
        COALESCE(sum(fee_receipts.amount_paise) FILTER (
          WHERE fee_receipts.kind = 'payment' AND NOT EXISTS (
            SELECT 1 FROM fee_receipts cancel
             WHERE cancel.school_id = fee_receipts.school_id
               AND cancel.reverses_receipt_id = fee_receipts.id AND cancel.kind = 'cancellation')), 0)::text AS collected,
        COALESCE(sum(fee_receipts.amount_paise) FILTER (WHERE fee_receipts.kind = 'refund'), 0)::text AS refunded,
        COALESCE(sum(fee_receipts.amount_paise) FILTER (
          WHERE fee_receipts.kind = 'payment' AND EXISTS (
            SELECT 1 FROM fee_receipts cancel
             WHERE cancel.school_id = fee_receipts.school_id
               AND cancel.reverses_receipt_id = fee_receipts.id AND cancel.kind = 'cancellation')), 0)::text AS cancelled
        ${source}`,
  )
  const actions = await allowedActionsForMany(conn, context, 'fee', rows.rows.map((row) => row.id))
  const summary = counted.rows[0]
  const collected = toPaise(summary?.collected ?? '0')
  const refunded = toPaise(summary?.refunded ?? '0')
  return {
    items: rows.rows.map((row) => projectSummary(row, actions.get(row.id) ?? [])),
    total: Number(summary?.total ?? 0),
    totals: {
      collectedPaise: collected,
      refundedPaise: refunded,
      cancelledPaise: toPaise(summary?.cancelled ?? '0'),
      netPaise: collected - refunded,
    },
  }
}

/** The fee heads a ledger row is split across, in name order. */
async function receiptLines(
  conn: FeeConnection,
  schoolId: string,
  receiptId: string,
): Promise<{ head: { id: string; name: string }; amountPaise: number }[]> {
  const rows = await conn.client.query<{ id: string; name: string; amount_paise: string }>(
    `SELECT h.id, h.name, line.amount_paise::text AS amount_paise
       FROM fee_receipt_lines line
       JOIN fee_heads h ON h.school_id = line.school_id AND h.id = line.fee_head_id
      WHERE line.school_id = $1 AND line.receipt_id = $2
      ORDER BY h.name, h.id`,
    [schoolId, receiptId],
  )
  return rows.rows.map((row) => ({
    head: { id: row.id, name: row.name },
    amountPaise: toPaise(row.amount_paise),
  }))
}

/** One ledger row in full, or nothing at all when the plan does not reach it. */
export async function readReceipt(
  conn: FeeConnection,
  context: RequestContext,
  receiptId: string,
): Promise<FeeReceiptDetail> {
  const plans = await feePlans(conn, context)
  const sections = await sectionVisibility(conn, context)
  const source = receiptSource(context.schoolId, plans, sections, { ids: [receiptId] })
  const rows = await conn.db.execute<ReceiptRow>(sql`${RECEIPT_COLUMNS} ${source} LIMIT 1`)
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')

  const reversedBy = await conn.db.execute<{
    id: string
    receipt_number: string
    kind: string
    amount_paise: string
    received_on: string
  }>(
    sql`SELECT fee_receipts.id, fee_receipts.receipt_number, fee_receipts.kind,
           fee_receipts.amount_paise::text AS amount_paise,
           to_char(fee_receipts.received_on, 'YYYY-MM-DD') AS received_on
          FROM fee_receipts
         WHERE fee_receipts.school_id = ${context.schoolId}::uuid
           AND fee_receipts.reverses_receipt_id = ${receiptId}::uuid
           AND (${plans.receipts})
         ORDER BY fee_receipts.created_at, fee_receipts.id LIMIT 50`,
  )

  const actions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'fee',
    id: receiptId,
  })
  const refundable =
    row.kind === 'payment'
      ? row.cancelled
        ? 0
        : Math.max(toPaise(row.amount_paise) - toPaise(row.refunded_paise), 0)
      : undefined
  return {
    ...projectSummary(row, actions),
    lines: await receiptLines(conn, context.schoolId, receiptId),
    ...(row.reference === null ? {} : { reference: row.reference }),
    ...(row.payer_name === null ? {} : { payerName: row.payer_name }),
    recordedAt: row.recorded_at,
    ...(refundable === undefined ? {} : { refundablePaise: refundable }),
    reversedBy: reversedBy.rows.map((back) => ({
      id: back.id,
      receiptNumber: back.receipt_number,
      kind: back.kind as FeeReceiptDetail['kind'],
      amountPaise: toPaise(back.amount_paise),
      receivedOn: back.received_on,
    })),
  } as FeeReceiptDetail
}

// ---------------------------------------------------------------------------
// The writes.

/** A denial on a named record answers like a record that is not there. */
async function decideRecord(
  conn: FeeConnection,
  context: RequestContext,
  permission: PermissionKey,
  id: string,
): Promise<void> {
  const decision = await decideResource(conn, context, permission, 'fee', id)
  if (!decision.allowed) {
    throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
  }
}

/** The academic year, when it is this school's. Anything else is refused. */
async function requireYear(
  conn: FeeConnection,
  schoolId: string,
  academicYearId: string,
): Promise<{ id: string; startDate: string }> {
  const rows = await conn.client.query<{ id: string; start_date: string }>(
    `SELECT id, to_char(start_date, 'YYYY-MM-DD') AS start_date
       FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, academicYearId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('INVALID_REQUEST')
  return { id: row.id, startDate: row.start_date }
}

/** A fee is charged by class, so the pupil must sit in one that year. */
async function requireEnrolled(
  conn: FeeConnection,
  schoolId: string,
  studentId: string,
  academicYearId: string,
): Promise<void> {
  const rows = await conn.client.query(
    `SELECT 1 FROM enrollments WHERE school_id = $1 AND student_id = $2 AND academic_year_id = $3 LIMIT 1`,
    [schoolId, studentId, academicYearId],
  )
  if (rows.rowCount === 0) throw new ApiFailure('INVALID_REQUEST')
}

/** Every head a body names belongs to this school, or the request is refused. */
async function requireHeads(
  conn: FeeConnection,
  schoolId: string,
  headIds: readonly string[],
): Promise<void> {
  const rows = await conn.client.query<{ id: string }>(
    `SELECT id FROM fee_heads WHERE school_id = $1 AND id = ANY($2::uuid[])`,
    [schoolId, [...new Set(headIds)]],
  )
  if (rows.rows.length !== new Set(headIds).size) throw new ApiFailure('INVALID_REQUEST')
}

/**
 * What is left of the year for one pupil, head by head. It is the very CTE
 * every statement and dues list reads, so a collection can never be checked
 * against a balance a screen would disagree with. The record has already been
 * decided, so the pupil is named directly here.
 */
interface HeadFigures {
  readonly yearBalancePaise: number
  readonly chargedYearPaise: number
  readonly adjustmentPaise: number
}

async function yearBalances(
  conn: FeeConnection,
  schoolId: string,
  studentId: string,
  academicYearId: string,
  asOf: string,
): Promise<Map<string, HeadFigures>> {
  const cte = feeFiguresCte({
    schoolId,
    academicYearId,
    asOf,
    pupils: sql`students.school_id = ${schoolId}::uuid AND students.id = ${studentId}::uuid`,
    receipts: sql`fee_receipts.school_id = ${schoolId}::uuid`,
  })
  const rows = await conn.db.execute<{
    fee_head_id: string
    year_balance_paise: string
    charged_year_paise: string
    adjustment_paise: string
  }>(
    sql`${cte}
        SELECT fee_head_id, year_balance_paise::text AS year_balance_paise,
               charged_year_paise::text AS charged_year_paise,
               adjustment_paise::text AS adjustment_paise
          FROM fee_figures WHERE student_id = ${studentId}::uuid`,
  )
  return new Map(
    rows.rows.map((row) => [
      row.fee_head_id,
      {
        yearBalancePaise: toPaise(row.year_balance_paise),
        chargedYearPaise: toPaise(row.charged_year_paise),
        adjustmentPaise: toPaise(row.adjustment_paise),
      },
    ]),
  )
}

/**
 * Money may only be taken against something the pupil owes. A head with no
 * figures at all, or one that is neither charged nor raised by a fine, is
 * nothing to pay; an amount above what is left of the year is refused.
 */
function assertWithinBalance(
  balances: ReadonlyMap<string, HeadFigures>,
  feeHeadId: string,
  amountPaise: number,
): void {
  const figures = balances.get(feeHeadId)
  if (!figures || (figures.chargedYearPaise === 0 && figures.adjustmentPaise <= 0)) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_nothing_charged')
  }
  if (amountPaise > figures.yearBalancePaise) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_amount_exceeds_balance')
  }
}

/** The whole of a ledger row, for a write that needs to reverse it. */
interface LedgerTarget {
  readonly id: string
  readonly studentId: string
  readonly academicYearId: string
  readonly kind: string
  readonly amountPaise: number
  readonly receivedOn: string
}

/** The row a refund or a cancellation names, after it has been decided. */
async function loadTarget(
  conn: FeeConnection,
  schoolId: string,
  receiptId: string,
): Promise<LedgerTarget> {
  const rows = await conn.client.query<{
    id: string
    student_id: string
    academic_year_id: string
    kind: string
    amount_paise: string
    received_on: string
  }>(
    `SELECT id, student_id, academic_year_id, kind, amount_paise::text AS amount_paise,
            to_char(received_on, 'YYYY-MM-DD') AS received_on
       FROM fee_receipts WHERE school_id = $1 AND id = $2`,
    [schoolId, receiptId],
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return {
    id: row.id,
    studentId: row.student_id,
    academicYearId: row.academic_year_id,
    kind: row.kind,
    amountPaise: toPaise(row.amount_paise),
    receivedOn: row.received_on,
  }
}

/** What each of the reversing rows of a payment adds up to, head by head. */
async function reversedSoFar(
  conn: FeeConnection,
  schoolId: string,
  receiptId: string,
): Promise<{ cancelled: boolean; refundedByHead: Map<string, number>; refundedTotal: number }> {
  const rows = await conn.client.query<{ kind: string; fee_head_id: string; amount_paise: string }>(
    `SELECT r.kind, line.fee_head_id, line.amount_paise::text AS amount_paise
       FROM fee_receipts r
       JOIN fee_receipt_lines line ON line.school_id = r.school_id AND line.receipt_id = r.id
      WHERE r.school_id = $1 AND r.reverses_receipt_id = $2`,
    [schoolId, receiptId],
  )
  const refundedByHead = new Map<string, number>()
  let cancelled = false
  let refundedTotal = 0
  for (const row of rows.rows) {
    if (row.kind === 'cancellation') {
      cancelled = true
      continue
    }
    if (row.kind !== 'refund') continue
    const amount = toPaise(row.amount_paise)
    refundedTotal += amount
    refundedByHead.set(row.fee_head_id, (refundedByHead.get(row.fee_head_id) ?? 0) + amount)
  }
  return { cancelled, refundedByHead, refundedTotal }
}

/** The heads of one ledger row and what each carries. */
async function linesOf(
  conn: FeeConnection,
  schoolId: string,
  receiptId: string,
): Promise<Map<string, number>> {
  const rows = await conn.client.query<{ fee_head_id: string; amount_paise: string }>(
    `SELECT fee_head_id, amount_paise::text AS amount_paise
       FROM fee_receipt_lines WHERE school_id = $1 AND receipt_id = $2`,
    [schoolId, receiptId],
  )
  return new Map(rows.rows.map((row) => [row.fee_head_id, toPaise(row.amount_paise)]))
}

interface LedgerInsert {
  readonly studentId: string
  readonly academicYearId: string
  readonly kind: string
  readonly receiptNumber: string
  readonly amountPaise: number
  readonly mode: string | null
  readonly reference: string | null
  readonly receivedOn: string
  readonly payerName: string | null
  readonly reversesReceiptId: string | null
  readonly lines: readonly { readonly feeHeadId: string; readonly amountPaise: number }[]
}

/** One ledger row and its heads, written together and never touched again. */
async function insertLedgerRow(
  conn: FeeConnection,
  context: RequestContext,
  input: LedgerInsert,
): Promise<string> {
  const inserted = await conn.client.query<{ id: string }>(
    `INSERT INTO fee_receipts (school_id, student_id, academic_year_id, kind, receipt_number,
                               amount_paise, mode, reference, received_on, payer_name,
                               reverses_receipt_id, recorded_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12) RETURNING id`,
    [
      context.schoolId,
      input.studentId,
      input.academicYearId,
      input.kind,
      input.receiptNumber,
      String(input.amountPaise),
      input.mode,
      input.reference,
      input.receivedOn,
      input.payerName,
      input.reversesReceiptId,
      context.membershipId,
    ],
  )
  const id = inserted.rows[0]?.id
  if (!id) throw new ApiFailure('SERVICE_UNAVAILABLE')
  for (const line of input.lines) {
    await conn.client.query(
      `INSERT INTO fee_receipt_lines (school_id, receipt_id, fee_head_id, amount_paise)
       VALUES ($1, $2, $3, $4)`,
      [context.schoolId, id, line.feeHeadId, String(line.amountPaise)],
    )
  }
  return id
}

function sumLines(lines: readonly { readonly amountPaise: number }[]): number {
  return lines.reduce((carry, line) => carry + line.amountPaise, 0)
}

/** A payment may be dated a little in the past, never in the future. */
const BACKDATE_DAYS = 60

function minusDays(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() - days)
  return moment.toISOString().slice(0, 10)
}

export function registerFeeReceiptRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/fees/receipts',
    permission: 'fees.read',
    query: FeeReceiptListRequest,
    response: FeeReceiptPage,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const found = await listReceipts(
          conn,
          context,
          {
            ...(query.academicYearId === undefined ? {} : { academicYearId: query.academicYearId }),
            ...(query.studentId === undefined ? {} : { studentId: query.studentId }),
            ...(query.from === undefined ? {} : { from: query.from }),
            ...(query.to === undefined ? {} : { to: query.to }),
            ...(query.mode === undefined ? {} : { mode: query.mode }),
            ...(query.kind === undefined ? {} : { kind: query.kind }),
            ...(query.q === undefined ? {} : { q: query.q }),
          },
          { page: query.page, pageSize: query.pageSize },
        )
        return {
          items: found.items,
          total: found.total,
          page: query.page,
          pageSize: query.pageSize,
          totals: found.totals,
        }
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/fees/receipts/:receiptId',
    permission: 'fees.read',
    response: FeeReceiptDetail,
    auditRead: { targetType: 'fee', param: 'receiptId', summary: 'Read a fee receipt.' },
    handler: async ({ context, param }) => {
      const receiptId = assertUuidParam(param('receiptId'))
      return withTenantTransaction(deps.pools.runtime, context, (conn) =>
        readReceipt(conn, context, receiptId),
      )
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/students/:studentId/collect',
    permission: 'fees.collect',
    body: FeeCollectRequest,
    response: FeeReceiptDetail,
    successStatus: 201,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideRecord(conn, context, 'fees.collect', studentId)
        const year = await requireYear(conn, context.schoolId, body.academicYearId)
        await requireEnrolled(conn, context.schoolId, studentId, year.id)
        await requireHeads(conn, context.schoolId, body.lines.map((line) => line.feeHeadId))

        const today = await schoolToday(conn, context.schoolId)
        if (body.receivedOn > today || body.receivedOn < minusDays(year.startDate, BACKDATE_DAYS)) {
          throw new ApiFailure('INVALID_REQUEST')
        }

        const balances = await yearBalances(conn, context.schoolId, studentId, year.id, today)
        for (const line of body.lines) assertWithinBalance(balances, line.feeHeadId, line.amountPaise)

        const receiptNumber = await allocateReceiptNumber(conn, context.schoolId, year.id)
        const receiptId = await insertLedgerRow(conn, context, {
          studentId,
          academicYearId: year.id,
          kind: 'payment',
          receiptNumber,
          amountPaise: sumLines(body.lines),
          mode: body.mode,
          reference: body.reference ?? null,
          receivedOn: body.receivedOn,
          payerName: body.payerName ?? null,
          reversesReceiptId: null,
          lines: body.lines,
        })
        await writeAudit(conn, context, {
          action: 'fees.collect',
          targetType: 'fee',
          targetId: receiptId,
          summary: 'Collected a fee payment.',
          safeChanges: {
            receiptId,
            studentId,
            academicYearId: year.id,
            mode: body.mode,
            lineCount: body.lines.length,
          },
        })
        return readReceipt(conn, context, receiptId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/receipts/:receiptId/refund',
    permission: 'fees.manage',
    body: FeeRefundRequest,
    response: FeeReceiptDetail,
    successStatus: 201,
    handler: async ({ context, body, param }) => {
      const receiptId = assertUuidParam(param('receiptId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideRecord(conn, context, 'fees.manage', receiptId)
        const target = await loadTarget(conn, context.schoolId, receiptId)
        const reversed = await reversedSoFar(conn, context.schoolId, receiptId)
        // Only a payment that still stands has money to send back.
        if (target.kind !== 'payment' || reversed.cancelled) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_receipt_already_reversed')
        }
        await requireHeads(conn, context.schoolId, body.lines.map((line) => line.feeHeadId))

        const today = await schoolToday(conn, context.schoolId)
        if (body.refundedOn < target.receivedOn || body.refundedOn > today) {
          throw new ApiFailure('INVALID_REQUEST')
        }

        const paid = await linesOf(conn, context.schoolId, receiptId)
        for (const line of body.lines) {
          const onPayment = paid.get(line.feeHeadId)
          if (onPayment === undefined) {
            throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_amount_exceeds_balance')
          }
          const left = onPayment - (reversed.refundedByHead.get(line.feeHeadId) ?? 0)
          if (line.amountPaise > left) {
            throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_amount_exceeds_balance')
          }
        }

        const receiptNumber = await allocateReceiptNumber(conn, context.schoolId, target.academicYearId)
        const refundId = await insertLedgerRow(conn, context, {
          studentId: target.studentId,
          academicYearId: target.academicYearId,
          kind: 'refund',
          receiptNumber,
          amountPaise: sumLines(body.lines),
          mode: body.mode,
          reference: body.reference ?? null,
          receivedOn: body.refundedOn,
          payerName: null,
          reversesReceiptId: target.id,
          lines: body.lines,
        })
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: refundId,
          summary: 'Refunded part of a fee payment.',
          safeChanges: {
            receiptId: refundId,
            reversesReceiptId: target.id,
            studentId: target.studentId,
            kind: 'refund',
            mode: body.mode,
            lineCount: body.lines.length,
          },
          // What somebody typed lives in the note, which can be redacted.
          note: body.reason,
        })
        return readReceipt(conn, context, refundId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/receipts/:receiptId/cancel',
    permission: 'fees.manage',
    body: FeeCancelRequest,
    response: FeeReceiptDetail,
    successStatus: 201,
    handler: async ({ context, body, param }) => {
      const receiptId = assertUuidParam(param('receiptId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideRecord(conn, context, 'fees.manage', receiptId)
        const target = await loadTarget(conn, context.schoolId, receiptId)
        const reversed = await reversedSoFar(conn, context.schoolId, receiptId)
        // A payment that was partly sent back is history: it is refunded the
        // rest of the way, never voided. The unique index behind this check is
        // the last line of defence, not the first.
        if (target.kind !== 'payment' || reversed.cancelled || reversed.refundedTotal > 0) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'fee_receipt_already_reversed')
        }

        const today = await schoolToday(conn, context.schoolId)
        const lines = [...(await linesOf(conn, context.schoolId, receiptId))].map(
          ([feeHeadId, amountPaise]) => ({ feeHeadId, amountPaise }),
        )
        if (lines.length === 0) throw new ApiFailure('SERVICE_UNAVAILABLE')

        const receiptNumber = await allocateReceiptNumber(conn, context.schoolId, target.academicYearId)
        const cancellationId = await insertLedgerRow(conn, context, {
          studentId: target.studentId,
          academicYearId: target.academicYearId,
          kind: 'cancellation',
          receiptNumber,
          amountPaise: target.amountPaise,
          mode: null,
          reference: null,
          receivedOn: today,
          payerName: null,
          reversesReceiptId: target.id,
          lines,
        })
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: cancellationId,
          summary: 'Cancelled a fee receipt.',
          safeChanges: {
            receiptId: cancellationId,
            reversesReceiptId: target.id,
            studentId: target.studentId,
            kind: 'cancellation',
            lineCount: lines.length,
          },
          note: body.reason,
        })
        return readReceipt(conn, context, cancellationId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/fees/students/:studentId/adjustments',
    permission: 'fees.manage',
    body: FeeAdjustmentRequest,
    response: FeeReceiptDetail,
    successStatus: 201,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideRecord(conn, context, 'fees.manage', studentId)
        const year = await requireYear(conn, context.schoolId, body.academicYearId)
        await requireEnrolled(conn, context.schoolId, studentId, year.id)
        await requireHeads(conn, context.schoolId, body.lines.map((line) => line.feeHeadId))

        const today = await schoolToday(conn, context.schoolId)
        // A waiver can only let a family off what they still owe. A fine
        // needs nothing to exist first: that is how a late fee is raised.
        if (body.direction === 'credit') {
          const balances = await yearBalances(conn, context.schoolId, studentId, year.id, today)
          for (const line of body.lines) assertWithinBalance(balances, line.feeHeadId, line.amountPaise)
        }

        const kind = body.direction === 'credit' ? 'credit_adjustment' : 'debit_adjustment'
        const receiptNumber = await allocateReceiptNumber(conn, context.schoolId, year.id)
        const adjustmentId = await insertLedgerRow(conn, context, {
          studentId,
          academicYearId: year.id,
          kind,
          receiptNumber,
          amountPaise: sumLines(body.lines),
          mode: null,
          reference: null,
          receivedOn: today,
          payerName: null,
          reversesReceiptId: null,
          lines: body.lines,
        })
        await writeAudit(conn, context, {
          action: 'fees.manage',
          targetType: 'fee',
          targetId: adjustmentId,
          summary: 'Adjusted what a pupil owes.',
          safeChanges: {
            receiptId: adjustmentId,
            studentId,
            kind,
            lineCount: body.lines.length,
          },
          note: body.reason,
        })
        return readReceipt(conn, context, adjustmentId)
      })
    },
  })
}
