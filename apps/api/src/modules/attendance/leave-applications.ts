import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import {
  AuthorizationError,
  leaveApplicationScopedTable,
  planPredicate,
  scopedTableFor,
  type LeaveApplicationTableKind,
} from '@erp/authz'
import {
  LEAVE_APPLY_DAYS_BACK,
  LEAVE_LIST_MAX,
  LeaveApplicationDecideRequest,
  LeaveApplicationListRequest,
  LeaveApplicationWithdrawRequest,
  LeaveType,
  type LeaveApplicationStatus,
  type PermissionKey,
  StaffLeaveApplication,
  StaffLeaveApplicationList,
  StaffLeaveApplyRequest,
  StudentLeaveApplication,
  StudentLeaveApplicationList,
  StudentLeaveApplyRequest,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  allowedActionsForMany,
  ApiFailure,
  assertUuidParam,
  assertVersion,
  bumpVersion,
  decideResource,
  lockSchool,
  protectedRoute,
  readPlan,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { kickMessagePump } from '../communication/pump.ts'
import { schoolToday, type AttendanceConnection } from './figures.ts'
import { pupilRef, sectionVisibility } from './reads.ts'
import { assertActive, assertNoOverlap, dayCount, insertLeave, predicateOrFalse } from './leave.ts'

/**
 * Leave applications (migration 0029). A parent applies for their own child
 * and a staff member for themselves; somebody decides. A pupil's application
 * is decided by the class teacher of the pupil's current section or by the
 * office, whoever acts first; a staff member's by the office alone. Approving
 * writes the leave record (leave.ts) in the same transaction and links it, so
 * the register, the figures and the dashboard work from leave records alone.
 * An application is never removed: it is pending, then approved, refused, or
 * withdrawn by the person who applied.
 *
 * Every read and decision goes through the `leave_application` resource type
 * of the authorizer, whose three faces are the application, the pupil a
 * parent applies for and the staff member who applies for themselves. The
 * applicant hears the decision through the automatic messages
 * (`leave_decision_pupil`, `leave_decision_staff`, communication/automatic.ts).
 */

type PersonKind = 'student' | 'staff'

const ISO_TIMESTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MSOF:00'`

const READ: PermissionKey = 'leave_applications.read'
const APPLY: PermissionKey = 'leave_applications.apply'
const DECIDE: PermissionKey = 'leave_applications.decide'

function table(kind: 'staff' | 'enrollment' | 'student') {
  const scoped = scopedTableFor(kind)
  if (!scoped) throw new Error(`the authorizer has no scoped table for ${kind}`)
  return scoped
}

/** An ISO date moved by whole days, without touching the local clock. */
function addDays(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + days)
  return moved.toISOString().slice(0, 10)
}

/** Which applications a list asks for. */
function listFilter(query: LeaveApplicationListRequest, context: RequestContext): SQL {
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    throw new ApiFailure('INVALID_REQUEST')
  }
  const parts: SQL[] = [sql`TRUE`]
  if (query.status !== undefined) parts.push(sql`leave_applications.status = ${query.status}`)
  if (query.mine === 'true') {
    parts.push(sql`leave_applications.applied_by_membership_id = ${context.membershipId}::uuid`)
  }
  if (query.from !== undefined) parts.push(sql`leave_applications.ends_on >= ${query.from}::date`)
  if (query.to !== undefined) parts.push(sql`leave_applications.starts_on <= ${query.to}::date`)
  return sql.join(parts, sql` AND `)
}

/** Waiting ones first, the soonest at the top; then the rest, the newest first. */
const ORDER = sql`(leave_applications.status = 'pending') DESC,
    CASE WHEN leave_applications.status = 'pending' THEN leave_applications.starts_on END ASC,
    leave_applications.starts_on DESC, leave_applications.id`

/**
 * The staff name of a member, only when their staff record is one the caller
 * may read in the directory, exactly as a leave record names its recorder.
 */
async function staffNameOf(conn: AttendanceConnection, context: RequestContext, membership: SQL): Promise<SQL> {
  const directory = await predicateOrFalse(async () =>
    planPredicate(await readPlan(conn, context, 'staff.read_directory', 'staff'), table('staff')),
  )
  return sql`(SELECT staff.first_name || COALESCE(' ' || NULLIF(staff.last_name, ''), '')
      FROM membership_staff_links msl
      JOIN staff ON staff.school_id = msl.school_id AND staff.id = msl.staff_id
     WHERE msl.school_id = leave_applications.school_id
       AND msl.membership_id = ${membership}
       AND (${directory})
     LIMIT 1)`
}

interface ApplicationRow extends Record<string, unknown> {
  id: string
  version: number
  starts_on: string
  ends_on: string
  reason: string
  status: LeaveApplicationStatus
  leave_type: string | null
  applied_at: string
  applied_by: string | null
  mine: boolean
  decided_at: string | null
  decided_by: string | null
  decision_note: string | null
  leave_record_id: string | null
}

const APPLICATION_COLUMNS = sql`leave_applications.id, leave_applications.version,
    to_char(leave_applications.starts_on, 'YYYY-MM-DD') AS starts_on,
    to_char(leave_applications.ends_on, 'YYYY-MM-DD') AS ends_on,
    leave_applications.reason, leave_applications.status, leave_applications.leave_type,
    to_char(leave_applications.created_at, ${sql.raw(ISO_TIMESTAMP)}) AS applied_at,
    to_char(leave_applications.decided_at, ${sql.raw(ISO_TIMESTAMP)}) AS decided_at,
    leave_applications.decision_note, leave_applications.leave_record_id`

function trimmedName(value: string | null): string {
  return value?.trim().slice(0, 160) ?? ''
}

/**
 * The actions on one application: the read key; the decide key while it
 * waits, the caller may decide it and did not make it (nobody decides their
 * own application); the apply key while it waits, the caller made it and may
 * still apply for that person (which is withdrawing).
 */
function itemActions(decided: readonly PermissionKey[] | undefined, row: ApplicationRow): PermissionKey[] {
  const pending = row.status === 'pending'
  return (decided ?? []).filter(
    (key) => key === READ || (pending && key === DECIDE && !row.mine) || (pending && key === APPLY && row.mine),
  )
}

/** What every application says, whoever it is about. */
function common(row: ApplicationRow, allowedActions: readonly PermissionKey[]) {
  const appliedBy = trimmedName(row.applied_by)
  const decidedBy = trimmedName(row.decided_by)
  const decided = row.status === 'approved' || row.status === 'refused'
  return {
    id: row.id,
    version: Number(row.version),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    days: dayCount(row.starts_on, row.ends_on),
    reason: row.reason,
    status: row.status,
    appliedAt: row.applied_at,
    ...(appliedBy === '' ? {} : { appliedBy }),
    mine: row.mine === true,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(decided && decidedBy !== '' ? { decidedBy } : {}),
    ...(row.decision_note === null ? {} : { decisionNote: row.decision_note }),
    ...(row.leave_record_id === null ? {} : { leaveRecordId: row.leave_record_id }),
    allowedActions: [...allowedActions],
  }
}

/** The caller's own read plan over applications. */
async function applicationScope(conn: AttendanceConnection, context: RequestContext): Promise<SQL> {
  return planPredicate(await readPlan(conn, context, READ, 'leave_application'), leaveApplicationScopedTable('application'))
}

// ---------------------------------------------------------------------------
// Pupils.

interface PupilApplicationRow extends ApplicationRow {
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
 * Pupil applications through the caller's own plan. The class is the
 * enrolment on the first day of the leave, named only when the caller may read
 * that enrolment and that section, exactly as a leave record names it. Who
 * applied is a staff name through the directory, or the guardian's name when
 * the caller may read the pupil's guardian contact.
 */
async function readPupilApplications(
  conn: AttendanceConnection,
  context: RequestContext,
  filter: SQL,
): Promise<StudentLeaveApplication[]> {
  const scope = await applicationScope(conn, context)
  const sections = await sectionVisibility(conn, context)
  const enrolments = await predicateOrFalse(async () =>
    planPredicate(await readPlan(conn, context, 'students.read_enrollments', 'enrollment'), table('enrollment')),
  )
  const guardianContact = await predicateOrFalse(async () =>
    planPredicate(await readPlan(conn, context, 'students.read_guardian_contact', 'student'), table('student')),
  )
  const staffApplicant = await staffNameOf(conn, context, sql`leave_applications.applied_by_membership_id`)
  const decider = await staffNameOf(conn, context, sql`leave_applications.decided_by_membership_id`)
  const found = await conn.db.execute<PupilApplicationRow>(
    sql`SELECT ${APPLICATION_COLUMNS},
               (leave_applications.applied_by_membership_id = ${context.membershipId}::uuid) AS mine,
               COALESCE(${staffApplicant}, (
                 SELECT g.first_name || COALESCE(' ' || NULLIF(g.last_name, ''), '')
                   FROM membership_guardian_links mgl
                   JOIN guardians g ON g.school_id = mgl.school_id AND g.id = mgl.guardian_id
                  WHERE mgl.school_id = leave_applications.school_id
                    AND mgl.membership_id = leave_applications.applied_by_membership_id
                    AND g.anonymised_at IS NULL
                    AND (${guardianContact})
                  LIMIT 1)) AS applied_by,
               ${decider} AS decided_by,
               students.id AS student_id, students.first_name, students.last_name, students.admission_number,
               klass.roll_number, klass.section_id, klass.section_name, klass.grade_id, klass.grade_name
          FROM leave_applications
          JOIN students ON students.school_id = leave_applications.school_id
                       AND students.id = leave_applications.student_id
          LEFT JOIN LATERAL (
            SELECT enrollments.roll_number, sections.id AS section_id, sections.name AS section_name,
                   grades.id AS grade_id, grades.name AS grade_name
              FROM enrollments
              JOIN sections ON sections.school_id = enrollments.school_id AND sections.id = enrollments.section_id
              JOIN grades ON grades.school_id = sections.school_id AND grades.id = sections.grade_id
             WHERE enrollments.school_id = leave_applications.school_id
               AND enrollments.student_id = leave_applications.student_id
               AND enrollments.joined_on <= leave_applications.starts_on
               AND (enrollments.left_on IS NULL OR enrollments.left_on >= leave_applications.starts_on)
               AND (${enrolments}) AND (${sections})
             ORDER BY enrollments.joined_on DESC, enrollments.id
             LIMIT 1
          ) klass ON TRUE
         WHERE leave_applications.school_id = ${context.schoolId}::uuid
           AND leave_applications.person_kind = 'student'
           AND (${scope})
           AND ${filter}
         ORDER BY ${ORDER}
         LIMIT ${LEAVE_LIST_MAX}`,
  )
  const actions = await allowedActionsForMany(
    conn,
    context,
    'leave_application',
    found.rows.map((row) => row.id),
  )
  return found.rows.map((row) => ({
    ...common(row, itemActions(actions.get(row.id), row)),
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

async function readOnePupilApplication(
  conn: AttendanceConnection,
  context: RequestContext,
  id: string,
): Promise<StudentLeaveApplication> {
  const [application] = await readPupilApplications(conn, context, sql`leave_applications.id = ${id}::uuid`)
  if (!application) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return application
}

// ---------------------------------------------------------------------------
// Staff.

interface StaffApplicationRow extends ApplicationRow {
  staff_id: string
  employee_code: string
  first_name: string
  last_name: string | null
  designation: string | null
}

async function readStaffApplications(
  conn: AttendanceConnection,
  context: RequestContext,
  filter: SQL,
): Promise<StaffLeaveApplication[]> {
  const scope = await applicationScope(conn, context)
  const applicant = await staffNameOf(conn, context, sql`leave_applications.applied_by_membership_id`)
  const decider = await staffNameOf(conn, context, sql`leave_applications.decided_by_membership_id`)
  const found = await conn.db.execute<StaffApplicationRow>(
    sql`SELECT ${APPLICATION_COLUMNS},
               (leave_applications.applied_by_membership_id = ${context.membershipId}::uuid) AS mine,
               ${applicant} AS applied_by, ${decider} AS decided_by,
               staff.id AS staff_id, staff.employee_code, staff.first_name, staff.last_name, staff.designation
          FROM leave_applications
          JOIN staff ON staff.school_id = leave_applications.school_id AND staff.id = leave_applications.staff_id
         WHERE leave_applications.school_id = ${context.schoolId}::uuid
           AND leave_applications.person_kind = 'staff'
           AND (${scope})
           AND ${filter}
         ORDER BY ${ORDER}
         LIMIT ${LEAVE_LIST_MAX}`,
  )
  const actions = await allowedActionsForMany(
    conn,
    context,
    'leave_application',
    found.rows.map((row) => row.id),
  )
  return found.rows.map((row) => ({
    ...common(row, itemActions(actions.get(row.id), row)),
    staff: {
      id: row.staff_id,
      name: [row.first_name, row.last_name].filter((part) => part !== null && part !== '').join(' ').slice(0, 160),
      employeeCode: row.employee_code,
      ...(row.designation === null || row.designation === '' ? {} : { designation: row.designation.slice(0, 160) }),
    },
    leaveType: LeaveType.parse(row.leave_type),
  }))
}

async function readOneStaffApplication(
  conn: AttendanceConnection,
  context: RequestContext,
  id: string,
): Promise<StaffLeaveApplication> {
  const [application] = await readStaffApplications(conn, context, sql`leave_applications.id = ${id}::uuid`)
  if (!application) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return application
}

// ---------------------------------------------------------------------------
// Decisions and checks.

/**
 * A denial on a named record answers like a record that is not there, unless
 * the caller may read the application, in which case it is a plain refusal.
 */
async function decideOn(
  conn: AttendanceConnection,
  context: RequestContext,
  permission: PermissionKey,
  id: string,
): Promise<void> {
  const decision = await decideResource(conn, context, permission, 'leave_application', id)
  if (decision.allowed) return
  if (decision.code === 'MFA_REQUIRED') throw new ApiFailure('MFA_REQUIRED')
  const readable = permission !== READ && (await decideResource(conn, context, READ, 'leave_application', id)).allowed
  throw new ApiFailure(readable ? 'ACCESS_DENIED' : 'RESOURCE_NOT_FOUND')
}

/**
 * Whether the caller may use a key on some row of one face: a pupil or a
 * staff member they could apply for or decide about. A plan the caller does
 * not hold at all is simply no.
 */
async function anyOnFace(
  conn: AttendanceConnection,
  context: RequestContext,
  permission: PermissionKey,
  face: Exclude<LeaveApplicationTableKind, 'application'>,
): Promise<boolean> {
  let predicate: SQL
  try {
    predicate = planPredicate(
      await readPlan(conn, context, permission, 'leave_application'),
      leaveApplicationScopedTable(face),
    )
  } catch (error) {
    if (error instanceof AuthorizationError) return false
    throw error
  }
  const found = await conn.db.execute(
    face === 'pupil'
      ? sql`SELECT 1 FROM students WHERE students.school_id = ${context.schoolId}::uuid
              AND students.status = 'active' AND (${predicate}) LIMIT 1`
      : sql`SELECT 1 FROM staff WHERE staff.school_id = ${context.schoolId}::uuid
              AND staff.status IN ('active', 'on_leave') AND (${predicate}) LIMIT 1`,
  )
  return found.rows.length > 0
}

/** The list-level actions: read, apply for somebody on this face, decide about somebody on it. */
async function listActions(
  conn: AttendanceConnection,
  context: RequestContext,
  face: 'pupil' | 'person',
): Promise<PermissionKey[]> {
  const allowed: PermissionKey[] = [READ]
  if (await anyOnFace(conn, context, APPLY, face)) allowed.push(APPLY)
  if (await anyOnFace(conn, context, DECIDE, face)) allowed.push(DECIDE)
  return allowed
}

/** An application may start at most LEAVE_APPLY_DAYS_BACK days before today in the school's timezone. */
async function assertApplyWindow(conn: AttendanceConnection, schoolId: string, startsOn: string): Promise<void> {
  const today = await schoolToday(conn, schoolId)
  if (startsOn < addDays(today, -LEAVE_APPLY_DAYS_BACK)) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_application_too_far_back')
  }
}

/**
 * No two waiting applications of one person share a day, and none shares a
 * day with an active leave record. Checked under the school lock.
 */
async function assertNoClash(
  conn: AttendanceConnection,
  schoolId: string,
  person: { readonly column: 'student_id' | 'staff_id'; readonly id: string },
  startsOn: string,
  endsOn: string,
): Promise<void> {
  const pending = await conn.client.query(
    `SELECT 1 FROM leave_applications
      WHERE school_id = $1 AND ${person.column} = $2 AND status = 'pending'
        AND starts_on <= $4::date AND ends_on >= $3::date
      LIMIT 1`,
    [schoolId, person.id, startsOn, endsOn],
  )
  if (pending.rows.length > 0) throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_overlaps')
  await assertNoOverlap(conn, schoolId, person, startsOn, endsOn)
}

async function insertApplication(
  conn: AttendanceConnection,
  context: RequestContext,
  input: {
    readonly kind: PersonKind
    readonly personId: string
    readonly leaveType: string | null
    readonly startsOn: string
    readonly endsOn: string
    readonly reason: string
  },
): Promise<string> {
  const inserted = await conn.client.query<{ id: string }>(
    `INSERT INTO leave_applications (school_id, person_kind, student_id, staff_id, leave_type, starts_on, ends_on,
                                     reason, applied_by_membership_id)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9)
     RETURNING id`,
    [
      context.schoolId,
      input.kind,
      input.kind === 'student' ? input.personId : null,
      input.kind === 'staff' ? input.personId : null,
      input.leaveType,
      input.startsOn,
      input.endsOn,
      input.reason,
      context.membershipId,
    ],
  )
  const id = inserted.rows[0]?.id
  if (!id) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return id
}

interface StoredApplication {
  readonly person_id: string
  readonly status: LeaveApplicationStatus
  readonly version: number
  readonly starts_on: string
  readonly ends_on: string
  readonly reason: string
  readonly applied_by_membership_id: string
}

async function readStored(
  conn: AttendanceConnection,
  schoolId: string,
  kind: PersonKind,
  id: string,
): Promise<StoredApplication> {
  const column = kind === 'student' ? 'student_id' : 'staff_id'
  const found = await conn.client.query<StoredApplication>(
    `SELECT ${column} AS person_id, status, version, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
            to_char(ends_on, 'YYYY-MM-DD') AS ends_on, reason, applied_by_membership_id
       FROM leave_applications WHERE school_id = $1 AND id = $2 AND person_kind = $3`,
    [schoolId, id, kind],
  )
  const row = found.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

/** Whether the person is still here: a pupil active, a staff member working or on leave. */
async function assertPersonActive(
  conn: AttendanceConnection,
  schoolId: string,
  kind: PersonKind,
  id: string,
): Promise<void> {
  const found = await conn.client.query<{ status: string }>(
    kind === 'student'
      ? 'SELECT status FROM students WHERE school_id = $1 AND id = $2'
      : 'SELECT status FROM staff WHERE school_id = $1 AND id = $2',
    [schoolId, id],
  )
  assertActive(found.rows[0]?.status, kind === 'student' ? ['active'] : ['active', 'on_leave'])
}

const LABEL: Readonly<Record<PersonKind, string>> = { student: 'a pupil', staff: 'a staff member' }

/**
 * Approve or refuse, under the school lock. Approving writes the leave record
 * in the same transaction, after checking again that no active record shares
 * a day, and links it; its creation rides on the one audit row of the
 * decision.
 */
async function decideApplication(
  conn: AttendanceConnection,
  context: RequestContext,
  kind: PersonKind,
  id: string,
  body: LeaveApplicationDecideRequest,
): Promise<void> {
  await lockSchool(conn, context.schoolId)
  const stored = await readStored(conn, context.schoolId, kind, id)
  await decideOn(conn, context, DECIDE, id)
  // Nobody decides their own application: an administrator's own leave, or a
  // class teacher's own child's, goes to somebody else.
  if (stored.applied_by_membership_id === context.membershipId) throw new ApiFailure('ACCESS_DENIED')
  if (stored.status !== 'pending') {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_application_not_pending')
  }
  assertVersion(body.expectedVersion, Number(stored.version))
  const personColumn = kind === 'student' ? 'student_id' : 'staff_id'
  let leaveRecordId: string | null = null
  if (body.decision === 'approve') {
    await assertPersonActive(conn, context.schoolId, kind, stored.person_id)
    await assertNoOverlap(
      conn,
      context.schoolId,
      { column: personColumn, id: stored.person_id },
      stored.starts_on,
      stored.ends_on,
    )
    leaveRecordId = await insertLeave(conn, context, {
      kind,
      personId: stored.person_id,
      startsOn: stored.starts_on,
      endsOn: stored.ends_on,
      reason: stored.reason,
    })
  }
  await bumpVersion(conn, 'leave_applications', {
    schoolId: context.schoolId,
    id,
    expectedVersion: body.expectedVersion,
    set: {
      status: body.decision === 'approve' ? 'approved' : 'refused',
      decided_by_membership_id: context.membershipId,
      decided_at: context.now,
      decision_note: body.note ?? null,
      leave_record_id: leaveRecordId,
    },
  })
  await writeAudit(conn, context, {
    action: DECIDE,
    targetType: 'leave_application',
    targetId: id,
    summary:
      body.decision === 'approve'
        ? `Approved a leave application for ${LABEL[kind]} and recorded the leave.`
        : `Refused a leave application for ${LABEL[kind]}.`,
    safeChanges: {
      decision: body.decision,
      personKind: kind,
      [kind === 'student' ? 'studentId' : 'staffId']: stored.person_id,
      startsOn: stored.starts_on,
      endsOn: stored.ends_on,
      days: dayCount(stored.starts_on, stored.ends_on),
      noteGiven: body.note !== undefined,
      ...(leaveRecordId === null ? {} : { leaveRecordId }),
    },
  })
}

/** Only the member who applied withdraws, only while it waits. */
async function withdrawApplication(
  conn: AttendanceConnection,
  context: RequestContext,
  kind: PersonKind,
  id: string,
  body: LeaveApplicationWithdrawRequest,
): Promise<void> {
  await lockSchool(conn, context.schoolId)
  const stored = await readStored(conn, context.schoolId, kind, id)
  await decideOn(conn, context, APPLY, id)
  if (stored.applied_by_membership_id !== context.membershipId) throw new ApiFailure('ACCESS_DENIED')
  if (stored.status !== 'pending') {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_application_not_pending')
  }
  await bumpVersion(conn, 'leave_applications', {
    schoolId: context.schoolId,
    id,
    expectedVersion: body.expectedVersion,
    set: { status: 'withdrawn', decided_at: context.now },
  })
  await writeAudit(conn, context, {
    action: APPLY,
    targetType: 'leave_application',
    targetId: id,
    summary: `Withdrew a leave application for ${LABEL[kind]}.`,
    safeChanges: {
      withdrawn: true,
      personKind: kind,
      [kind === 'student' ? 'studentId' : 'staffId']: stored.person_id,
      startsOn: stored.starts_on,
      endsOn: stored.ends_on,
    },
  })
}

// ---------------------------------------------------------------------------
// The routes.

export function registerLeaveApplicationRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/leave-applications/pupils',
    permission: READ,
    query: LeaveApplicationListRequest,
    response: StudentLeaveApplicationList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const items = await readPupilApplications(conn, context, listFilter(query, context))
        return { items, allowedActions: await listActions(conn, context, 'pupil') }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/leave-applications/pupils',
    permission: APPLY,
    body: StudentLeaveApplyRequest,
    response: StudentLeaveApplication,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideOn(conn, context, APPLY, body.studentId)
        // The pupil face also answers for an application's own id, so the
        // pupil is looked for as a pupil of this school before anything else.
        await assertPersonActive(conn, context.schoolId, 'student', body.studentId)
        await assertApplyWindow(conn, context.schoolId, body.startsOn)
        await assertNoClash(conn, context.schoolId, { column: 'student_id', id: body.studentId }, body.startsOn, body.endsOn)
        const id = await insertApplication(conn, context, {
          kind: 'student',
          personId: body.studentId,
          leaveType: null,
          startsOn: body.startsOn,
          endsOn: body.endsOn,
          reason: body.reason,
        })
        await writeAudit(conn, context, {
          action: APPLY,
          targetType: 'leave_application',
          targetId: id,
          summary: 'Applied for leave for a pupil.',
          safeChanges: {
            personKind: 'student',
            studentId: body.studentId,
            startsOn: body.startsOn,
            endsOn: body.endsOn,
            days: dayCount(body.startsOn, body.endsOn),
          },
        })
        return readOnePupilApplication(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/leave-applications/pupils/:applicationId/decide',
    permission: DECIDE,
    body: LeaveApplicationDecideRequest,
    response: StudentLeaveApplication,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('applicationId'))
      const decided = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideApplication(conn, context, 'student', id, body)
        return readOnePupilApplication(conn, context, id)
      })
      // After the commit, so the pump finds the decision and tells the applicant.
      kickMessagePump(deps, context.schoolId)
      return decided
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/leave-applications/pupils/:applicationId/withdraw',
    permission: APPLY,
    body: LeaveApplicationWithdrawRequest,
    response: StudentLeaveApplication,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('applicationId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await withdrawApplication(conn, context, 'student', id, body)
        return readOnePupilApplication(conn, context, id)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/leave-applications/staff',
    permission: READ,
    query: LeaveApplicationListRequest,
    response: StaffLeaveApplicationList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const items = await readStaffApplications(conn, context, listFilter(query, context))
        return { items, allowedActions: await listActions(conn, context, 'person') }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/leave-applications/staff',
    permission: APPLY,
    body: StaffLeaveApplyRequest,
    response: StaffLeaveApplication,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        // A staff member applies for themselves: the staff record is the one
        // the caller's membership is linked to, never one the request names.
        const link = await conn.client.query<{ staff_id: string }>(
          'SELECT staff_id FROM membership_staff_links WHERE school_id = $1 AND membership_id = $2',
          [context.schoolId, context.membershipId],
        )
        const staffId = link.rows[0]?.staff_id
        if (staffId === undefined) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'leave_application_no_staff_record')
        }
        await decideOn(conn, context, APPLY, staffId)
        await assertPersonActive(conn, context.schoolId, 'staff', staffId)
        await assertApplyWindow(conn, context.schoolId, body.startsOn)
        await assertNoClash(conn, context.schoolId, { column: 'staff_id', id: staffId }, body.startsOn, body.endsOn)
        const id = await insertApplication(conn, context, {
          kind: 'staff',
          personId: staffId,
          leaveType: body.leaveType,
          startsOn: body.startsOn,
          endsOn: body.endsOn,
          reason: body.reason,
        })
        await writeAudit(conn, context, {
          action: APPLY,
          targetType: 'leave_application',
          targetId: id,
          summary: 'Applied for leave as a staff member.',
          safeChanges: {
            personKind: 'staff',
            staffId,
            leaveType: body.leaveType,
            startsOn: body.startsOn,
            endsOn: body.endsOn,
            days: dayCount(body.startsOn, body.endsOn),
          },
        })
        return readOneStaffApplication(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/leave-applications/staff/:applicationId/decide',
    permission: DECIDE,
    body: LeaveApplicationDecideRequest,
    response: StaffLeaveApplication,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('applicationId'))
      const decided = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideApplication(conn, context, 'staff', id, body)
        return readOneStaffApplication(conn, context, id)
      })
      // After the commit, so the pump finds the decision and tells the applicant.
      kickMessagePump(deps, context.schoolId)
      return decided
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/leave-applications/staff/:applicationId/withdraw',
    permission: APPLY,
    body: LeaveApplicationWithdrawRequest,
    response: StaffLeaveApplication,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('applicationId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await withdrawApplication(conn, context, 'staff', id, body)
        return readOneStaffApplication(conn, context, id)
      })
    },
  })
}
