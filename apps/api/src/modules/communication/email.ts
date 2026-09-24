import { MESSAGE_EMAIL_MAX_ATTEMPTS } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { createRequestContext } from '../../auth/request-context.ts'
import type { OutgoingAttachment } from '../../delivery/types.ts'
import { isDeliverableAddress, type DispatchDependencies } from './common.ts'

/** At most this many emails go in one pump run for one school. */
export const MESSAGE_EMAILS_PER_RUN = 40

/** The provider's rate: at least this long between two emails. */
const EMAIL_SPACING_MS = 550

const NO_ONE = '00000000-0000-0000-0000-000000000000'

/**
 * A context that only names the school, for the pump's own work. It opens a
 * tenant transaction so row-level security sees this school; it has no roles,
 * serves nobody and decides nothing, like the lookup context the export queue
 * uses to re-read a membership.
 */
export function systemContext(schoolId: string, requestId: string): RequestContext {
  return createRequestContext({
    requestId,
    userId: NO_ONE,
    sessionId: requestId,
    schoolId,
    membershipId: NO_ONE,
    membershipKind: 'adult',
    accessVersion: 1,
    roleKeys: [],
    assurance: 'single_factor',
    mfaVerifiedAt: null,
  })
}

interface ClaimedRow {
  id: string
  message_id: string
  in_app: boolean
  email_attempts: number
  own_email: string | null
  user_id: string | null
  title: string
  body: string
  school_name: string
}

interface AttachmentRow {
  file_name: string
  content_type: string
  storage_key: string
}

interface Claimed {
  readonly row: ClaimedRow
  readonly attachments: readonly AttachmentRow[]
}

/**
 * Claim the next due email of a sent message. The row is locked with SKIP
 * LOCKED and leased for five minutes by moving its next attempt on, so a
 * second runner neither waits for it nor sends it again; a runner that dies
 * leaves it to be picked up when the lease ends.
 */
async function claimNext(deps: DispatchDependencies, context: RequestContext): Promise<Claimed | null> {
  return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    const claimed = await conn.client.query<ClaimedRow>(
      `WITH due AS (
          SELECT r.school_id, r.id
            FROM message_recipients r
            JOIN messages m ON m.school_id = r.school_id AND m.id = r.message_id AND m.status = 'sent'
           WHERE r.school_id = $1 AND r.email_status = 'pending'
             AND COALESCE(r.email_next_attempt_at, '-infinity') <= now()
           ORDER BY r.email_next_attempt_at NULLS FIRST, r.id
           LIMIT 1
           FOR UPDATE OF r SKIP LOCKED
        ),
        leased AS (
          UPDATE message_recipients r SET email_next_attempt_at = now() + interval '5 minutes'
            FROM due WHERE r.school_id = due.school_id AND r.id = due.id
          RETURNING r.id, r.message_id, r.in_app, r.email_attempts, r.guardian_id, r.staff_id, r.membership_id
        )
        SELECT l.id, l.message_id, l.in_app, l.email_attempts,
               COALESCE(g.email, s.email) AS own_email, sm.user_id,
               m.title, m.body, sc.name AS school_name
          FROM leased l
          JOIN messages m ON m.school_id = $1 AND m.id = l.message_id
          JOIN schools sc ON sc.id = $1
          LEFT JOIN guardians g ON g.school_id = $1 AND g.id = l.guardian_id AND g.anonymised_at IS NULL
          LEFT JOIN staff s ON s.school_id = $1 AND s.id = l.staff_id AND s.anonymised_at IS NULL
          LEFT JOIN school_memberships sm ON sm.school_id = $1 AND sm.id = l.membership_id AND sm.status = 'active'`,
      [context.schoolId],
    )
    const row = claimed.rows[0]
    if (!row) return null
    const files = await conn.client.query<AttachmentRow>(
      `SELECT file_name, content_type, storage_key FROM message_attachments
        WHERE school_id = $1 AND message_id = $2 ORDER BY created_at, id`,
      [context.schoolId, row.message_id],
    )
    return { row, attachments: files.rows }
  })
}

/** The address as it is now: the person's own, else the sign-in address of their membership. */
async function currentAddress(deps: DispatchDependencies, row: ClaimedRow): Promise<string | null> {
  if (isDeliverableAddress(row.own_email)) return row.own_email
  if (!row.user_id) return null
  const found = await deps.pools.auth.query<{ email: string | null }>(
    'SELECT email FROM auth_user WHERE id = $1',
    [row.user_id],
  )
  const signIn = found.rows[0]?.email
  return isDeliverableAddress(signIn) ? signIn : null
}

async function readAttachments(
  deps: DispatchDependencies,
  rows: readonly AttachmentRow[],
): Promise<OutgoingAttachment[]> {
  const files: OutgoingAttachment[] = []
  for (const row of rows) {
    // A blank key is a file the retention sweep has already removed.
    if (row.storage_key === '') continue
    const file = await deps.documents.read(row.storage_key)
    if (!file) continue
    const chunks: Uint8Array[] = []
    for await (const chunk of file.stream as AsyncIterable<Uint8Array | string>)
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    files.push({ fileName: row.file_name, contentType: row.content_type, bytes: Buffer.concat(chunks) })
  }
  return files
}

type Outcome = 'sent' | 'failed' | 'retry' | 'none'

/** Record what happened, in its own short transaction, unless the email was cancelled meanwhile. */
async function record(
  deps: DispatchDependencies,
  context: RequestContext,
  row: ClaimedRow,
  outcome: Outcome,
): Promise<void> {
  const change = {
    sent: `email_status = 'sent', email_sent_at = now(), email_next_attempt_at = NULL`,
    none: `email_status = 'none', email_next_attempt_at = NULL`,
    failed: `email_status = 'failed', email_attempts = email_attempts + 1, email_next_attempt_at = NULL`,
    // 10, 20, 40 and 80 minutes after the first, second, third and fourth failure.
    retry: `email_attempts = email_attempts + 1,
            email_next_attempt_at = now() + make_interval(mins => 10 * power(2, email_attempts)::int)`,
  }[outcome]
  await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
    await conn.client.query(
      `UPDATE message_recipients SET ${change}
        WHERE school_id = $1 AND id = $2 AND email_status = 'pending'`,
      [context.schoolId, row.id],
    )
  })
}

function emailText(deps: DispatchDependencies, row: ClaimedRow): string {
  const lines = [row.body, '', `This is an announcement from ${row.school_name}. Replies to this email are not read.`]
  if (row.in_app) {
    const origin = deps.config.APP_ORIGIN.replace(/\/+$/, '')
    lines.push(`Open it in the app: ${origin}/messages/${row.message_id}`)
  }
  return lines.join('\n')
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Work through this school's email queue: one email at a time, at most
 * MESSAGE_EMAILS_PER_RUN, paced for the provider. A failure is counted and
 * tried again later; nothing about the person or the words is logged.
 */
export async function runEmailQueue(
  deps: DispatchDependencies,
  schoolId: string,
  requestId: string,
): Promise<{ sent: number; failed: number; retry: number; none: number }> {
  const context = systemContext(schoolId, requestId)
  const counts = { sent: 0, failed: 0, retry: 0, none: 0 }
  let lastSentAt = 0
  for (let index = 0; index < MESSAGE_EMAILS_PER_RUN; index += 1) {
    const claimed = await claimNext(deps, context)
    if (!claimed) break
    const { row } = claimed

    let outcome: Outcome
    try {
      const to = await currentAddress(deps, row)
      if (to === null) {
        outcome = 'none'
      } else {
        const attachments = await readAttachments(deps, claimed.attachments)
        if (deps.delivery.mode === 'provider') {
          const wait = lastSentAt + EMAIL_SPACING_MS - Date.now()
          if (wait > 0) await pause(wait)
          lastSentAt = Date.now()
        }
        await deps.delivery.sendMessage({
          to,
          fromName: row.school_name,
          subject: row.title,
          text: emailText(deps, row),
          attachments,
        })
        outcome = 'sent'
      }
    } catch {
      // The reason may echo the address, so it is not kept; the attempt is.
      outcome = row.email_attempts + 1 >= MESSAGE_EMAIL_MAX_ATTEMPTS ? 'failed' : 'retry'
    }
    await record(deps, context, row, outcome)
    counts[outcome] += 1
  }
  return counts
}
