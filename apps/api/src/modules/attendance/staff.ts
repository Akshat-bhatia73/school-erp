import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import {
  type AttendanceCalendarDay,
  type AttendanceDayWindow,
  type AttendanceMark,
  type AttendanceStaffMember,
  type ErrorReason,
  type PermissionKey,
  StaffAttendanceCorrectionRequest,
  StaffAttendanceDayResponse,
  StaffAttendanceMarkRequest,
  StaffAttendanceMemberMonthResponse,
  StaffAttendanceMonthResponse,
  type StaffAttendanceRow,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { loadRelationshipFactsFor } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import {
  allowedActionsFor,
  ApiFailure,
  assertUuidParam,
  decideResource,
  decideSchoolAction,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  type AttendanceConnection,
  monthBounds,
  readCalendar,
  readCalendarDay,
  schoolToday,
  staffAttendancePlans,
  type StaffAttendancePlans,
  staffFiguresCte,
  toCalendarDay,
  toSummary,
  yearOfMonth,
} from './figures.ts'

/**
 * The staff register.
 *
 * The office marks everybody on the register once a day, and each member of
 * staff reads their own month. Nobody marks their own row. Everything here
 * reads the staff figures CTE, so the day, the month and the files can never
 * disagree about who was on the register or what a percentage is.
 */

/** The date and month shapes a path may carry. Anything else is not a record. */
const DATE = /^\d{4}-\d{2}-\d{2}$/
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

function assertDateParam(value: string): string {
  // The shape and the calendar both have to agree: 2026-13-45 is not a date.
  if (!DATE.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ApiFailure('RESOURCE_NOT_FOUND')
  }
  return value
}

function assertMonthParam(value: string): string {
  if (!MONTH.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return value
}

/** The four keys a staff register response may offer, in catalogue order. */
const STAFF_KEYS = [
  'staff_attendance.read',
  'staff_attendance.record',
  'staff_attendance.manage',
  'staff_attendance.export',
] as const satisfies readonly PermissionKey[]

/**
 * A day or a month is not one record, so its actions are the school-wide
 * decisions for the keys of this register, taken on the caller's own
 * connection like every other decision in a module.
 */
async function registerActions(
  conn: AttendanceConnection,
  context: RequestContext,
): Promise<PermissionKey[]> {
  const allowed: PermissionKey[] = []
  for (const key of STAFF_KEYS) {
    if ((await decideSchoolAction(conn, context, key)).allowed) allowed.push(key)
  }
  return allowed
}

/** The staff member the caller is, when they are one at all. */
async function selfStaffIdOf(conn: AttendanceConnection, context: RequestContext): Promise<string | null> {
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  return facts.selfStaffId
}

/**
 * What the server will accept on this day from this caller. The reasons come
 * from the closed list and are only given when the caller holds the key: a
 * person who may not record is told nothing about why the day is shut.
 */
function windowFor(input: {
  readonly day: AttendanceCalendarDay
  readonly date: string
  readonly today: string
  readonly canRecord: boolean
  readonly canManage: boolean
}): AttendanceDayWindow {
  const schoolDay = input.day.kind === 'school_day'
  const future = input.date > input.today
  const dayReason = (past: ErrorReason): ErrorReason => {
    if (input.day.kind === 'outside_year') return 'attendance_date_outside_year'
    if (!schoolDay) return 'attendance_not_a_school_day'
    if (future) return 'attendance_date_in_future'
    return past
  }

  const record = schoolDay && input.date === input.today && input.canRecord
  const correct = schoolDay && !future && input.canManage
  return {
    record,
    ...(record || !input.canRecord
      ? {}
      : { recordBlockedBy: dayReason('attendance_marking_window_closed') }),
    correct,
    // A correction is open on any past school day, so the only thing left to
    // say when it is shut is what the day itself is.
    ...(correct || !input.canManage ? {} : { correctBlockedBy: dayReason('attendance_date_in_future') }),
  }
}

/** The refusal a write owes when the day is not one to mark. */
function assertMarkableDay(input: {
  readonly day: AttendanceCalendarDay
  readonly date: string
  readonly today: string
  /** A correction may reach back; a marking may not. */
  readonly correction: boolean
}): void {
  if (input.day.kind === 'outside_year') {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_date_outside_year')
  }
  if (input.day.kind !== 'school_day') {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_not_a_school_day')
  }
  if (input.date > input.today) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_date_in_future')
  }
  if (!input.correction && input.date !== input.today) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'attendance_marking_window_closed')
  }
}

// ---------------------------------------------------------------------------
// The register on one day.

interface RegisterRow extends Record<string, unknown> {
  staff_id: string
  employee_code: string
  first_name: string
  last_name: string | null
  designation: string | null
  mark: AttendanceMark | null
  entry_id: string | null
  revision: number | null
  entry_kind: 'marking' | 'correction' | null
  recorded_at: string | null
}

function staffMemberOf(row: {
  staff_id: string
  employee_code: string
  first_name: string
  last_name: string | null
  designation: string | null
}): AttendanceStaffMember {
  return {
    id: row.staff_id,
    name: [row.first_name, row.last_name].filter((part) => part !== null && part !== '').join(' ').slice(0, 160),
    employeeCode: row.employee_code,
    ...(row.designation === null || row.designation === '' ? {} : { designation: row.designation.slice(0, 160) }),
  }
}

/**
 * Everybody on the register that day, with the mark that stands, in employee
 * code order. Who is on it is `sta_people`: joined on or before the day and
 * not yet left, narrowed by the caller's own plan over the staff record.
 */
async function registerRows(
  conn: AttendanceConnection,
  schoolId: string,
  plans: StaffAttendancePlans,
  date: string,
  today: string,
): Promise<RegisterRow[]> {
  const cte = staffFiguresCte({
    schoolId,
    from: date,
    to: date,
    asOf: today,
    holidays: plans.holidays,
    people: plans.people,
    entries: plans.entries,
  })
  const rows = await conn.db.execute<RegisterRow>(
    sql`${cte}
        SELECT p.staff_id, s.employee_code, s.first_name, s.last_name, s.designation,
               c.mark, c.id AS entry_id, c.revision, c.kind AS entry_kind,
               to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSOF:00') AS recorded_at
          FROM sta_people p
          JOIN staff s ON s.school_id = ${schoolId}::uuid AND s.id = p.staff_id
          LEFT JOIN sta_current c ON c.staff_id = p.staff_id AND c.date = ${date}::date
         ORDER BY s.employee_code, p.staff_id`,
  )
  return rows.rows
}

/** The register on one date, as the contract draws it. */
export async function readStaffDay(
  conn: AttendanceConnection,
  context: RequestContext,
  date: string,
): Promise<StaffAttendanceDayResponse> {
  const schoolId = context.schoolId
  const plans = await staffAttendancePlans(conn, context)
  const today = await schoolToday(conn, schoolId)
  const day = toCalendarDay(
    await readCalendarDay(conn, { schoolId, asOf: today, holidays: plans.holidays, date }),
  )
  const rows = await registerRows(conn, schoolId, plans, date, today)
  const selfStaffId = await selfStaffIdOf(conn, context)
  const allowedActions = await registerActions(conn, context)

  const projected: StaffAttendanceRow[] = rows.map((row) => ({
    staff: staffMemberOf(row),
    ...(row.mark === null ? {} : { mark: row.mark }),
    ...(row.entry_id === null || row.revision === null || row.entry_kind === null || row.recorded_at === null
      ? {}
      : {
          entry: {
            id: row.entry_id,
            revision: Number(row.revision),
            kind: row.entry_kind,
            recordedAt: row.recorded_at,
          },
        }),
    self: selfStaffId !== null && row.staff_id === selfStaffId,
  }))

  return {
    date,
    day,
    window: windowFor({
      day,
      date,
      today,
      canRecord: allowedActions.includes('staff_attendance.record'),
      canManage: allowedActions.includes('staff_attendance.manage'),
    }),
    marked: projected.some((row) => row.mark !== undefined),
    rows: projected,
    allowedActions,
  }
}

// ---------------------------------------------------------------------------
// The months.

interface MonthMarkRow extends Record<string, unknown> {
  staff_id: string
  day: string
  mark: AttendanceMark | null
  corrected: boolean | null
}

interface FiguresRow extends Record<string, unknown> {
  staff_id: string
  school_days: number
  present: number
  absent: number
  late: number
  leave: number
  half_day: number
  unmarked: number
}

/** One day of somebody's month: on the register or not, and the mark. */
function monthDay(
  day: AttendanceCalendarDay,
  found: MonthMarkRow | undefined,
): { date: string; onRegister: boolean; mark?: AttendanceMark; corrected?: boolean } {
  return {
    date: day.date,
    onRegister: found !== undefined,
    ...(found?.mark ? { mark: found.mark } : {}),
    ...(found?.corrected ? { corrected: true } : {}),
  }
}

/** The month's marks and figures for everybody the `people` predicate selects. */
async function readMonthFor(
  conn: AttendanceConnection,
  context: RequestContext,
  plans: StaffAttendancePlans,
  month: string,
  people: SQL,
): Promise<{
  days: AttendanceCalendarDay[]
  markedDays: ReadonlySet<string>
  marks: Map<string, Map<string, MonthMarkRow>>
  figures: Map<string, FiguresRow>
  people: Map<string, RegisterRow>
}> {
  const schoolId = context.schoolId
  const { from, to } = monthBounds(month)
  const today = await schoolToday(conn, schoolId)
  const calendar = await readCalendar(conn, { schoolId, from, to, asOf: today, holidays: plans.holidays })
  const cte = staffFiguresCte({ schoolId, from, to, asOf: today, holidays: plans.holidays, people, entries: plans.entries })

  const markRows = await conn.db.execute<MonthMarkRow>(
    sql`${cte}
        SELECT staff_id, to_char(day, 'YYYY-MM-DD') AS day, mark, corrected FROM sta_days`,
  )
  const figureRows = await conn.db.execute<FiguresRow>(
    sql`${cte}
        SELECT staff_id, school_days, present, absent, late, leave, half_day, unmarked FROM sta_figures`,
  )
  const peopleRows = await conn.db.execute<RegisterRow>(
    sql`${cte}
        SELECT p.staff_id, s.employee_code, s.first_name, s.last_name, s.designation,
               NULL::text AS mark, NULL::uuid AS entry_id, NULL::int AS revision,
               NULL::text AS entry_kind, NULL::text AS recorded_at
          FROM sta_people p
          JOIN staff s ON s.school_id = ${schoolId}::uuid AND s.id = p.staff_id
         ORDER BY s.employee_code, p.staff_id`,
  )

  const marks = new Map<string, Map<string, MonthMarkRow>>()
  for (const row of markRows.rows) {
    const byDay = marks.get(row.staff_id) ?? new Map<string, MonthMarkRow>()
    byDay.set(row.day, row)
    marks.set(row.staff_id, byDay)
  }
  return {
    days: calendar.map(toCalendarDay),
    markedDays: new Set(markRows.rows.filter((row) => row.mark !== null).map((row) => row.day)),
    marks,
    figures: new Map(figureRows.rows.map((row) => [row.staff_id, row])),
    people: new Map(peopleRows.rows.map((row) => [row.staff_id, row])),
  }
}

/** The whole register for a month: one row per person, one column per day. */
export async function readStaffMonth(
  conn: AttendanceConnection,
  context: RequestContext,
  month: string,
): Promise<StaffAttendanceMonthResponse> {
  const plans = await staffAttendancePlans(conn, context)
  const year = await yearOfMonth(conn, context.schoolId, month)
  const found = await readMonthFor(conn, context, plans, month, plans.people)
  return {
    academicYear: { id: year.id, name: year.name },
    month,
    days: found.days.map((day) => ({ ...day, marked: found.markedDays.has(day.date) })),
    rows: [...found.people.values()].map((person) => {
      const byDay = found.marks.get(person.staff_id)
      return {
        staff: staffMemberOf(person),
        marks: found.days.map((day) => monthDay(day, byDay?.get(day.date))),
        summary: toSummary(found.figures.get(person.staff_id)),
      }
    }),
    allowedActions: await registerActions(conn, context),
  }
}

/** One staff member's own month. The record has already been decided. */
export async function readStaffMemberMonth(
  conn: AttendanceConnection,
  context: RequestContext,
  staffId: string,
  month: string,
): Promise<StaffAttendanceMemberMonthResponse> {
  const schoolId = context.schoolId
  const plans = await staffAttendancePlans(conn, context)
  const year = await yearOfMonth(conn, schoolId, month)
  // The person is read under the same plan as the register, so somebody the
  // caller may not name is simply not there.
  const person = await conn.db.execute<RegisterRow>(
    sql`SELECT staff.id AS staff_id, staff.employee_code, staff.first_name, staff.last_name, staff.designation,
               NULL::text AS mark, NULL::uuid AS entry_id, NULL::int AS revision,
               NULL::text AS entry_kind, NULL::text AS recorded_at
          FROM staff
         WHERE staff.school_id = ${schoolId}::uuid AND staff.id = ${staffId}::uuid AND (${plans.people})
         LIMIT 1`,
  )
  const row = person.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')

  const found = await readMonthFor(
    conn,
    context,
    plans,
    month,
    sql`staff.id = ${staffId}::uuid AND (${plans.people})`,
  )
  const byDay = found.marks.get(staffId)
  return {
    staff: staffMemberOf(row),
    academicYear: { id: year.id, name: year.name },
    month,
    days: found.days.map((day) => ({ ...day, ...monthDay(day, byDay?.get(day.date)) })),
    summary: toSummary(found.figures.get(staffId)),
    allowedActions: [
      ...(await allowedActionsFor(conn, context, { schoolId, resourceType: 'staff_attendance', id: staffId })),
    ],
  }
}

// ---------------------------------------------------------------------------
// The writes.

/** The counts an audit row reports about what was just marked. */
function countsOf(marks: readonly { readonly mark: AttendanceMark }[]): Record<string, number> {
  const count = (mark: AttendanceMark) => marks.filter((line) => line.mark === mark).length
  return {
    present: count('present'),
    absent: count('absent'),
    late: count('late'),
    leave: count('leave'),
    halfDay: count('half_day'),
  }
}

/**
 * One new row per person whose mark changed. Nothing is ever updated: the new
 * row carries the next revision and points at the one it supersedes.
 */
async function appendEntries(
  conn: AttendanceConnection,
  context: RequestContext,
  input: {
    readonly date: string
    readonly kind: 'marking' | 'correction'
    readonly lines: readonly { readonly staffId: string; readonly mark: AttendanceMark }[]
    readonly current: ReadonlyMap<string, RegisterRow>
  },
): Promise<number> {
  let changed = 0
  for (const line of input.lines) {
    const row = input.current.get(line.staffId)
    if (row && row.mark === line.mark) continue
    await conn.client.query(
      `INSERT INTO staff_attendance_entries
         (school_id, staff_id, date, mark, revision, supersedes_entry_id, kind, recorded_by_membership_id)
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8)`,
      [
        context.schoolId,
        line.staffId,
        input.date,
        line.mark,
        row?.revision ? Number(row.revision) + 1 : 1,
        row?.entry_id ?? null,
        input.kind,
        context.membershipId,
      ],
    )
    changed += 1
  }
  return changed
}

/** Nobody marks their own attendance, whichever way they ask. */
function assertNotSelf(
  lines: readonly { readonly staffId: string }[],
  selfStaffId: string | null,
): void {
  if (selfStaffId !== null && lines.some((line) => line.staffId === selfStaffId)) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'staff_attendance_own_record')
  }
}

export function registerStaffAttendanceRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/staff-attendance/days/:date',
    permission: 'staff_attendance.read',
    response: StaffAttendanceDayResponse,
    handler: async ({ context, param }) => {
      const date = assertDateParam(param('date'))
      return withTenantTransaction(deps.pools.runtime, context, (conn) => readStaffDay(conn, context, date))
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/staff-attendance/days/:date',
    permission: 'staff_attendance.record',
    body: StaffAttendanceMarkRequest,
    response: StaffAttendanceDayResponse,
    handler: async ({ context, body, param }) => {
      const date = assertDateParam(param('date'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const plans = await staffAttendancePlans(conn, context, 'staff_attendance.record')
        const today = await schoolToday(conn, context.schoolId)
        const day = toCalendarDay(
          await readCalendarDay(conn, { schoolId: context.schoolId, asOf: today, holidays: plans.holidays, date }),
        )
        assertMarkableDay({ day, date, today, correction: false })

        const selfStaffId = await selfStaffIdOf(conn, context)
        assertNotSelf(body.marks, selfStaffId)

        const register = await registerRows(conn, context.schoolId, plans, date, today)
        const current = new Map(register.map((row) => [row.staff_id, row]))
        // The register is marked whole: everybody on it that day except the
        // caller's own row, and nobody else.
        const expected = new Set(register.map((row) => row.staff_id).filter((id) => id !== selfStaffId))
        for (const line of body.marks) {
          if (!expected.has(line.staffId)) {
            throw new ApiFailure('INVALID_REQUEST', undefined, 'staff_attendance_not_on_register')
          }
        }
        if (body.marks.length !== expected.size) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'staff_attendance_register_incomplete')
        }

        const changed = await appendEntries(conn, context, { date, kind: 'marking', lines: body.marks, current })
        await writeAudit(conn, context, {
          action: 'staff_attendance.record',
          targetType: 'staff_attendance',
          targetId: null,
          summary: 'Marked the staff attendance register.',
          safeChanges: { date, people: body.marks.length, changed, ...countsOf(body.marks) },
        })
        return readStaffDay(conn, context, date)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/staff-attendance/days/:date/corrections',
    permission: 'staff_attendance.manage',
    body: StaffAttendanceCorrectionRequest,
    response: StaffAttendanceDayResponse,
    successStatus: 201,
    handler: async ({ context, body, param }) => {
      const date = assertDateParam(param('date'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const plans = await staffAttendancePlans(conn, context, 'staff_attendance.manage')
        const today = await schoolToday(conn, context.schoolId)
        const day = toCalendarDay(
          await readCalendarDay(conn, { schoolId: context.schoolId, asOf: today, holidays: plans.holidays, date }),
        )
        assertMarkableDay({ day, date, today, correction: true })

        const selfStaffId = await selfStaffIdOf(conn, context)
        assertNotSelf(body.marks, selfStaffId)

        const register = await registerRows(conn, context.schoolId, plans, date, today)
        const current = new Map(register.map((row) => [row.staff_id, row]))
        for (const line of body.marks) {
          if (!current.has(line.staffId)) {
            throw new ApiFailure('INVALID_REQUEST', undefined, 'staff_attendance_not_on_register')
          }
        }

        const corrected = await appendEntries(conn, context, {
          date,
          kind: 'correction',
          lines: body.marks,
          current,
        })
        await writeAudit(conn, context, {
          action: 'staff_attendance.manage',
          targetType: 'staff_attendance',
          targetId: null,
          summary: 'Corrected the staff attendance register.',
          safeChanges: { date, corrected },
          note: body.reason,
        })
        return readStaffDay(conn, context, date)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/staff-attendance/months/:month',
    permission: 'staff_attendance.read',
    response: StaffAttendanceMonthResponse,
    handler: async ({ context, param }) => {
      const month = assertMonthParam(param('month'))
      return withTenantTransaction(deps.pools.runtime, context, (conn) => readStaffMonth(conn, context, month))
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/staff-attendance/staff/:staffId/months/:month',
    permission: 'staff_attendance.read',
    response: StaffAttendanceMemberMonthResponse,
    auditRead: {
      targetType: 'staff',
      param: 'staffId',
      summary: "Read a staff member's monthly attendance.",
      detail: (result) => ({ month: result.month }),
    },
    handler: async ({ context, param }) => {
      const staffId = assertUuidParam(param('staffId'))
      const month = assertMonthParam(param('month'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const decision = await decideResource(conn, context, 'staff_attendance.read', 'staff_attendance', staffId)
        if (!decision.allowed) {
          throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
        }
        return readStaffMemberMonth(conn, context, staffId, month)
      })
    },
  })
}
