import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import {
  type FeeConcession,
  type FeeDuesPage,
  type FeeDuesRequest,
  type FeeDuesRow,
  FeeDuesPage as FeeDuesPageSchema,
  FeeDuesRequest as FeeDuesRequestSchema,
  type FeeOptIn,
  type FeeStatement,
  FeeStatement as FeeStatementSchema,
  type FeeStatementLine,
  FeeStatementRequest,
  type FeeStudent,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  allowedActionsFor,
  allowedActionsForMany,
  ApiFailure,
  assertUuidParam,
  protectedRoute,
  type ModuleDependencies,
} from '../shared/index.ts'
import { feeFiguresCte, schoolToday, toPaise } from './charges.ts'
import {
  CONCESSIONS_OF_PUPIL,
  OPT_INS_OF_PUPIL,
  projectFeeConcession,
  projectFeeOptIn,
  type FeeConcessionRow,
  type FeeOptInRow,
} from './project.ts'
import { feePlans, listReceipts, sectionVisibility, type FeeConnection, type FeePlans } from './receipts.ts'

/**
 * What one pupil owes, and what a whole school owes.
 *
 * Both answers come from the same charges CTE as every other fee screen and
 * file, so a statement, the dues list, the dashboard and a spreadsheet can
 * never disagree. Nothing is filtered in JavaScript: the caller's plans and
 * the filters are all in the statement that computes the totals.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A malformed id inside a query string is a refused request, not a 404. */
function requireUuidFilter(value: string): string {
  if (!UUID.test(value)) throw new ApiFailure('INVALID_REQUEST')
  return value
}

/** The year a screen means when it names none: the one the school is in. */
export async function currentYear(
  conn: FeeConnection,
  schoolId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await conn.client.query<{ id: string; name: string }>(
    `SELECT id, name FROM academic_years WHERE school_id = $1 AND status = 'current' ORDER BY start_date DESC, id LIMIT 1`,
    [schoolId],
  )
  return rows.rows[0] ?? null
}

/** The year a request asked for, when this school has it. */
async function namedYear(
  conn: FeeConnection,
  schoolId: string,
  academicYearId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await conn.client.query<{ id: string; name: string }>(
    `SELECT id, name FROM academic_years WHERE school_id = $1 AND id = $2`,
    [schoolId, academicYearId],
  )
  return rows.rows[0] ?? null
}

/**
 * The year a fee read runs in. A year that is not this school's, and a school
 * with no current year, both answer like a record that is not there: a fee
 * read always names a year, so there is nothing to show without one.
 */
async function resolveYear(
  conn: FeeConnection,
  schoolId: string,
  academicYearId: string | undefined,
): Promise<{ id: string; name: string }> {
  const year =
    academicYearId === undefined
      ? await currentYear(conn, schoolId)
      : await namedYear(conn, schoolId, requireUuidFilter(academicYearId))
  if (!year) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return year
}

interface PupilRow extends Record<string, unknown> {
  id: string
  first_name: string
  last_name: string | null
  admission_number: string
}

function pupilName(row: PupilRow): string {
  return [row.first_name, row.last_name].filter((part) => part !== null && part !== '').join(' ')
}

/** The pupil themselves, through both plans that name a person. */
async function readPupil(
  conn: FeeConnection,
  schoolId: string,
  plans: FeePlans,
  studentId: string,
): Promise<PupilRow> {
  const rows = await conn.db.execute<PupilRow>(
    sql`SELECT students.id, students.first_name, students.last_name, students.admission_number
          FROM students
         WHERE students.school_id = ${schoolId}::uuid AND students.id = ${studentId}::uuid
           AND (${plans.pupils}) LIMIT 1`,
  )
  const row = rows.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

interface ClassRow extends Record<string, unknown> {
  grade_id: string | null
  grade_name: string | null
  section_id: string | null
  section_name: string | null
}

function withClass(student: PupilRow, klass: ClassRow | undefined): FeeStudent {
  return {
    id: student.id,
    name: pupilName(student),
    admissionNumber: student.admission_number,
    ...(klass?.grade_id == null || klass.grade_name == null
      ? {}
      : { grade: { id: klass.grade_id, name: klass.grade_name } }),
    ...(klass?.section_id == null || klass.section_name == null
      ? {}
      : { section: { id: klass.section_id, name: klass.section_name } }),
  }
}

const EMPTY_TOTALS = {
  chargedYearPaise: 0,
  concessionYearPaise: 0,
  adjustmentPaise: 0,
  dueToDatePaise: 0,
  paidPaise: 0,
  balancePaise: 0,
  yearBalancePaise: 0,
}

interface StatementLineRow extends Record<string, unknown> {
  fee_head_id: string
  head_name: string
  category: string
  applies_to: string
  frequency: string
  instalments: number
  instalments_due: number
  charged_year_paise: string
  concession_year_paise: string
  adjustment_paise: string
  due_to_date_paise: string
  paid_paise: string
  balance_paise: string
  year_balance_paise: string
}

/**
 * One pupil's fee statement for one year: what they are charged, what they
 * have paid, the optional fees and concessions behind those figures, and
 * every ledger row of the year. A pupil with no enrolment in the year is not
 * an error; they are simply charged nothing.
 */
export async function readStatement(
  conn: FeeConnection,
  context: RequestContext,
  studentId: string,
  academicYearId: string | undefined,
): Promise<FeeStatement> {
  const schoolId = context.schoolId
  const plans = await feePlans(conn, context)
  const sections = await sectionVisibility(conn, context)
  const student = await readPupil(conn, schoolId, plans, studentId)
  const year = await resolveYear(conn, schoolId, academicYearId)
  const asOf = await schoolToday(conn, schoolId)

  const cte = feeFiguresCte({
    schoolId,
    academicYearId: year.id,
    asOf,
    pupils: sql`students.school_id = ${schoolId}::uuid AND students.id = ${studentId}::uuid AND (${plans.pupils})`,
    receipts: plans.receipts,
  })

  // The class of that year, and only when the caller may read the section.
  const klass = await conn.db.execute<ClassRow>(
    sql`${cte}
        SELECT sections.id AS section_id, sections.name AS section_name,
               grades.id AS grade_id, grades.name AS grade_name
          FROM fee_pupils p
          LEFT JOIN sections ON sections.school_id = ${schoolId}::uuid AND sections.id = p.section_id
            AND (${sections})
          LEFT JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
         WHERE p.student_id = ${studentId}::uuid LIMIT 1`,
  )

  const lineRows = await conn.db.execute<StatementLineRow>(
    sql`${cte}
        SELECT f.fee_head_id, h.name AS head_name, h.category, h.applies_to, h.frequency,
               f.instalments, f.instalments_due,
               f.charged_year_paise::text AS charged_year_paise,
               f.concession_year_paise::text AS concession_year_paise,
               f.adjustment_paise::text AS adjustment_paise,
               f.due_to_date_paise::text AS due_to_date_paise,
               f.paid_paise::text AS paid_paise,
               f.balance_paise::text AS balance_paise,
               f.year_balance_paise::text AS year_balance_paise
          FROM fee_figures f
          JOIN fee_heads h ON h.school_id = ${schoolId}::uuid AND h.id = f.fee_head_id
         WHERE f.student_id = ${studentId}::uuid
         ORDER BY h.name, h.id`,
  )

  const lines: FeeStatementLine[] = lineRows.rows.map((row) => ({
    head: { id: row.fee_head_id, name: row.head_name },
    category: row.category as FeeStatementLine['category'],
    appliesTo: row.applies_to as FeeStatementLine['appliesTo'],
    frequency: row.frequency as FeeStatementLine['frequency'],
    instalments: Number(row.instalments),
    instalmentsDue: Number(row.instalments_due),
    chargedYearPaise: toPaise(row.charged_year_paise),
    concessionYearPaise: toPaise(row.concession_year_paise),
    adjustmentPaise: toPaise(row.adjustment_paise),
    dueToDatePaise: toPaise(row.due_to_date_paise),
    paidPaise: toPaise(row.paid_paise),
    balancePaise: toPaise(row.balance_paise),
    yearBalancePaise: toPaise(row.year_balance_paise),
  }))
  // The totals are the lines added up, so the foot of the statement can never
  // say something the rows above it do not.
  const totals = lines.reduce(
    (carry, line) => ({
      chargedYearPaise: carry.chargedYearPaise + line.chargedYearPaise,
      concessionYearPaise: carry.concessionYearPaise + line.concessionYearPaise,
      adjustmentPaise: carry.adjustmentPaise + line.adjustmentPaise,
      dueToDatePaise: carry.dueToDatePaise + line.dueToDatePaise,
      paidPaise: carry.paidPaise + line.paidPaise,
      balancePaise: carry.balancePaise + line.balancePaise,
      yearBalancePaise: carry.yearBalancePaise + line.yearBalancePaise,
    }),
    { ...EMPTY_TOTALS },
  )

  const optInRows = await conn.client.query<FeeOptInRow>(OPT_INS_OF_PUPIL, [schoolId, studentId, year.id])
  const concessionRows = await conn.client.query<FeeConcessionRow>(CONCESSIONS_OF_PUPIL, [
    schoolId,
    studentId,
    year.id,
  ])
  const optIns: FeeOptIn[] = optInRows.rows.map((row) => projectFeeOptIn(row))
  const concessions: FeeConcession[] = concessionRows.rows.map((row) => projectFeeConcession(row))

  const receipts = await listReceipts(conn, context, { studentId, academicYearId: year.id })
  const allowedActions = await allowedActionsFor(conn, context, {
    schoolId,
    resourceType: 'fee',
    id: studentId,
  })

  return FeeStatementSchema.parse({
    student: withClass(student, klass.rows[0]),
    academicYear: { id: year.id, name: year.name },
    asOf,
    lines,
    totals,
    optIns,
    concessions,
    receipts: receipts.items,
    allowedActions: [...allowedActions],
  })
}

interface DuesRow extends Record<string, unknown> {
  student_id: string
  first_name: string
  last_name: string | null
  admission_number: string
  grade_id: string | null
  grade_name: string | null
  section_id: string | null
  section_name: string | null
  charged_year_paise: string
  due_to_date_paise: string
  paid_paise: string
  balance_paise: string
}

/**
 * The dues list: one row per pupil enrolled in the year and inside both
 * plans, with what they are charged, what they have paid and what is left.
 * Every filter, the order and the totals are in SQL, so the totals describe
 * the whole search and not the page in hand.
 */
export async function readDues(
  conn: FeeConnection,
  context: RequestContext,
  request: FeeDuesRequest,
): Promise<FeeDuesPage> {
  const schoolId = context.schoolId
  const plans = await feePlans(conn, context)
  const sections = await sectionVisibility(conn, context)
  const year = await resolveYear(conn, schoolId, request.academicYearId)
  const asOf = await schoolToday(conn, schoolId)

  const cte = feeFiguresCte({
    schoolId,
    academicYearId: year.id,
    asOf,
    pupils: sql`students.school_id = ${schoolId}::uuid AND (${plans.pupils})`,
    receipts: plans.receipts,
  })

  const filters = [sql`TRUE`]
  if (request.gradeId !== undefined) {
    filters.push(sql`dues.grade_id = ${requireUuidFilter(request.gradeId)}::uuid`)
  }
  if (request.sectionId !== undefined) {
    filters.push(sql`dues.section_id = ${requireUuidFilter(request.sectionId)}::uuid`)
  }
  if (request.show === 'due') filters.push(sql`dues.balance_paise > 0`)
  if (request.q !== undefined && request.q !== '') {
    const like = `%${request.q.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
    filters.push(
      sql`(students.first_name ILIKE ${like} ESCAPE '\\'
        OR students.last_name ILIKE ${like} ESCAPE '\\'
        OR students.admission_number ILIKE ${like} ESCAPE '\\')`,
    )
  }
  const where = filters.reduce((carry, part) => sql`${carry} AND (${part})`)

  // A pupil with no charges and no ledger row still has a row here, at zero.
  const duesCte = sql`${cte}, dues AS (
      SELECT p.student_id, p.grade_id, p.section_id,
             COALESCE(sum(f.charged_year_paise), 0)::bigint AS charged_year_paise,
             COALESCE(sum(f.due_to_date_paise), 0)::bigint AS due_to_date_paise,
             COALESCE(sum(f.paid_paise), 0)::bigint AS paid_paise,
             COALESCE(sum(f.balance_paise), 0)::bigint AS balance_paise
        FROM fee_pupils p
        LEFT JOIN fee_figures f ON f.student_id = p.student_id
       GROUP BY p.student_id, p.grade_id, p.section_id
    )`
  const source = sql`FROM dues
      JOIN students ON students.school_id = ${schoolId}::uuid AND students.id = dues.student_id
      LEFT JOIN sections ON sections.school_id = ${schoolId}::uuid AND sections.id = dues.section_id
        AND (${sections})
      LEFT JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
     WHERE ${where}`

  const offset = (request.page - 1) * request.pageSize
  const rows = await conn.db.execute<DuesRow>(
    sql`${duesCte}
        SELECT dues.student_id, students.first_name, students.last_name, students.admission_number,
               grades.id AS grade_id, grades.name AS grade_name,
               sections.id AS section_id, sections.name AS section_name,
               dues.charged_year_paise::text AS charged_year_paise,
               dues.due_to_date_paise::text AS due_to_date_paise,
               dues.paid_paise::text AS paid_paise,
               dues.balance_paise::text AS balance_paise
        ${source}
        ORDER BY dues.balance_paise DESC, students.admission_number, dues.student_id
        LIMIT ${request.pageSize} OFFSET ${offset}`,
  )
  const counted = await conn.db.execute<{
    total: number
    due: string
    paid: string
    outstanding: string
    with_dues: number
  }>(
    sql`${duesCte}
        SELECT count(*)::int AS total,
               COALESCE(sum(dues.due_to_date_paise), 0)::text AS due,
               COALESCE(sum(dues.paid_paise), 0)::text AS paid,
               COALESCE(sum(GREATEST(dues.balance_paise, 0)), 0)::text AS outstanding,
               (count(*) FILTER (WHERE dues.balance_paise > 0))::int AS with_dues
        ${source}`,
  )

  const actions = await allowedActionsForMany(conn, context, 'fee', rows.rows.map((row) => row.student_id))
  const items: FeeDuesRow[] = rows.rows.map((row) => ({
    student: withClass(
      {
        id: row.student_id,
        first_name: row.first_name,
        last_name: row.last_name,
        admission_number: row.admission_number,
      },
      row,
    ),
    chargedYearPaise: toPaise(row.charged_year_paise),
    dueToDatePaise: toPaise(row.due_to_date_paise),
    paidPaise: toPaise(row.paid_paise),
    balancePaise: toPaise(row.balance_paise),
    allowedActions: [...(actions.get(row.student_id) ?? [])],
  }))
  const summary = counted.rows[0]
  return FeeDuesPageSchema.parse({
    items,
    total: Number(summary?.total ?? 0),
    page: request.page,
    pageSize: request.pageSize,
    academicYear: { id: year.id, name: year.name },
    asOf,
    totals: {
      dueToDatePaise: toPaise(summary?.due ?? '0'),
      paidPaise: toPaise(summary?.paid ?? '0'),
      outstandingPaise: toPaise(summary?.outstanding ?? '0'),
      studentsWithDues: Number(summary?.with_dues ?? 0),
    },
  })
}

export interface FeeSummary {
  readonly collectedTodayPaise: number
  readonly receiptsToday: number
  readonly collectedThisMonthPaise: number
  readonly outstandingPaise: number
  readonly studentsWithDues: number
}

/**
 * The few figures a dashboard card shows: what came in today and this month,
 * and what the school is still owed. Money collected is payments no
 * cancellation points at, less the refunds of the same window, and never less
 * than nothing.
 */
export async function readFeeSummary(
  conn: FeeConnection,
  context: RequestContext,
  academicYearId: string,
  asOf: string,
): Promise<FeeSummary> {
  const schoolId = context.schoolId
  const plans = await feePlans(conn, context)
  const day = sql`${asOf}::date`
  const standing = sql`NOT EXISTS (SELECT 1 FROM fee_receipts cancel
        WHERE cancel.school_id = fee_receipts.school_id
          AND cancel.reverses_receipt_id = fee_receipts.id AND cancel.kind = 'cancellation')`

  const collected = await conn.db.execute<{
    paid_today: string
    receipts_today: number
    refunded_today: string
    paid_month: string
    refunded_month: string
  }>(
    sql`SELECT
          COALESCE(sum(fee_receipts.amount_paise) FILTER (
            WHERE fee_receipts.kind = 'payment' AND fee_receipts.received_on = ${day} AND ${standing}), 0)::text AS paid_today,
          (count(*) FILTER (
            WHERE fee_receipts.kind = 'payment' AND fee_receipts.received_on = ${day} AND ${standing}))::int AS receipts_today,
          COALESCE(sum(fee_receipts.amount_paise) FILTER (
            WHERE fee_receipts.kind = 'refund' AND fee_receipts.received_on = ${day}), 0)::text AS refunded_today,
          COALESCE(sum(fee_receipts.amount_paise) FILTER (
            WHERE fee_receipts.kind = 'payment'
              AND date_trunc('month', fee_receipts.received_on) = date_trunc('month', ${day})
              AND ${standing}), 0)::text AS paid_month,
          COALESCE(sum(fee_receipts.amount_paise) FILTER (
            WHERE fee_receipts.kind = 'refund'
              AND date_trunc('month', fee_receipts.received_on) = date_trunc('month', ${day})), 0)::text AS refunded_month
        FROM fee_receipts
       WHERE fee_receipts.school_id = ${schoolId}::uuid
         AND fee_receipts.academic_year_id = ${academicYearId}::uuid
         AND (${plans.receipts})`,
  )

  const cte = feeFiguresCte({
    schoolId,
    academicYearId,
    asOf,
    pupils: sql`students.school_id = ${schoolId}::uuid AND (${plans.pupils})`,
    receipts: plans.receipts,
  })
  const owed = await conn.db.execute<{ outstanding: string; with_dues: number }>(
    sql`${cte}, dues AS (
          SELECT p.student_id, COALESCE(sum(f.balance_paise), 0)::bigint AS balance_paise
            FROM fee_pupils p
            LEFT JOIN fee_figures f ON f.student_id = p.student_id
           GROUP BY p.student_id
        )
        SELECT COALESCE(sum(GREATEST(dues.balance_paise, 0)), 0)::text AS outstanding,
               (count(*) FILTER (WHERE dues.balance_paise > 0))::int AS with_dues
          FROM dues`,
  )

  const row = collected.rows[0]
  const today = toPaise(row?.paid_today ?? '0') - toPaise(row?.refunded_today ?? '0')
  const month = toPaise(row?.paid_month ?? '0') - toPaise(row?.refunded_month ?? '0')
  const debt = owed.rows[0]
  return {
    // More sent back than taken in on a day is possible; a card never shows a
    // negative collection, it shows nothing collected.
    collectedTodayPaise: Math.max(today, 0),
    receiptsToday: Number(row?.receipts_today ?? 0),
    collectedThisMonthPaise: Math.max(month, 0),
    outstandingPaise: toPaise(debt?.outstanding ?? '0'),
    studentsWithDues: Number(debt?.with_dues ?? 0),
  }
}

export function registerFeeStatementRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/fees/students/:studentId/statement',
    permission: 'fees.read',
    query: FeeStatementRequest,
    response: FeeStatementSchema,
    auditRead: { targetType: 'fee', param: 'studentId', summary: 'Read a fee statement.' },
    handler: async ({ context, query, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, (conn) =>
        readStatement(conn, context, studentId, query.academicYearId),
      )
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/fees/dues',
    permission: 'fees.read',
    query: FeeDuesRequestSchema,
    response: FeeDuesPageSchema,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => readDues(conn, context, query)),
  })
}
