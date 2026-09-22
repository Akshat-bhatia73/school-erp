import { sql, type SQL } from 'drizzle-orm'
import { ApiFailure } from '../shared/index.ts'

/**
 * What every pupil owes, in one place.
 *
 * Nothing about dues is stored. What a pupil is charged follows from the fee
 * structure of their class, the optional fees they take, their concessions and
 * the days they were enrolled; what they have paid follows from the ledger.
 * The statement, the dues list, the dashboard cards, the files and the checks a
 * collection makes all read the same common table expressions from here, so
 * two screens can never disagree about a balance.
 *
 * Instalments: a head is charged once for `one_time` and `yearly`, twice for
 * `half_yearly`, four times for `quarterly` and twelve times for `monthly`.
 * Instalment k falls due on the first day of its period, counted in months
 * from the first day of the academic year. An instalment is charged only when
 * the pupil was enrolled (and, for an optional fee, was taking it) on some day
 * of that period, so a pupil admitted in September owes nothing for April.
 *
 * Concessions come off every instalment: a percentage of it in basis points,
 * rounded down to a whole paisa, or a fixed amount, and never more than the
 * instalment itself.
 *
 * Paid is payments that stand (no cancellation points at them) less refunds.
 * A debit adjustment raises what is due and a credit adjustment lowers it;
 * both count as due at once.
 */
export interface FeeFiguresInput {
  readonly schoolId: string
  readonly academicYearId: string
  /** "Fallen due" is measured against this day: today in the school's timezone. */
  readonly asOf: string
  /**
   * Which pupils. It is a predicate over the unaliased `students` table and it
   * MUST already contain the caller's plan: planPredicate(feesPlan,
   * feeScopedTable('account')), and the students.read_basic plan when names
   * are shown. Filters are ANDed into it by the caller.
   */
  readonly pupils: SQL
  /**
   * The caller's plan over the unaliased `fee_receipts` table:
   * planPredicate(feesPlan, feeScopedTable('receipt')).
   */
  readonly receipts: SQL
}

/**
 * The `WITH ...` prefix of a statement. After it a query may read:
 *
 * - `fee_pupils (student_id, joined_on, left_on, grade_id, section_id)`: the
 *   pupils in scope who have an enrolment in this year, with the class they
 *   sit in (the open enrolment, else the latest one).
 * - `fee_figures (student_id, fee_head_id, instalments, instalments_due,
 *   charged_year_paise, concession_year_paise, adjustment_paise,
 *   due_to_date_paise, paid_paise, balance_paise, year_balance_paise)`: one
 *   row per pupil and head that is charged or has a ledger line.
 *
 * Every amount is a bigint, which the driver hands back as a string: read it
 * with `toPaise`.
 */
export function feeFiguresCte(input: FeeFiguresInput): SQL {
  const school = sql`${input.schoolId}::uuid`
  const year = sql`${input.academicYearId}::uuid`
  const asOf = sql`${input.asOf}::date`
  return sql`WITH fee_year AS (
      SELECT start_date, end_date FROM academic_years WHERE school_id = ${school} AND id = ${year}
    ),
    fee_pupils AS (
      SELECT students.id AS student_id,
             min(en.joined_on) AS joined_on,
             CASE WHEN bool_or(en.left_on IS NULL) THEN 'infinity'::date ELSE max(en.left_on) END AS left_on,
             (array_agg(sec.grade_id ORDER BY (en.left_on IS NULL) DESC, en.joined_on DESC, en.id))[1] AS grade_id,
             (array_agg(en.section_id ORDER BY (en.left_on IS NULL) DESC, en.joined_on DESC, en.id))[1] AS section_id
        FROM students
        JOIN enrollments en ON en.school_id = students.school_id AND en.student_id = students.id
         AND en.academic_year_id = ${year}
        JOIN sections sec ON sec.school_id = en.school_id AND sec.id = en.section_id
       WHERE ${input.pupils}
       GROUP BY students.id
    ),
    fee_applicable AS (
      SELECT p.student_id, h.id AS fee_head_id, h.frequency,
             COALESCE(own.amount_paise, every.amount_paise) AS amount_paise,
             p.joined_on AS from_on, p.left_on AS to_on
        FROM fee_pupils p
        JOIN fee_heads h ON h.school_id = ${school} AND h.applies_to = 'class'
        LEFT JOIN fee_structures own ON own.school_id = h.school_id AND own.academic_year_id = ${year}
         AND own.fee_head_id = h.id AND own.grade_id = p.grade_id
        LEFT JOIN fee_structures every ON every.school_id = h.school_id AND every.academic_year_id = ${year}
         AND every.fee_head_id = h.id AND every.grade_id IS NULL
       WHERE COALESCE(own.amount_paise, every.amount_paise) IS NOT NULL
      UNION ALL
      SELECT p.student_id, h.id, h.frequency,
             COALESCE(o.amount_paise, own.amount_paise, every.amount_paise),
             GREATEST(p.joined_on, o.starts_on),
             LEAST(p.left_on, COALESCE(o.ends_on, 'infinity'::date))
        FROM fee_pupils p
        JOIN fee_student_heads o ON o.school_id = ${school} AND o.student_id = p.student_id
         AND o.academic_year_id = ${year}
        JOIN fee_heads h ON h.school_id = o.school_id AND h.id = o.fee_head_id AND h.applies_to = 'opt_in'
        LEFT JOIN fee_structures own ON own.school_id = h.school_id AND own.academic_year_id = ${year}
         AND own.fee_head_id = h.id AND own.grade_id = p.grade_id
        LEFT JOIN fee_structures every ON every.school_id = h.school_id AND every.academic_year_id = ${year}
         AND every.fee_head_id = h.id AND every.grade_id IS NULL
       WHERE COALESCE(o.amount_paise, own.amount_paise, every.amount_paise) IS NOT NULL
    ),
    fee_instalments AS (
      SELECT a.student_id, a.fee_head_id, a.amount_paise, due.due_on
        FROM fee_applicable a
        CROSS JOIN fee_year y
        CROSS JOIN LATERAL (
          SELECT CASE a.frequency WHEN 'monthly' THEN 1 WHEN 'quarterly' THEN 3
                                  WHEN 'half_yearly' THEN 6 ELSE 12 END AS months
        ) step
        CROSS JOIN LATERAL (
          SELECT (y.start_date + make_interval(months => k * step.months))::date AS due_on,
                 ((y.start_date + make_interval(months => (k + 1) * step.months))::date - 1) AS period_end
            FROM generate_series(0, 12 / step.months - 1) AS k
        ) due
       WHERE due.due_on <= y.end_date
         AND a.from_on <= due.period_end
         AND a.to_on >= due.due_on
    ),
    fee_conceded AS (
      SELECT i.student_id, i.fee_head_id, i.due_on, i.amount_paise,
             LEAST(i.amount_paise, COALESCE((
               SELECT sum(CASE c.kind WHEN 'percent' THEN (i.amount_paise * c.percent_bp) / 10000
                                      ELSE c.amount_paise END)
                 FROM fee_concessions c
                WHERE c.school_id = ${school} AND c.student_id = i.student_id
                  AND c.academic_year_id = ${year}
                  AND (c.fee_head_id IS NULL OR c.fee_head_id = i.fee_head_id)
             ), 0))::bigint AS concession_paise
        FROM fee_instalments i
    ),
    fee_charges AS (
      SELECT student_id, fee_head_id,
             count(*)::int AS instalments,
             (count(*) FILTER (WHERE due_on <= ${asOf}))::int AS instalments_due,
             sum(amount_paise)::bigint AS charged_year_paise,
             sum(concession_paise)::bigint AS concession_year_paise,
             COALESCE(sum(amount_paise - concession_paise) FILTER (WHERE due_on <= ${asOf}), 0)::bigint AS net_due_paise
        FROM fee_conceded
       GROUP BY student_id, fee_head_id
    ),
    fee_ledger AS (
      SELECT fee_receipts.student_id, line.fee_head_id,
             sum(CASE
                   WHEN fee_receipts.kind = 'payment' AND NOT EXISTS (
                     SELECT 1 FROM fee_receipts cancel
                      WHERE cancel.school_id = fee_receipts.school_id
                        AND cancel.reverses_receipt_id = fee_receipts.id AND cancel.kind = 'cancellation')
                     THEN line.amount_paise
                   WHEN fee_receipts.kind = 'refund' THEN -line.amount_paise
                   ELSE 0 END)::bigint AS paid_paise,
             sum(CASE fee_receipts.kind WHEN 'debit_adjustment' THEN line.amount_paise
                                        WHEN 'credit_adjustment' THEN -line.amount_paise
                                        ELSE 0 END)::bigint AS adjustment_paise
        FROM fee_receipts
        JOIN fee_receipt_lines line ON line.school_id = fee_receipts.school_id AND line.receipt_id = fee_receipts.id
       WHERE ${input.receipts}
         AND fee_receipts.academic_year_id = ${year}
         AND fee_receipts.student_id IN (SELECT student_id FROM fee_pupils)
       GROUP BY fee_receipts.student_id, line.fee_head_id
    ),
    fee_figures AS (
      SELECT COALESCE(c.student_id, g.student_id) AS student_id,
             COALESCE(c.fee_head_id, g.fee_head_id) AS fee_head_id,
             COALESCE(c.instalments, 0) AS instalments,
             COALESCE(c.instalments_due, 0) AS instalments_due,
             COALESCE(c.charged_year_paise, 0)::bigint AS charged_year_paise,
             COALESCE(c.concession_year_paise, 0)::bigint AS concession_year_paise,
             COALESCE(g.adjustment_paise, 0)::bigint AS adjustment_paise,
             (COALESCE(c.net_due_paise, 0) + COALESCE(g.adjustment_paise, 0))::bigint AS due_to_date_paise,
             COALESCE(g.paid_paise, 0)::bigint AS paid_paise,
             (COALESCE(c.net_due_paise, 0) + COALESCE(g.adjustment_paise, 0) - COALESCE(g.paid_paise, 0))::bigint AS balance_paise,
             (COALESCE(c.charged_year_paise, 0) - COALESCE(c.concession_year_paise, 0)
               + COALESCE(g.adjustment_paise, 0) - COALESCE(g.paid_paise, 0))::bigint AS year_balance_paise
        FROM fee_charges c
        FULL OUTER JOIN fee_ledger g ON g.student_id = c.student_id AND g.fee_head_id = c.fee_head_id
    )`
}

/** One row of `fee_figures`, as the driver returns it. */
export interface FeeFiguresRow extends Record<string, unknown> {
  student_id: string
  fee_head_id: string
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
 * A bigint amount from the database as a whole number of paise. The driver
 * returns a bigint as a string; anything that is not a safe whole number is a
 * bug in a query, never a value to round, so it fails the request.
 */
export function toPaise(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return parsed
}

export { schoolToday } from '../shared/clock.ts'
