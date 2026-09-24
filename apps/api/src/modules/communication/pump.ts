import { waitUntil } from '@vercel/functions'
import { loadMembershipStateById, loadRoleKeys, type AuthzConnection } from '@erp/authz'
import type { MessageAudienceKind } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { createRequestContext } from '../../auth/request-context.ts'
import { reportError } from '../../observability.ts'
import { decideResource } from '../shared/index.ts'
import { createAutomaticMessages } from './automatic.ts'
import type { DispatchDependencies } from './common.ts'
import { runEmailQueue, systemContext } from './email.ts'
import { materialiseMessage } from './materialise.ts'

interface DueRow {
  id: string
  audience: MessageAudienceKind
  grade_id: string | null
  grade_to_id: string | null
  section_id: string | null
  student_id: string | null
  created_by_membership_id: string | null
}

/** How many scheduled messages one run sends, so a run stays bounded. */
const SCHEDULED_PER_RUN = 100

/**
 * The records `communication.send` is decided on: the section, the pupil, the
 * grade, both ends of a range of classes, or the school.
 */
function targetsOf(row: DueRow, schoolId: string): string[] {
  switch (row.audience) {
    case 'section':
      return [row.section_id ?? schoolId]
    case 'pupil':
      return [row.student_id ?? schoolId]
    case 'grade':
      return [row.grade_id ?? schoolId]
    case 'grade_range':
      return [...new Set([row.grade_id ?? schoolId, row.grade_to_id ?? schoolId])]
    default:
      return [schoolId]
  }
}

/**
 * Whether the author may still send this message now. Their context is built
 * again from the database the way the export queue rebuilds a requester's: a
 * membership that is no longer active, or has no roles, may send nothing.
 */
async function authorMaySend(
  conn: AuthzConnection,
  schoolId: string,
  requestId: string,
  row: DueRow,
): Promise<boolean> {
  if (!row.created_by_membership_id) return false
  const membership = await loadMembershipStateById(conn, schoolId, row.created_by_membership_id)
  if (membership === null || membership.status !== 'active') return false
  const roleKeys = await loadRoleKeys(conn, schoolId, membership.id)
  if (roleKeys.length === 0) return false
  const author = createRequestContext({
    requestId,
    userId: membership.userId,
    sessionId: requestId,
    schoolId,
    membershipId: membership.id,
    membershipKind: membership.kind,
    accessVersion: membership.accessVersion,
    roleKeys,
    // The author passed every check the send route makes, a second factor
    // included, when they scheduled it; what can have changed since is their
    // roles and relationships, which the decision reads again. Replaying a
    // single factor instead would cancel every message an office role
    // schedules, since those roles cannot act without the second factor.
    assurance: 'mfa',
    mfaVerifiedAt: new Date().toISOString(),
  })
  for (const target of targetsOf(row, schoolId)) {
    const decision = await decideResource(conn, author, 'communication.send', 'communication', target)
    if (!decision.allowed) return false
  }
  return true
}

/**
 * The one place automatic messages are made and emails go, for one school.
 * A second runner for the same school returns at once. Scheduled messages
 * and automatic messages are made in one transaction; the email queue runs
 * after the commit, each email in its own short transaction. It works as the
 * school with no member and writes no audit row: the messages and their
 * recipient rows are the record of what the school sent.
 */
export async function runMessagePump(
  deps: DispatchDependencies,
  schoolId: string,
  requestId: string,
): Promise<Record<string, number>> {
  const made = await withTenantTransaction(deps.pools.runtime, systemContext(schoolId, requestId), async (conn) => {
    const lock = await conn.client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('messages:' || $1)) AS locked`,
      [schoolId],
    )
    if (!lock.rows[0]?.locked) return null

    // Automatic messages start the first time the pump runs for the school.
    await conn.client.query(
      'INSERT INTO communication_settings (school_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [schoolId],
    )

    const due = await conn.client.query<DueRow>(
      `SELECT id, audience, grade_id, grade_to_id, section_id, student_id, created_by_membership_id
         FROM messages
        WHERE school_id = $1 AND status = 'scheduled' AND send_at <= now()
        ORDER BY send_at, id
        LIMIT ${SCHEDULED_PER_RUN}
        FOR UPDATE SKIP LOCKED`,
      [schoolId],
    )
    let scheduledSent = 0
    let scheduledCancelled = 0
    for (const row of due.rows) {
      if (await authorMaySend(conn, schoolId, requestId, row)) {
        await materialiseMessage(conn, deps, schoolId, row.id, { allowEmpty: true })
        scheduledSent += 1
      } else {
        await conn.client.query(
          `UPDATE messages SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'author_lost_access',
                  version = version + 1, updated_at = now()
            WHERE school_id = $1 AND id = $2 AND status = 'scheduled'`,
          [schoolId, row.id],
        )
        scheduledCancelled += 1
      }
    }

    const automatic = await createAutomaticMessages(conn, deps, schoolId)
    return { scheduledSent, scheduledCancelled, automaticCreated: automatic.created }
  })
  if (made === null) return { skipped: 1 }

  const emails = await runEmailQueue(deps, schoolId, requestId)
  return {
    scheduled_sent: made.scheduledSent,
    scheduled_cancelled: made.scheduledCancelled,
    automatic_created: made.automaticCreated,
    emails_sent: emails.sent,
    emails_failed: emails.failed,
    emails_retry: emails.retry,
    emails_no_address: emails.none,
  }
}

/** When the pump was last started for each school by this process. */
const lastKick = new Map<string, number>()

const KICK_INTERVAL_MS = 60_000

/**
 * Start the pump for a school in the background, at most once a minute per
 * school per process. The request that kicks it does not wait; the platform
 * keeps the function alive until the pump is done. A failure is reported
 * with the request id alone, never with a word of any message.
 */
export function kickMessagePump(deps: DispatchDependencies, schoolId: string): void {
  const now = Date.now()
  const last = lastKick.get(schoolId)
  if (last !== undefined && now - last < KICK_INTERVAL_MS) return
  lastKick.set(schoolId, now)
  const requestId = `message-pump-${now}`
  waitUntil(
    runMessagePump(deps, schoolId, requestId).catch((error: unknown) => {
      // A database error's detail can quote a row, so only its code travels.
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'unknown'
      reportError(new Error(`The message pump failed (${code}).`), { requestId, route: 'message-pump' })
    }),
  )
}
