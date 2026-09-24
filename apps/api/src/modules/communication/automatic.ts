import { sql } from 'drizzle-orm'
import type { AuthzConnection } from '@erp/authz'
import {
  EXAM_PATTERN,
  MESSAGE_BODY_MAX,
  MESSAGE_TITLE_MAX,
  renderMessageText,
  type AutomaticMessageKind,
  type ExamKind,
  type MessagePlaceholder,
} from '@erp/contracts'
import { feeFiguresCte, toPaise } from '../fees/charges.ts'
import { loadAutomaticWording, loadCommunicationSettings, type DispatchDependencies } from './common.ts'
import { materialiseMessage } from './materialise.ts'

/**
 * The messages the school sends by itself (the table in "Communication" in
 * docs/auth/PROTECTED_APIS.md). Each kind finds what is due, skips anything a
 * message already went for (the dedupe key), renders the school's wording and
 * inserts the message; a key somebody else inserted in the meantime is left
 * alone (ON CONFLICT DO NOTHING), so each one happens at most once. Every new
 * message then goes out at once through materialiseMessage.
 */

/** At most this many automatic messages are made in one pump run, across every kind. */
export const AUTOMATIC_MESSAGES_PER_RUN = 300

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** '2026-09-23' as '23 Sep 2026'. */
export function formatMessageDate(isoDate: string): string {
  const [year, month, day] = isoDate.slice(0, 10).split('-')
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? ''} ${year}`
}

/** Integer paise as Indian rupees: 1250000 as '₹12,500', 1250050 as '₹12,500.50'. */
export function formatRupees(paise: number): string {
  const whole = Math.floor(Math.abs(paise) / 100)
  const rest = Math.abs(paise) % 100
  const digits = String(whole)
  const last = digits.slice(-3)
  const lead = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')
  const rupees = lead ? `${lead},${last}` : last
  return `${paise < 0 ? '-' : ''}₹${rupees}${rest === 0 ? '' : `.${String(rest).padStart(2, '0')}`}`
}

/** One automatic message about to be written. */
interface Candidate {
  readonly dedupeKey: string
  readonly studentId?: string
  readonly staffId?: string
  readonly sectionId?: string
  readonly academicYearId?: string
  readonly values: Partial<Record<MessagePlaceholder, string>>
}

/** A pupil as every pupil query below returns them. */
interface PupilRow {
  student_id: string
  first_name: string
  last_name: string | null
  section_id: string
  academic_year_id: string
  class_label: string
}

function pupilValues(row: PupilRow): Partial<Record<MessagePlaceholder, string>> {
  return {
    pupil_name: [row.first_name, row.last_name].filter(Boolean).join(' '),
    pupil_first_name: row.first_name,
    class: row.class_label,
  }
}

function pupilCandidate(
  row: PupilRow,
  dedupeKey: string,
  extra: Partial<Record<MessagePlaceholder, string>> = {},
): Candidate {
  return {
    dedupeKey,
    studentId: row.student_id,
    sectionId: row.section_id,
    academicYearId: row.academic_year_id,
    values: { ...pupilValues(row), ...extra },
  }
}

/**
 * The pupil's current enrolment (the open one in the current year) and the
 * class it names, joined on `st`. Parameters: $1 the school, $2 the year.
 */
const CURRENT_CLASS = `
  JOIN LATERAL (
    SELECT en.section_id, en.academic_year_id
      FROM enrollments en
     WHERE en.school_id = st.school_id AND en.student_id = st.id
       AND en.academic_year_id = $2::uuid AND en.left_on IS NULL
     ORDER BY en.joined_on DESC, en.id
     LIMIT 1
  ) ce ON true
  JOIN sections sec ON sec.school_id = st.school_id AND sec.id = ce.section_id
  JOIN grades gr ON gr.school_id = sec.school_id AND gr.id = sec.grade_id`

/** A message with this key does not exist yet. Parameter $1 is the school. */
function notSent(keyExpression: string): string {
  return `NOT EXISTS (SELECT 1 FROM messages m WHERE m.school_id = $1 AND m.dedupe_key = ${keyExpression})`
}

interface SchoolClock {
  name: string
  today: string
  hour: number
}

async function schoolClock(conn: AuthzConnection, schoolId: string): Promise<SchoolClock | null> {
  const result = await conn.client.query<SchoolClock>(
    `SELECT name, to_char(local_now::date, 'YYYY-MM-DD') AS today, extract(hour FROM local_now)::int AS hour
       FROM (SELECT name, now() AT TIME ZONE COALESCE(NULLIF(timezone, ''), 'Asia/Kolkata') AS local_now
               FROM schools WHERE id = $1) AS clock`,
    [schoolId],
  )
  return result.rows[0] ?? null
}

async function currentYearId(conn: AuthzConnection, schoolId: string): Promise<string | null> {
  const result = await conn.client.query<{ id: string }>(
    `SELECT id FROM academic_years WHERE school_id = $1 AND status = 'current'
      ORDER BY start_date DESC LIMIT 1`,
    [schoolId],
  )
  return result.rows[0]?.id ?? null
}

/** Today's absences whose mark has stood for the delay. Only today, and only marks saved since automatic_since. */
async function absenceCandidates(
  conn: AuthzConnection,
  schoolId: string,
  today: string,
  delayMinutes: number,
  since: string,
  limit: number,
): Promise<Candidate[]> {
  const result = await conn.client.query<PupilRow>(
    `WITH newest AS (
        SELECT DISTINCT ON (e.student_id) e.student_id, e.section_id, e.academic_year_id, e.mark, e.created_at
          FROM attendance_entries e
         WHERE e.school_id = $1 AND e.date = $2::date
         ORDER BY e.student_id, e.revision DESC
      )
      SELECT st.id AS student_id, st.first_name, st.last_name, n.section_id, n.academic_year_id,
             gr.name || ' ' || sec.name AS class_label
        FROM newest n
        JOIN students st ON st.school_id = $1 AND st.id = n.student_id
        JOIN sections sec ON sec.school_id = $1 AND sec.id = n.section_id
        JOIN grades gr ON gr.school_id = $1 AND gr.id = sec.grade_id
       WHERE n.mark = 'absent'
         AND n.created_at <= now() - make_interval(mins => $3::int)
         AND n.created_at >= $4::timestamptz
         AND st.status = 'active' AND st.anonymised_at IS NULL
         AND ${notSent(`'absence:' || st.id || ':' || $2`)}
       ORDER BY st.id
       LIMIT $5`,
    [schoolId, today, delayMinutes, since, limit],
  )
  return result.rows.map((row) =>
    pupilCandidate(row, `absence:${row.student_id}:${today}`, { date: formatMessageDate(today) }),
  )
}

/** The first publication of an exam for a section, in the last three days: one message per pupil with a mark. */
async function resultCandidates(
  conn: AuthzConnection,
  schoolId: string,
  since: string,
  limit: number,
): Promise<Candidate[]> {
  const result = await conn.client.query<PupilRow & { exam_id: string; exam_kind: ExamKind }>(
    `WITH first_publication AS (
        SELECT DISTINCT ON (p.exam_id, p.section_id) p.exam_id, p.section_id, p.academic_year_id, p.published_at
          FROM exam_publications p
         WHERE p.school_id = $1
         ORDER BY p.exam_id, p.section_id, p.published_at, p.id
      )
      SELECT DISTINCT ON (fp.exam_id, st.id)
             fp.exam_id, ex.kind AS exam_kind, st.id AS student_id, st.first_name, st.last_name,
             fp.section_id, fp.academic_year_id, gr.name || ' ' || sec.name AS class_label
        FROM first_publication fp
        JOIN exams ex ON ex.school_id = $1 AND ex.id = fp.exam_id
        JOIN exam_marks mk ON mk.school_id = $1 AND mk.exam_id = fp.exam_id AND mk.section_id = fp.section_id
        JOIN students st ON st.school_id = $1 AND st.id = mk.student_id
        JOIN sections sec ON sec.school_id = $1 AND sec.id = fp.section_id
        JOIN grades gr ON gr.school_id = $1 AND gr.id = sec.grade_id
       WHERE fp.published_at >= now() - interval '3 days'
         AND fp.published_at >= $2::timestamptz
         AND st.status = 'active' AND st.anonymised_at IS NULL
         AND ${notSent(`'result:' || fp.exam_id || ':' || st.id`)}
       ORDER BY fp.exam_id, st.id
       LIMIT $3`,
    [schoolId, since, limit],
  )
  return result.rows.map((row) =>
    pupilCandidate(row, `result:${row.exam_id}:${row.student_id}`, { exam: EXAM_PATTERN[row.exam_kind].label }),
  )
}

/** A report card version published in the last three days; a republished card sends again. */
async function reportCardCandidates(
  conn: AuthzConnection,
  schoolId: string,
  yearId: string,
  since: string,
  limit: number,
): Promise<Candidate[]> {
  const result = await conn.client.query<PupilRow & { version_id: string; card: string }>(
    `SELECT v.id AS version_id, v.card, st.id AS student_id, st.first_name, st.last_name,
            ce.section_id, ce.academic_year_id, gr.name || ' ' || sec.name AS class_label
       FROM report_card_versions v
       JOIN students st ON st.school_id = v.school_id AND st.id = v.student_id
       ${CURRENT_CLASS}
      WHERE v.school_id = $1
        AND v.published_at >= now() - interval '3 days'
        AND v.published_at >= $3::timestamptz
        AND st.status = 'active' AND st.anonymised_at IS NULL
        AND ${notSent(`'report_card:' || v.id`)}
      ORDER BY v.published_at, v.id
      LIMIT $4`,
    [schoolId, yearId, since, limit],
  )
  return result.rows.map((row) =>
    pupilCandidate(row, `report_card:${row.version_id}`, {
      card: row.card === 'final' ? 'Final report card' : 'Term 1 report card',
    }),
  )
}

/**
 * The fee figures of every active pupil of the current year, exactly as the
 * fee screens compute them, with the reminder or overdue amount per pupil.
 */
async function feeCandidates(
  conn: AuthzConnection,
  schoolId: string,
  yearId: string,
  today: string,
  mode: { kind: 'fee_reminder'; dueOn: string } | { kind: 'fee_overdue'; everyDays: number },
  limit: number,
): Promise<Candidate[]> {
  const cte = feeFiguresCte({
    schoolId,
    academicYearId: yearId,
    asOf: today,
    pupils: sql`students.school_id = ${schoolId}::uuid AND students.status = 'active' AND students.anonymised_at IS NULL`,
    receipts: sql`fee_receipts.school_id = ${schoolId}::uuid`,
  })
  const school = sql`${schoolId}::uuid`
  // The reminder is the instalments falling due that day after concessions,
  // capped at what the pupil still owes for the year; overdue is what has
  // already fallen due and is unpaid.
  const amounts =
    mode.kind === 'fee_reminder'
      ? sql`SELECT d.student_id, LEAST(d.due_paise, GREATEST(o.year_paise, 0))::bigint AS amount_paise
              FROM (SELECT student_id, sum(amount_paise - concession_paise)::bigint AS due_paise
                      FROM fee_conceded WHERE due_on = ${mode.dueOn}::date GROUP BY student_id) d
              JOIN (SELECT student_id, sum(year_balance_paise)::bigint AS year_paise
                      FROM fee_figures GROUP BY student_id) o ON o.student_id = d.student_id`
      : sql`SELECT student_id, sum(balance_paise)::bigint AS amount_paise
              FROM fee_figures GROUP BY student_id`
  const key =
    mode.kind === 'fee_reminder'
      ? sql`'fee_reminder:' || st.id || ':' || ${mode.dueOn}`
      : sql`'fee_overdue:' || st.id || ':' || ${today}`
  const lastOverdue =
    mode.kind === 'fee_overdue'
      ? sql`AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.school_id = ${school} AND m.kind = 'fee_overdue'
                              AND m.student_id = st.id
                              AND m.created_at > now() - make_interval(days => ${mode.everyDays}::int))`
      : sql``
  const result = await conn.db.execute<PupilRow & { amount_paise: string } & Record<string, unknown>>(
    sql`${cte},
        fee_amounts AS (${amounts})
        SELECT st.id AS student_id, st.first_name, st.last_name, ce.section_id, ce.academic_year_id,
               gr.name || ' ' || sec.name AS class_label, a.amount_paise::text AS amount_paise
          FROM fee_amounts a
          JOIN students st ON st.school_id = ${school} AND st.id = a.student_id
          JOIN LATERAL (
            SELECT en.section_id, en.academic_year_id
              FROM enrollments en
             WHERE en.school_id = st.school_id AND en.student_id = st.id
               AND en.academic_year_id = ${yearId}::uuid AND en.left_on IS NULL
             ORDER BY en.joined_on DESC, en.id
             LIMIT 1
          ) ce ON true
          JOIN sections sec ON sec.school_id = st.school_id AND sec.id = ce.section_id
          JOIN grades gr ON gr.school_id = sec.school_id AND gr.id = sec.grade_id
         WHERE a.amount_paise > 0
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.school_id = ${school} AND m.dedupe_key = ${key})
           ${lastOverdue}
         ORDER BY st.id
         LIMIT ${limit}`,
  )
  return result.rows.map((row) => {
    const amount = formatRupees(toPaise(row.amount_paise))
    return mode.kind === 'fee_reminder'
      ? pupilCandidate(row, `fee_reminder:${row.student_id}:${mode.dueOn}`, {
          amount,
          due_date: formatMessageDate(mode.dueOn),
        })
      : pupilCandidate(row, `fee_overdue:${row.student_id}:${today}`, { amount })
  })
}

/** Born on this day and month; 29 February counts on 28 February in other years. `today` names the parameter. */
const birthdayToday = (column: string, today: string) => `(
  to_char(${column}, 'MM-DD') = to_char(${today}::date, 'MM-DD')
  OR (to_char(${column}, 'MM-DD') = '02-29' AND to_char(${today}::date, 'MM-DD') = '02-28'
      AND to_char(make_date(extract(year FROM ${today}::date)::int, 3, 1) - 1, 'DD') = '28'))`

async function pupilBirthdayCandidates(
  conn: AuthzConnection,
  schoolId: string,
  yearId: string,
  today: string,
  limit: number,
): Promise<Candidate[]> {
  const year = today.slice(0, 4)
  const result = await conn.client.query<PupilRow>(
    `SELECT st.id AS student_id, st.first_name, st.last_name, ce.section_id, ce.academic_year_id,
            gr.name || ' ' || sec.name AS class_label
       FROM students st
       ${CURRENT_CLASS}
      WHERE st.school_id = $1 AND st.status = 'active' AND st.anonymised_at IS NULL
        AND st.date_of_birth IS NOT NULL AND ${birthdayToday('st.date_of_birth', '$3')}
        AND ${notSent(`'birthday_pupil:' || st.id || ':' || $4`)}
      ORDER BY st.id
      LIMIT $5`,
    [schoolId, yearId, today, year, limit],
  )
  return result.rows.map((row) => pupilCandidate(row, `birthday_pupil:${row.student_id}:${year}`))
}

async function staffBirthdayCandidates(
  conn: AuthzConnection,
  schoolId: string,
  today: string,
  limit: number,
): Promise<Candidate[]> {
  const year = today.slice(0, 4)
  const result = await conn.client.query<{ staff_id: string; first_name: string; last_name: string | null }>(
    `SELECT s.id AS staff_id, s.first_name, s.last_name
       FROM staff s
      WHERE s.school_id = $1 AND s.status IN ('active', 'on_leave') AND s.anonymised_at IS NULL
        AND s.date_of_birth IS NOT NULL AND ${birthdayToday('s.date_of_birth', '$2')}
        AND ${notSent(`'birthday_staff:' || s.id || ':' || $3`)}
      ORDER BY s.id
      LIMIT $4`,
    [schoolId, today, year, limit],
  )
  return result.rows.map((row) => ({
    dedupeKey: `birthday_staff:${row.staff_id}:${year}`,
    staffId: row.staff_id,
    values: {
      staff_name: [row.first_name, row.last_name].filter(Boolean).join(' '),
      staff_first_name: row.first_name,
    },
  }))
}

/**
 * Insert the messages of one kind and send each. Returns how many were made;
 * a key already taken (another runner, or a message made since the query)
 * is skipped without a word.
 */
async function writeAndSend(
  conn: AuthzConnection,
  deps: DispatchDependencies,
  schoolId: string,
  schoolName: string,
  kind: AutomaticMessageKind,
  wording: { title: string; body: string; templateId?: string },
  candidates: readonly Candidate[],
): Promise<number> {
  let created = 0
  for (const candidate of candidates) {
    const values = { school: schoolName, ...candidate.values }
    const title = renderMessageText(wording.title, values).slice(0, MESSAGE_TITLE_MAX)
    const body = renderMessageText(wording.body, values).slice(0, MESSAGE_BODY_MAX)
    const inserted = await conn.client.query<{ id: string }>(
      `INSERT INTO messages
         (school_id, kind, audience, student_id, staff_id, section_id, academic_year_id,
          title, body, status, template_id, dedupe_key, recipients)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10, $11, $12)
       ON CONFLICT (school_id, dedupe_key) DO NOTHING
       RETURNING id`,
      [
        schoolId,
        kind,
        kind === 'birthday_staff' ? 'staff_member' : 'pupil',
        candidate.studentId ?? null,
        candidate.staffId ?? null,
        candidate.sectionId ?? null,
        candidate.academicYearId ?? null,
        title,
        body,
        wording.templateId ?? null,
        candidate.dedupeKey,
        // To the family, except a birthday wish, which the pupil also gets in
        // the app when their login is on; a staff member's has no recipients.
        kind === 'birthday_staff' ? null : kind === 'birthday_pupil' ? 'both' : 'families',
      ],
    )
    const id = inserted.rows[0]?.id
    if (!id) continue
    await materialiseMessage(conn, deps, schoolId, id, { allowEmpty: true })
    created += 1
  }
  return created
}

/**
 * Make and send the automatic messages that are due now, at most
 * AUTOMATIC_MESSAGES_PER_RUN of them. Runs inside the pump's transaction,
 * after the settings row exists.
 */
export async function createAutomaticMessages(
  conn: AuthzConnection,
  deps: DispatchDependencies,
  schoolId: string,
): Promise<{ created: number }> {
  const settings = await loadCommunicationSettings(conn, schoolId)
  const clock = await schoolClock(conn, schoolId)
  if (!clock || !settings.automaticSince) return { created: 0 }
  const since = settings.automaticSince
  const wording = await loadAutomaticWording(conn, schoolId)
  const yearId = await currentYearId(conn, schoolId)
  const daily = clock.hour >= settings.dailySendHour

  let left = AUTOMATIC_MESSAGES_PER_RUN
  let created = 0
  const run = async (kind: AutomaticMessageKind, find: (limit: number) => Promise<Candidate[]>) => {
    if (left <= 0) return
    const candidates = await find(left)
    const made = await writeAndSend(conn, deps, schoolId, clock.name, kind, wording[kind], candidates)
    // Every candidate counts against the bound, made or skipped, so a run
    // always ends however many keys another runner took.
    left -= candidates.length
    created += made
  }

  if (settings.absenceEnabled)
    await run('absence', (limit) =>
      absenceCandidates(conn, schoolId, clock.today, settings.absenceDelayMinutes, since, limit),
    )
  if (settings.resultsEnabled) await run('result', (limit) => resultCandidates(conn, schoolId, since, limit))
  if (yearId !== null) {
    if (settings.reportCardsEnabled)
      await run('report_card', (limit) => reportCardCandidates(conn, schoolId, yearId, since, limit))
    if (daily && settings.feeRemindersEnabled) {
      const dueOn = await addDays(conn, clock.today, settings.feeReminderDaysBefore)
      await run('fee_reminder', (limit) =>
        feeCandidates(conn, schoolId, yearId, clock.today, { kind: 'fee_reminder', dueOn }, limit),
      )
    }
    // Fee dues ride on the fee reminder switch; 0 days turns them off on their own.
    if (daily && settings.feeRemindersEnabled && settings.feeOverdueEveryDays > 0)
      await run('fee_overdue', (limit) =>
        feeCandidates(
          conn,
          schoolId,
          yearId,
          clock.today,
          { kind: 'fee_overdue', everyDays: settings.feeOverdueEveryDays },
          limit,
        ),
      )
    if (daily && settings.birthdaysPupilsEnabled)
      await run('birthday_pupil', (limit) => pupilBirthdayCandidates(conn, schoolId, yearId, clock.today, limit))
  }
  if (daily && settings.birthdaysStaffEnabled)
    await run('birthday_staff', (limit) => staffBirthdayCandidates(conn, schoolId, clock.today, limit))

  return { created }
}

async function addDays(conn: AuthzConnection, isoDate: string, days: number): Promise<string> {
  const result = await conn.client.query<{ day: string }>(
    `SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS day`,
    [isoDate, days],
  )
  return result.rows[0]?.day ?? isoDate
}
