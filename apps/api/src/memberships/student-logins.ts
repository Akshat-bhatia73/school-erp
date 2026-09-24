import type { PoolClient } from 'pg'
import {
  commitAccessChange,
  lockMembershipForAccessChange,
  type AuthzConnection,
} from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import {
  STUDENT_LOGIN_LEVELS,
  StudentLoginView,
  type IssueStudentLoginsResult,
  type StudentLoginBlocker,
  type StudentLoginState,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { generateStudentPassword } from '../auth/student-sign-in.ts'
import { ApiFailure } from '../http/errors.ts'
import {
  endAllSessions,
  provisionStudentIdentity,
  removeUnusedStudentIdentity,
  replaceStudentPassword,
} from '../identity/provision.ts'
import { maskDestination } from '../invitations/tokens.ts'
import { lockSchool, recordAuditEvent } from './audit.ts'
import { decideAction } from './authorize.ts'
import type { AccessDependencies } from './routes.ts'

/**
 * A pupil's own login (Task 23): the one place it is read, issued, reset,
 * switched off, switched on and ended.
 *
 * The login is a membership of kind 'student' holding the student role,
 * linked to the pupil through membership_student_links. Its state is the
 * membership's status. The password is generated here, handed to the identity
 * provider and to the text message, and nowhere else: never a table, a log,
 * an audit row or a response.
 */

type View = ReturnType<typeof StudentLoginView.parse>

/** What started an issue. Recorded in the audit row. */
export type StudentLoginTrigger = 'office' | 'admission' | 'import' | 'promotion' | 'bulk'

const PERMISSION = 'students.manage_login' as const

/** The most pupils one call to issue every missing login serves. */
export const BULK_ISSUE_LIMIT = 500

interface PupilRow {
  id: string
  first_name: string
  last_name: string | null
  admission_number: string
  login_code: string
  on_roll: boolean
  senior: boolean
  guardian_phone: string | null
  membership_id: string | null
  membership_status: 'active' | 'suspended' | 'removed' | null
  membership_version: number | null
  membership_user_id: string | null
  issued_at: Date | null
}

/**
 * Everything that decides a pupil's login in one read: whether they are on
 * the roll, whether an open enrolment of a year that is not closed puts them
 * in Class 9 to 12, their primary guardian's phone and their membership.
 */
const PUPIL_SELECT = `
  SELECT s.id, s.first_name, s.last_name, s.admission_number, school.login_code,
         (s.status = 'active' AND s.anonymised_at IS NULL) AS on_roll,
         EXISTS (
           SELECT 1 FROM enrollments e
             JOIN academic_years y ON y.school_id = e.school_id AND y.id = e.academic_year_id
             JOIN sections sec ON sec.school_id = e.school_id AND sec.id = e.section_id
             JOIN grades g ON g.school_id = sec.school_id AND g.id = sec.grade_id
            WHERE e.school_id = s.school_id AND e.student_id = s.id AND e.left_on IS NULL
              AND y.status <> 'closed' AND g.level BETWEEN $3 AND $4
         ) AS senior,
         (SELECT NULLIF(btrim(g.phone), '') FROM student_guardians sg
            JOIN guardians g ON g.school_id = sg.school_id AND g.id = sg.guardian_id
           WHERE sg.school_id = s.school_id AND sg.student_id = s.id AND sg.is_primary
             AND g.anonymised_at IS NULL
           LIMIT 1) AS guardian_phone,
         m.id AS membership_id, m.status::text AS membership_status,
         m.version AS membership_version, m.user_id AS membership_user_id,
         m.created_at AS issued_at
    FROM students s
    JOIN schools school ON school.id = s.school_id
    LEFT JOIN membership_student_links link
      ON link.school_id = s.school_id AND link.student_id = s.id
    LEFT JOIN school_memberships m
      ON m.school_id = link.school_id AND m.id = link.membership_id`

async function loadPupils(
  client: PoolClient,
  schoolId: string,
  studentIds: readonly string[],
): Promise<PupilRow[]> {
  if (studentIds.length === 0) return []
  const result = await client.query<PupilRow>(
    `${PUPIL_SELECT}
      WHERE s.school_id = $1 AND s.id = ANY($2::uuid[])`,
    [schoolId, [...studentIds], STUDENT_LOGIN_LEVELS.from, STUDENT_LOGIN_LEVELS.to],
  )
  return result.rows
}

async function loadPupil(client: PoolClient, schoolId: string, studentId: string): Promise<PupilRow> {
  const row = (await loadPupils(client, schoolId, [studentId]))[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

function stateOf(row: PupilRow): StudentLoginState {
  switch (row.membership_status) {
    case 'active':
      return 'active'
    case 'suspended':
      return 'switched_off'
    case 'removed':
      return 'ended'
    default:
      return 'none'
  }
}

/** Why the pupil could not be given a login (or have it back) right now. */
function blockerOf(row: PupilRow, state: StudentLoginState): StudentLoginBlocker | undefined {
  if (state === 'active') return undefined
  if (!row.on_roll) return 'not_on_roll'
  if (!row.senior) return 'not_senior'
  // Switching a login back on sends nothing, so it needs no phone.
  if (state !== 'switched_off' && row.guardian_phone === null) return 'no_guardian_phone'
  return undefined
}

function pupilName(row: PupilRow): string {
  const last = row.last_name?.trim()
  return last ? `${row.first_name} ${last}` : row.first_name
}

function reasonFailure(
  reason:
    | 'student_login_not_eligible'
    | 'student_login_no_guardian_phone'
    | 'student_login_exists'
    | 'student_login_missing',
): ApiFailure {
  return new ApiFailure('INVALID_REQUEST', undefined, reason)
}

/** The pupil decided as a record, so another school's pupil is simply not found. */
async function authorizePupil(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
): Promise<void> {
  const decision = await decideAction(conn, context, PERMISSION, studentId, false)
  if (!decision.allowed) throw new ApiFailure(decision.code)
}

/** A pupil the office may issue a login to now, or the reason why not. */
function assertIssuable(row: PupilRow): void {
  const state = stateOf(row)
  if (state === 'active' || state === 'switched_off') {
    throw reasonFailure('student_login_exists')
  }
  const blocker = blockerOf(row, state)
  if (blocker === 'no_guardian_phone') throw reasonFailure('student_login_no_guardian_phone')
  if (blocker !== undefined) throw reasonFailure('student_login_not_eligible')
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  )
}

/**
 * The office's view of one pupil's login. The caller has already decided
 * students.manage_login on this pupil; the decision is made again here only
 * to fill allowedActions from the same snapshot.
 */
export async function loadStudentLogin(
  conn: AuthzConnection,
  deps: Pick<AccessDependencies, 'pools'>,
  context: RequestContext,
  studentId: string,
): Promise<View> {
  const row = await loadPupil(conn.client, context.schoolId, studentId)
  const state = stateOf(row)
  const blocker = blockerOf(row, state)

  let passwordChangePending = false
  let lastSignInAt: string | undefined
  if (row.membership_user_id !== null && state !== 'ended') {
    // The identity lives behind the auth credential; the tenant login cannot read it.
    const identity = await deps.pools.auth.query<{ must: boolean; last: Date | null }>(
      `SELECT u.must_change_password AS must,
              (SELECT max(created_at) FROM auth_session WHERE user_id = u.id) AS last
         FROM auth_user u WHERE u.id = $1`,
      [row.membership_user_id],
    )
    passwordChangePending = identity.rows[0]?.must === true
    const last = identity.rows[0]?.last
    if (last) lastSignInAt = new Date(last).toISOString()
  }

  const decision = await decideAction(conn, context, PERMISSION, studentId, false)
  return StudentLoginView.parse({
    state,
    username: row.admission_number,
    schoolCode: row.login_code,
    ...(blocker === undefined ? {} : { blocker }),
    ...(row.guardian_phone === null
      ? {}
      : { guardianPhoneMasked: maskDestination('phone', row.guardian_phone) }),
    passwordChangePending,
    ...(row.issued_at === null || state === 'none'
      ? {}
      : { issuedAt: new Date(row.issued_at).toISOString() }),
    ...(lastSignInAt === undefined ? {} : { lastSignInAt }),
    ...(row.membership_version === null ? {} : { version: Number(row.membership_version) }),
    allowedActions: decision.allowed ? [PERMISSION] : [],
  })
}

/** A queued text, without the password: only the pupil id and the channel. */
async function queuePasswordText(
  client: PoolClient,
  schoolId: string,
  studentId: string,
  phone: string,
): Promise<string> {
  const outbox = await client.query<{ id: string }>(
    `INSERT INTO delivery_outbox (school_id, event_type, destination, payload)
     VALUES ($1, 'student_password', $2, $3::jsonb)
     RETURNING id`,
    [schoolId, maskDestination('phone', phone), JSON.stringify({ studentId })],
  )
  const row = outbox.rows[0]
  if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return row.id
}

interface PendingText {
  readonly outboxId: string
  readonly to: string
  readonly schoolCode: string
  readonly admissionNumber: string
}

/**
 * Sends the password after the commit and records what happened to the
 * outbox row, as invitations do. Returns false when the text did not go.
 */
async function sendPasswordText(
  deps: AccessDependencies,
  context: RequestContext,
  pending: PendingText,
  password: string,
): Promise<boolean> {
  let sent = true
  try {
    await deps.delivery.send({
      channel: 'sms',
      to: pending.to,
      purpose: 'student_password',
      secret: password,
      studentLogin: { schoolCode: pending.schoolCode, admissionNumber: pending.admissionNumber },
    })
  } catch {
    sent = false
  }
  await withTenantTransaction(deps.pools.runtime, context, async ({ client }) => {
    await client.query(
      sent
        ? `UPDATE delivery_outbox
              SET status = 'sent', delivered_at = now(), attempts = attempts + 1
            WHERE school_id = $1 AND id = $2`
        : `UPDATE delivery_outbox
              SET status = 'failed', last_error = 'delivery failed', attempts = attempts + 1
            WHERE school_id = $1 AND id = $2`,
      [context.schoolId, pending.outboxId],
    )
  })
  return sent
}

export interface IssueOutcome {
  /** False when the login was made but the password text did not go. */
  readonly textSent: boolean
}

/**
 * Issues one pupil's login. Two steps, as the spec describes: the identity is
 * created through the auth pool once the request has been checked, then one
 * tenant transaction checks everything again and writes the membership, the
 * queued text and the audit row. When that transaction does not commit the new
 * identity is removed again. The password is texted after the commit.
 */
export async function issueStudentLogin(
  deps: AccessDependencies,
  context: RequestContext,
  studentId: string,
  trigger: StudentLoginTrigger,
): Promise<IssueOutcome> {
  // Settled before any identity exists, so a refused caller never creates one.
  const first = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await authorizePupil(conn, context, studentId)
    const row = await loadPupil(conn.client, context.schoolId, studentId)
    assertIssuable(row)
    return row
  })

  const password = generateStudentPassword()
  const identity = await provisionStudentIdentity(deps.auth, {
    name: pupilName(first),
    password,
  })

  let pending: PendingText
  try {
    pending = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
      await lockSchool(conn, context.schoolId)
      await authorizePupil(conn, context, studentId)
      const row = await loadPupil(conn.client, context.schoolId, studentId)
      assertIssuable(row)
      // assertIssuable proved the phone is there.
      const phone = row.guardian_phone as string

      if (row.membership_id === null) {
        const created = await conn.client.query<{ id: string }>(
          `INSERT INTO school_memberships (school_id, user_id, kind, status)
           VALUES ($1, $2, 'student', 'active')
           RETURNING id`,
          [context.schoolId, identity.userId],
        )
        const membershipId = created.rows[0]?.id
        if (!membershipId) throw new ApiFailure('SERVICE_UNAVAILABLE')
        const role = await conn.client.query<{ id: string }>(
          `SELECT id FROM roles WHERE school_id = $1 AND key = 'student'`,
          [context.schoolId],
        )
        const roleId = role.rows[0]?.id
        if (!roleId) throw new ApiFailure('SERVICE_UNAVAILABLE')
        await conn.client.query(
          `INSERT INTO membership_roles (school_id, membership_id, role_id, assigned_by_membership_id)
           VALUES ($1, $2, $3, $4)`,
          [context.schoolId, membershipId, roleId, context.membershipId],
        )
        await conn.client.query(
          `INSERT INTO membership_student_links (school_id, membership_id, student_id)
           VALUES ($1, $2, $3)`,
          [context.schoolId, membershipId, studentId],
        )
      } else {
        // An ended login: the one link per pupil stays, and its membership
        // now points at the new identity. The old identity is left with no
        // membership, so the credential sweep removes it later. The issue
        // date is the new one.
        const locked = await lockMembershipForAccessChange(
          conn,
          context.schoolId,
          row.membership_id,
          Number(row.membership_version),
        )
        await conn.client.query(
          `UPDATE school_memberships
              SET user_id = $3, status = 'active', created_at = now()
            WHERE school_id = $1 AND id = $2`,
          [context.schoolId, row.membership_id, identity.userId],
        )
        await commitAccessChange(conn, context.schoolId, row.membership_id, locked.version)
      }

      const outboxId = await queuePasswordText(conn.client, context.schoolId, studentId, phone)
      await recordAuditEvent(conn, {
        schoolId: context.schoolId,
        actorUserId: context.userId,
        actorMembershipId: context.membershipId,
        action: PERMISSION,
        targetType: 'student',
        targetId: studentId,
        result: 'allowed',
        summary: 'Issued a pupil their own login and queued the password text.',
        safeChanges: { change: 'issued', trigger },
        requestId: context.requestId,
      })
      return {
        outboxId,
        to: phone,
        schoolCode: row.login_code,
        admissionNumber: row.admission_number,
      }
    })
  } catch (error) {
    await removeUnusedStudentIdentity(deps.auth, identity.userId).catch(() => undefined)
    // A racing issue for the same pupil loses the one-link-per-pupil check.
    if (isUniqueViolation(error)) throw reasonFailure('student_login_exists')
    throw error
  }

  return { textSent: await sendPasswordText(deps, context, pending, password) }
}

function emptyResult(): { -readonly [K in keyof IssueStudentLoginsResult]: number } {
  return { issued: 0, noGuardianPhone: 0, alreadyHadLogin: 0, textFailed: 0 }
}

/**
 * Issues a login to every pupil of the list who is eligible and has none (or
 * whose login ended), one at a time. It never throws: a pupil it could not
 * serve is counted, and a failure is logged with counts only, never a name.
 * A caller who does not hold students.manage_login gets nothing issued.
 */
export async function issueStudentLogins(
  deps: AccessDependencies,
  context: RequestContext,
  studentIds: readonly string[],
  trigger: StudentLoginTrigger,
  log: (fields: Record<string, unknown>, line: string) => void = () => undefined,
): Promise<IssueStudentLoginsResult> {
  const result = emptyResult()
  const unique = [...new Set(studentIds)]
  if (unique.length === 0) return result
  let failed = 0
  try {
    const candidates = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
      const decision = await decideAction(conn, context, PERMISSION, context.schoolId, true)
      if (!decision.allowed) return []
      const rows = await loadPupils(conn.client, context.schoolId, unique)
      const ready: string[] = []
      for (const row of rows) {
        const state = stateOf(row)
        if (!row.on_roll || !row.senior) continue
        if (state === 'active' || state === 'switched_off') result.alreadyHadLogin += 1
        else if (row.guardian_phone === null) result.noGuardianPhone += 1
        else ready.push(row.id)
      }
      return ready
    })
    for (const studentId of candidates) {
      try {
        const outcome = await issueStudentLogin(deps, context, studentId, trigger)
        if (outcome.textSent) result.issued += 1
        else result.textFailed += 1
      } catch (error) {
        if (error instanceof ApiFailure && error.reason === 'student_login_exists') {
          result.alreadyHadLogin += 1
        } else if (error instanceof ApiFailure && error.reason === 'student_login_no_guardian_phone') {
          result.noGuardianPhone += 1
        } else {
          failed += 1
        }
      }
    }
  } catch {
    failed += 1
  }
  if (failed > 0) log({ trigger, failed, ...result }, 'some pupil logins could not be issued')
  return result
}

/** The pupil's login as it stands, locked for a change, or student_login_missing. */
async function lockLogin(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
): Promise<PupilRow & { membership_id: string; membership_user_id: string }> {
  await lockSchool(conn, context.schoolId)
  await authorizePupil(conn, context, studentId)
  const row = await loadPupil(conn.client, context.schoolId, studentId)
  if (row.membership_id === null || row.membership_user_id === null) {
    throw reasonFailure('student_login_missing')
  }
  return row as PupilRow & { membership_id: string; membership_user_id: string }
}

/**
 * A new generated password for a login that is on or switched off. The
 * outbox row and the audit row commit first; then the identity takes the new
 * password (every session ends) and the text goes. Returns false when the
 * text did not go.
 */
export async function resetStudentPassword(
  deps: AccessDependencies,
  context: RequestContext,
  studentId: string,
): Promise<boolean> {
  const prepared = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    const row = await lockLogin(conn, context, studentId)
    const state = stateOf(row)
    if (state !== 'active' && state !== 'switched_off') throw reasonFailure('student_login_missing')
    if (row.guardian_phone === null) throw reasonFailure('student_login_no_guardian_phone')
    const outboxId = await queuePasswordText(conn.client, context.schoolId, studentId, row.guardian_phone)
    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: PERMISSION,
      targetType: 'student',
      targetId: studentId,
      result: 'allowed',
      summary: "Reset a pupil's password and queued the new password text.",
      safeChanges: { change: 'password_reset' },
      requestId: context.requestId,
    })
    return {
      userId: row.membership_user_id,
      pending: {
        outboxId,
        to: row.guardian_phone,
        schoolCode: row.login_code,
        admissionNumber: row.admission_number,
      },
    }
  })

  const password = generateStudentPassword()
  try {
    await replaceStudentPassword(deps.auth, deps.pools.auth, prepared.userId, password)
  } catch {
    // The old password still stands; the queued text must not claim otherwise.
    await withTenantTransaction(deps.pools.runtime, context, ({ client }) =>
      client.query(
        `UPDATE delivery_outbox
            SET status = 'failed', last_error = 'password not replaced', attempts = attempts + 1
          WHERE school_id = $1 AND id = $2`,
        [context.schoolId, prepared.pending.outboxId],
      ),
    )
    throw new ApiFailure('SERVICE_UNAVAILABLE')
  }
  return sendPasswordText(deps, context, prepared.pending, password)
}

/**
 * Switches an active login off. Every session of the pupil ends after the
 * commit. The reason a person typed is the audit note.
 */
export async function switchOffStudentLogin(
  deps: AccessDependencies,
  context: RequestContext,
  studentId: string,
  input: { expectedVersion: number; reason?: string | undefined },
): Promise<void> {
  const userId = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    const row = await lockLogin(conn, context, studentId)
    if (stateOf(row) !== 'active') throw reasonFailure('student_login_missing')
    const locked = await lockMembershipForAccessChange(
      conn,
      context.schoolId,
      row.membership_id,
      input.expectedVersion,
    )
    await conn.client.query(
      `UPDATE school_memberships SET status = 'suspended' WHERE school_id = $1 AND id = $2`,
      [context.schoolId, row.membership_id],
    )
    await commitAccessChange(conn, context.schoolId, row.membership_id, locked.version)
    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: PERMISSION,
      targetType: 'student',
      targetId: studentId,
      result: 'allowed',
      summary: "Switched off a pupil's login.",
      safeChanges: { change: 'switched_off' },
      requestId: context.requestId,
      ...(input.reason === undefined ? {} : { note: input.reason }),
    })
    return row.membership_user_id
  })
  // The login is already refused by the session check, so a failure to end
  // the sessions here does not undo the switch-off.
  await endAllSessions(deps.auth, userId).catch(() => undefined)
}

/** Switches a login back on, for a pupil still on the roll in Class 9 to 12. */
export async function switchOnStudentLogin(
  deps: AccessDependencies,
  context: RequestContext,
  studentId: string,
  input: { expectedVersion: number },
): Promise<void> {
  await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    const row = await lockLogin(conn, context, studentId)
    if (stateOf(row) !== 'switched_off') throw reasonFailure('student_login_missing')
    if (!row.on_roll || !row.senior) throw reasonFailure('student_login_not_eligible')
    const locked = await lockMembershipForAccessChange(
      conn,
      context.schoolId,
      row.membership_id,
      input.expectedVersion,
    )
    await conn.client.query(
      `UPDATE school_memberships SET status = 'active' WHERE school_id = $1 AND id = $2`,
      [context.schoolId, row.membership_id],
    )
    await commitAccessChange(conn, context.schoolId, row.membership_id, locked.version)
    await recordAuditEvent(conn, {
      schoolId: context.schoolId,
      actorUserId: context.userId,
      actorMembershipId: context.membershipId,
      action: PERMISSION,
      targetType: 'student',
      targetId: studentId,
      result: 'allowed',
      summary: "Switched a pupil's login back on.",
      safeChanges: { change: 'switched_on' },
      requestId: context.requestId,
    })
  })
}

/**
 * Ends a pupil's login inside another write's transaction (leaving,
 * anonymisation). No audit row of its own: the caller's row gains
 * studentLoginEnded. Returns the identity whose sessions the caller ends after
 * the commit, or null when there was no login on or switched off.
 */
export async function endStudentLogin(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
): Promise<{ userId: string } | null> {
  const found = await conn.client.query<{ id: string; user_id: string; version: number }>(
    `SELECT m.id, m.user_id, m.version
       FROM membership_student_links link
       JOIN school_memberships m ON m.school_id = link.school_id AND m.id = link.membership_id
      WHERE link.school_id = $1 AND link.student_id = $2 AND m.status IN ('active', 'suspended')
      FOR UPDATE OF m`,
    [context.schoolId, studentId],
  )
  const row = found.rows[0]
  if (!row) return null
  const locked = await lockMembershipForAccessChange(conn, context.schoolId, row.id, Number(row.version))
  await conn.client.query(
    `UPDATE school_memberships SET status = 'removed' WHERE school_id = $1 AND id = $2`,
    [context.schoolId, row.id],
  )
  await commitAccessChange(conn, context.schoolId, row.id, locked.version)
  return { userId: row.user_id }
}

/**
 * The pupils of the school who are on the roll in Class 9 to 12 and have no
 * login on or switched off, at most BULK_ISSUE_LIMIT, and how many already
 * have one. The caller has decided students.manage_login at school scope.
 */
export async function missingStudentLogins(
  conn: AuthzConnection,
  schoolId: string,
): Promise<{ studentIds: string[]; alreadyHadLogin: number }> {
  const senior = `s.status = 'active' AND s.anonymised_at IS NULL AND EXISTS (
      SELECT 1 FROM enrollments e
        JOIN academic_years y ON y.school_id = e.school_id AND y.id = e.academic_year_id
        JOIN sections sec ON sec.school_id = e.school_id AND sec.id = e.section_id
        JOIN grades g ON g.school_id = sec.school_id AND g.id = sec.grade_id
       WHERE e.school_id = s.school_id AND e.student_id = s.id AND e.left_on IS NULL
         AND y.status <> 'closed' AND g.level BETWEEN $2 AND $3)`
  const hasLogin = `EXISTS (
      SELECT 1 FROM membership_student_links link
        JOIN school_memberships m ON m.school_id = link.school_id AND m.id = link.membership_id
       WHERE link.school_id = s.school_id AND link.student_id = s.id
         AND m.status IN ('active', 'suspended'))`
  const missing = await conn.client.query<{ id: string }>(
    `SELECT s.id FROM students s
      WHERE s.school_id = $1 AND ${senior} AND NOT ${hasLogin}
      ORDER BY s.admission_number, s.id
      LIMIT $4`,
    [schoolId, STUDENT_LOGIN_LEVELS.from, STUDENT_LOGIN_LEVELS.to, BULK_ISSUE_LIMIT],
  )
  const had = await conn.client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM students s
      WHERE s.school_id = $1 AND ${senior} AND ${hasLogin}`,
    [schoolId, STUDENT_LOGIN_LEVELS.from, STUDENT_LOGIN_LEVELS.to],
  )
  return {
    studentIds: missing.rows.map((row) => row.id),
    alreadyHadLogin: Number(had.rows[0]?.count ?? '0'),
  }
}
