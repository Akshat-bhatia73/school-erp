import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import { AuthorizationError, planPredicate, scopedTableFor } from '@erp/authz'
import {
  LEAVE_LIST_MAX,
  LeaveCancelRequest,
  LeaveListRequest,
  type PermissionKey,
  StaffLeaveCreateRequest,
  StaffLeaveListResponse,
  StaffLeaveRecord,
  StudentLeaveCreateRequest,
  StudentLeaveListResponse,
  StudentLeaveRecord,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  allowedActionsForMany,
  ApiFailure,
  assertUuidParam,
  bumpVersion,
  decideResource,
  decideSchoolAction,
  lockSchool,
  protectedRoute,
  readPlan,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import {
  attendancePlans,
  schoolToday,
  staffAttendancePlans,
  type AttendanceConnection,
} from './figures.ts'
import { decideAttendance, pupilRef, sectionVisibility } from './reads.ts'

/**
 * Recorded leave (migration 0028): the office writes down ahead of time that
 * a pupil or a staff member will be away for a stretch of days, and may
 * cancel it. A record is never removed and never edited: cancelling stamps it
 * and keeps it.
 *
 * Leave is a plan, not a mark. The register pre-selects "leave" for the days
 * it covers, an unmarked school day inside it counts as leave in every figure
 * (figures.ts), and a mark somebody saved always wins.
 *
 * Pupil leave is read and written under the attendance keys through the
 * attendance pupil face, so a teacher reads the leave of the pupils in their
 * own sections and a parent their own child's. Staff leave sits under the
 * staff attendance keys through the person face, so a teacher reads only
 * their own. A list carries a record only when the caller may read the
 * person's own month, which is the detail read of a leave record.
 */

const ISO_TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MSOF:00'`

/** Calendar days from one date to another, both ends included. */
function dayCount(startsOn: string, endsOn: string): number {
  return Math.round((Date.parse(`${endsOn}T00:00:00Z`) - Date.parse(`${startsOn}T00:00:00Z`)) / 86_400_000) + 1
}

/** A plan the caller does not hold at all reads as FALSE, not as an error. */
async function predicateOrFalse(build: () => Promise<SQL>): Promise<SQL> {
  try {
    return await build()
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'ACCESS_DENIED') return sql`FALSE`
    throw error
  }
}

function table(kind: 'staff' | 'enrollment') {
  const scoped = scopedTableFor(kind)
  if (!scoped) throw new Error(`the authorizer has no scoped table for ${kind}`)
  return scoped
}

/**
 * Which records of the window a list asks for: those overlapping from..to,
 * or with neither, those that have not ended before today. Cancelled records
 * only when asked.
 */
function listFilter(query: LeaveListRequest, today: string): SQL {
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    throw new ApiFailure('INVALID_REQUEST')
  }
  const parts: SQL[] = []
  if (query.from === undefined && query.to === undefined) parts.push(sql`leave_records.ends_on >= ${today}::date`)
  if (query.from !== undefined) parts.push(sql`leave_records.ends_on >= ${query.from}::date`)
  if (query.to !== undefined) parts.push(sql`leave_records.starts_on <= ${query.to}::date`)
  if (query.includeCancelled !== 'true') parts.push(sql`leave_records.cancelled_at IS NULL`)
  return sql.join(parts, sql` AND `)
}

/**
 * The name of whoever recorded a row, only when their staff record is one
 * the caller may read in the directory, exactly as a mark's history names it.
 */
async function recorderName(conn: AttendanceConnection, context: RequestContext): Promise<SQL> {
  const directory = await predicateOrFalse(async () =>
    planPredicate(await readPlan(conn, context, 'staff.read_directory', 'staff'), table('staff')),
  )
  return sql`(SELECT staff.first_name || COALESCE(' ' || NULLIF(staff.last_name, ''), '')
      FROM membership_staff_links msl
      JOIN staff ON staff.school_id = msl.school_id AND staff.id = msl.staff_id
     WHERE msl.school_id = leave_records.school_id
       AND msl.membership_id = leave_records.recorded_by_membership_id
       AND (${directory})
     LIMIT 1)`
}

interface LeaveRow extends Record<string, unknown> {
  id: string
  version: number
  starts_on: string
  ends_on: string
  reason: string | null
  cancelled_at: string | null
  recorded_at: string
  recorded_by: string | null
}

const LEAVE_COLUMNS = sql`leave_records.id, leave_records.version,
    to_char(leave_records.starts_on, 'YYYY-MM-DD') AS starts_on,
    to_char(leave_records.ends_on, 'YYYY-MM-DD') AS ends_on,
    leave_records.reason,
    to_char(leave_records.cancelled_at, ${sql.raw(ISO_TIMESTAMP)}) AS cancelled_at,
    to_char(leave_records.created_at, ${sql.raw(ISO_TIMESTAMP)}) AS recorded_at`

/** What every record says, whoever it is about. */
function common(row: LeaveRow, allowedActions: readonly PermissionKey[]) {
  const recordedBy = row.recorded_by?.trim().slice(0, 160) ?? ''
  return {
    id: row.id,
    version: Number(row.version),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    days: dayCount(row.starts_on, row.ends_on),
    ...(row.reason === null ? {} : { reason: row.reason }),
    status: row.cancelled_at === null ? ('active' as const) : ('cancelled' as const),
    recordedAt: row.recorded_at,
    ...(recordedBy === '' ? {} : { recordedBy }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
    allowedActions: [...allowedActions],
  }
}

/**
 * The actions on one record: the read key, and the manage key when the caller
 * may cancel it, which a cancelled record never offers again.
 */
function recordActions(
  decided: readonly PermissionKey[] | undefined,
  keys: readonly [PermissionKey, PermissionKey],
  cancelled: boolean,
): PermissionKey[] {
  const [read, manage] = keys
  return (decided ?? []).filter((key) => key === read || (key === manage && !cancelled))
}

/** The list-level actions: whether the caller reads leave and may record more. */
async function listActions(
  conn: AttendanceConnection,
  context: RequestContext,
  keys: readonly [PermissionKey, PermissionKey],
): Promise<PermissionKey[]> {
  const allowed: PermissionKey[] = []
  for (const key of keys) {
    if ((await decideSchoolAction(conn, context, key)).allowed) allowed.push(key)
  }
  return allowed
}

/** A person must still be here for leave to be recorded against them. */
function assertActive(status: string | undefined, active: readonly string[]): void {
  if (status === undefined) throw new ApiFailure('RESOURCE_NOT_FOUND')
  if (!active.includes(status)) throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_person_not_active')
}

/**
 * Two active records of one person may not share a day. Checked under the
 * school lock, so two office members saving at once cannot both get through.
 */
async function assertNoOverlap(
  conn: AttendanceConnection,
  schoolId: string,
  person: { readonly column: 'student_id' | 'staff_id'; readonly id: string },
  startsOn: string,
  endsOn: string,
): Promise<void> {
  const found = await conn.client.query(
    `SELECT 1 FROM leave_records
      WHERE school_id = $1 AND ${person.column} = $2 AND cancelled_at IS NULL
        AND starts_on <= $4::date AND ends_on >= $3::date
      LIMIT 1`,
    [schoolId, person.id, startsOn, endsOn],
  )
  if (found.rows.length > 0) throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_overlaps')
}

/** The stored facts a cancel is decided on. */
interface StoredLeave {
  readonly person_id: string
  readonly version: number
  readonly starts_on: string
  readonly ends_on: string
  readonly cancelled: boolean
}

async function readStored(
  conn: AttendanceConnection,
  schoolId: string,
  kind: 'student' | 'staff',
  id: string,
): Promise<StoredLeave> {
  const column = kind === 'student' ? 'student_id' : 'staff_id'
  const found = await conn.client.query<StoredLeave>(
    `SELECT ${column} AS person_id, version, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(ends_on, 'YYYY-MM-DD') AS ends_on, (cancelled_at IS NOT NULL) AS cancelled
       FROM leave_records WHERE school_id = $1 AND id = $2 AND person_kind = $3`,
    [schoolId, id, kind],
  )
  const row = found.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

async function insertLeave(
  conn: AttendanceConnection,
  context: RequestContext,
  input: {
    readonly kind: 'student' | 'staff'
    readonly personId: string
    readonly startsOn: string
    readonly endsOn: string
    readonly reason: string | undefined
  },
): Promise<string> {
  const inserted = await conn.client.query<{ id: string }>(
    `INSERT INTO leave_records (school_id, person_kind, student_id, staff_id, starts_on, ends_on, reason,
                                recorded_by_membership_id)
     VALUES ($1, $2, $3, $4, $5::date, $6::date, $7, $8)
     RETURNING id`,
    [
      context.schoolId,
      input.kind,
      input.kind === 'student' ? input.personId : null,
      input.kind === 'staff' ? input.personId : null,
      input.startsOn,
      input.endsOn,
      input.reason ?? null,
      context.membershipId,
    ],
  )
  const id = inserted.rows[0]?.id
  if (!id) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return id
}

// ---------------------------------------------------------------------------
// Pupils.

const PUPIL_KEYS = ['attendance.read', 'attendance.manage'] as const satisfies readonly [PermissionKey, PermissionKey]

interface PupilLeaveRow extends LeaveRow {
  student_id: string
  first_name: string
  last_name: string | null
  admission_number: string
  roll_number: number | null
  section_id: string | null
  section_name: string | null
  grade_id: string | null
  grade_name: string | null
}

/**
 * Pupil leave through the caller's own plans. The pupil is joined under the
 * attendance pupil plan (and the basic student read, so a record names only
 * a pupil the register would name). The class is the enrolment on the first
 * day of the leave, named only when the caller may read that enrolment and
 * that section.
 */
async function readPupilLeave(
  conn: AttendanceConnection,
  context: RequestContext,
  filter: SQL,
): Promise<StudentLeaveRecord[]> {
  const schoolId = context.schoolId
  const plans = await attendancePlans(conn, context)
  const sections = await sectionVisibility(conn, context)
  const enrolments = await predicateOrFalse(async () =>
    planPredicate(await readPlan(conn, context, 'students.read_enrollments', 'enrollment'), table('enrollment')),
  )
  const recorder = await recorderName(conn, context)
  const found = await conn.db.execute<PupilLeaveRow>(
    sql`SELECT ${LEAVE_COLUMNS}, ${recorder} AS recorded_by,
               students.id AS student_id, students.first_name, students.last_name, students.admission_number,
               klass.roll_number, klass.section_id, klass.section_name, klass.grade_id, klass.grade_name
          FROM leave_records
          JOIN students ON students.school_id = leave_records.school_id AND students.id = leave_records.student_id
          LEFT JOIN LATERAL (
            SELECT enrollments.roll_number, sections.id AS section_id, sections.name AS section_name,
                   grades.id AS grade_id, grades.name AS grade_name
              FROM enrollments
              JOIN sections ON sections.school_id = enrollments.school_id AND sections.id = enrollments.section_id
              JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
             WHERE enrollments.school_id = leave_records.school_id
               AND enrollments.student_id = leave_records.student_id
               AND enrollments.joined_on <= leave_records.starts_on
               AND (enrollments.left_on IS NULL OR enrollments.left_on >= leave_records.starts_on)
               AND (${enrolments}) AND (${sections})
             ORDER BY enrollments.joined_on DESC, enrollments.id
             LIMIT 1
          ) klass ON TRUE
         WHERE leave_records.school_id = ${schoolId}::uuid
           AND leave_records.person_kind = 'student'
           AND (${plans.pupils})
           AND ${filter}
         ORDER BY leave_records.starts_on, leave_records.ends_on, students.first_name, leave_records.id
         LIMIT ${LEAVE_LIST_MAX}`,
  )
  const actions = await allowedActionsForMany(
    conn,
    context,
    'attendance',
    found.rows.map((row) => row.student_id),
  )
  return found.rows.map((row) => ({
    ...common(row, recordActions(actions.get(row.student_id), PUPIL_KEYS, row.cancelled_at !== null)),
    student: pupilRef({
      id: row.student_id,
      name: [row.first_name, row.last_name].filter((part) => part !== null && part !== '').join(' ').slice(0, 160),
      admissionNumber: row.admission_number,
      rollNumber: row.roll_number === null ? null : Number(row.roll_number),
    }),
    ...(row.section_id === null || row.section_name === null
      ? {}
      : { section: { id: row.section_id, name: row.section_name } }),
    ...(row.grade_id === null || row.grade_name === null ? {} : { grade: { id: row.grade_id, name: row.grade_name } }),
  }))
}

async function readOnePupilLeave(
  conn: AttendanceConnection,
  context: RequestContext,
  id: string,
): Promise<StudentLeaveRecord> {
  const [record] = await readPupilLeave(conn, context, sql`leave_records.id = ${id}::uuid`)
  if (!record) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return record
}

// ---------------------------------------------------------------------------
// Staff.

const STAFF_KEYS = ['staff_attendance.read', 'staff_attendance.manage'] as const satisfies readonly [
  PermissionKey,
  PermissionKey,
]

interface StaffLeaveRow extends LeaveRow {
  staff_id: string
  employee_code: string
  first_name: string
  last_name: string | null
  designation: string | null
}

/** Staff leave through the caller's own plan over the register's people. */
async function readStaffLeave(
  conn: AttendanceConnection,
  context: RequestContext,
  filter: SQL,
): Promise<StaffLeaveRecord[]> {
  const plans = await staffAttendancePlans(conn, context)
  const recorder = await recorderName(conn, context)
  const found = await conn.db.execute<StaffLeaveRow>(
    sql`SELECT ${LEAVE_COLUMNS}, ${recorder} AS recorded_by,
               staff.id AS staff_id, staff.employee_code, staff.first_name, staff.last_name, staff.designation
          FROM leave_records
          JOIN staff ON staff.school_id = leave_records.school_id AND staff.id = leave_records.staff_id
         WHERE leave_records.school_id = ${context.schoolId}::uuid
           AND leave_records.person_kind = 'staff'
           AND (${plans.people})
           AND ${filter}
         ORDER BY leave_records.starts_on, leave_records.ends_on, staff.employee_code, leave_records.id
         LIMIT ${LEAVE_LIST_MAX}`,
  )
  const actions = await allowedActionsForMany(
    conn,
    context,
    'staff_attendance',
    found.rows.map((row) => row.staff_id),
  )
  return found.rows.map((row) => ({
    ...common(row, recordActions(actions.get(row.staff_id), STAFF_KEYS, row.cancelled_at !== null)),
    staff: {
      id: row.staff_id,
      name: [row.first_name, row.last_name].filter((part) => part !== null && part !== '').join(' ').slice(0, 160),
      employeeCode: row.employee_code,
      ...(row.designation === null || row.designation === '' ? {} : { designation: row.designation.slice(0, 160) }),
    },
  }))
}

async function readOneStaffLeave(
  conn: AttendanceConnection,
  context: RequestContext,
  id: string,
): Promise<StaffLeaveRecord> {
  const [record] = await readStaffLeave(conn, context, sql`leave_records.id = ${id}::uuid`)
  if (!record) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return record
}

/** A denial on a named staff member answers like a record that is not there. */
async function decideStaffAttendance(
  conn: AttendanceConnection,
  context: RequestContext,
  staffId: string,
): Promise<void> {
  const decision = await decideResource(conn, context, 'staff_attendance.manage', 'staff_attendance', staffId)
  if (!decision.allowed) {
    throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
  }
}

// ---------------------------------------------------------------------------
// The routes.

export function registerLeaveRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/attendance/leave',
    permission: 'attendance.read',
    query: LeaveListRequest,
    response: StudentLeaveListResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const today = await schoolToday(conn, context.schoolId)
        const person = query.personId === undefined ? sql`TRUE` : sql`leave_records.student_id = ${query.personId}::uuid`
        const items = await readPupilLeave(conn, context, sql`${listFilter(query, today)} AND ${person}`)
        return { items, allowedActions: await listActions(conn, context, PUPIL_KEYS) }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/attendance/leave',
    permission: 'attendance.manage',
    body: StudentLeaveCreateRequest,
    response: StudentLeaveRecord,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideAttendance(conn, context, 'attendance.manage', body.studentId)
        // The pupil face of the decision also answers for a section id, so the
        // record is looked for as a pupil of this school before anything else.
        const pupil = await conn.client.query<{ status: string }>(
          'SELECT status FROM students WHERE school_id = $1 AND id = $2',
          [context.schoolId, body.studentId],
        )
        assertActive(pupil.rows[0]?.status, ['active'])
        await assertNoOverlap(
          conn,
          context.schoolId,
          { column: 'student_id', id: body.studentId },
          body.startsOn,
          body.endsOn,
        )
        const id = await insertLeave(conn, context, {
          kind: 'student',
          personId: body.studentId,
          startsOn: body.startsOn,
          endsOn: body.endsOn,
          reason: body.reason,
        })
        await writeAudit(conn, context, {
          action: 'attendance.manage',
          targetType: 'leave_record',
          targetId: id,
          summary: 'Recorded leave for a pupil.',
          safeChanges: {
            personKind: 'student',
            studentId: body.studentId,
            startsOn: body.startsOn,
            endsOn: body.endsOn,
            days: dayCount(body.startsOn, body.endsOn),
            reasonGiven: body.reason !== undefined,
          },
        })
        return readOnePupilLeave(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/attendance/leave/:leaveId/cancel',
    permission: 'attendance.manage',
    body: LeaveCancelRequest,
    response: StudentLeaveRecord,
    handler: async ({ context, body, param }) => {
      const leaveId = assertUuidParam(param('leaveId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const stored = await readStored(conn, context.schoolId, 'student', leaveId)
        await decideAttendance(conn, context, 'attendance.manage', stored.person_id)
        if (stored.cancelled) throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_already_cancelled')
        await bumpVersion(conn, 'leave_records', {
          schoolId: context.schoolId,
          id: leaveId,
          expectedVersion: body.expectedVersion,
          set: { cancelled_at: context.now, cancelled_by_membership_id: context.membershipId },
        })
        await writeAudit(conn, context, {
          action: 'attendance.manage',
          targetType: 'leave_record',
          targetId: leaveId,
          summary: 'Cancelled leave for a pupil.',
          safeChanges: {
            personKind: 'student',
            studentId: stored.person_id,
            startsOn: stored.starts_on,
            endsOn: stored.ends_on,
          },
          // What somebody typed lives in the note, which can be redacted.
          ...(body.reason === undefined ? {} : { note: body.reason }),
        })
        return readOnePupilLeave(conn, context, leaveId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/staff-attendance/leave',
    permission: 'staff_attendance.read',
    query: LeaveListRequest,
    response: StaffLeaveListResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const today = await schoolToday(conn, context.schoolId)
        const person = query.personId === undefined ? sql`TRUE` : sql`leave_records.staff_id = ${query.personId}::uuid`
        const items = await readStaffLeave(conn, context, sql`${listFilter(query, today)} AND ${person}`)
        return { items, allowedActions: await listActions(conn, context, STAFF_KEYS) }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/staff-attendance/leave',
    permission: 'staff_attendance.manage',
    body: StaffLeaveCreateRequest,
    response: StaffLeaveRecord,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideStaffAttendance(conn, context, body.staffId)
        // A staff attendance id may also be a mark's, so the person is looked
        // for as a staff record of this school before anything else.
        const person = await conn.client.query<{ status: string }>(
          'SELECT status FROM staff WHERE school_id = $1 AND id = $2',
          [context.schoolId, body.staffId],
        )
        // Somebody already on leave in their record is still here.
        assertActive(person.rows[0]?.status, ['active', 'on_leave'])
        await assertNoOverlap(
          conn,
          context.schoolId,
          { column: 'staff_id', id: body.staffId },
          body.startsOn,
          body.endsOn,
        )
        const id = await insertLeave(conn, context, {
          kind: 'staff',
          personId: body.staffId,
          startsOn: body.startsOn,
          endsOn: body.endsOn,
          reason: body.reason,
        })
        await writeAudit(conn, context, {
          action: 'staff_attendance.manage',
          targetType: 'leave_record',
          targetId: id,
          summary: 'Recorded leave for a staff member.',
          safeChanges: {
            personKind: 'staff',
            staffId: body.staffId,
            startsOn: body.startsOn,
            endsOn: body.endsOn,
            days: dayCount(body.startsOn, body.endsOn),
            reasonGiven: body.reason !== undefined,
          },
        })
        return readOneStaffLeave(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/staff-attendance/leave/:leaveId/cancel',
    permission: 'staff_attendance.manage',
    body: LeaveCancelRequest,
    response: StaffLeaveRecord,
    handler: async ({ context, body, param }) => {
      const leaveId = assertUuidParam(param('leaveId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const stored = await readStored(conn, context.schoolId, 'staff', leaveId)
        await decideStaffAttendance(conn, context, stored.person_id)
        if (stored.cancelled) throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_already_cancelled')
        await bumpVersion(conn, 'leave_records', {
          schoolId: context.schoolId,
          id: leaveId,
          expectedVersion: body.expectedVersion,
          set: { cancelled_at: context.now, cancelled_by_membership_id: context.membershipId },
        })
        await writeAudit(conn, context, {
          action: 'staff_attendance.manage',
          targetType: 'leave_record',
          targetId: leaveId,
          summary: 'Cancelled leave for a staff member.',
          safeChanges: {
            personKind: 'staff',
            staffId: stored.person_id,
            startsOn: stored.starts_on,
            endsOn: stored.ends_on,
          },
          ...(body.reason === undefined ? {} : { note: body.reason }),
        })
        return readOneStaffLeave(conn, context, leaveId)
      })
    },
  })
}
