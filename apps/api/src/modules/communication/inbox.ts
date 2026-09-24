import type { FastifyInstance } from 'fastify'
import { sql, type SQL } from 'drizzle-orm'
import { InboxList, InboxQuery, MarkReadResponse, UnreadCount, type InboxItem, type MessageKind } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  assertUuidParam,
  protectedRoute,
  requireFound,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { kickMessagePump } from './pump.ts'
import {
  isoOf,
  labelMessages,
  readablePupils,
  recipientPlan,
  type MessageConnection,
  type MessageRow,
} from './shared-reads.ts'

/**
 * The caller's own inbox: the recipient rows that show for them in the app,
 * of messages that are out and not withdrawn, newest first. Opening one is the
 * read receipt, and the only one there is.
 */

/** Over `message_recipients` joined to `messages`: the caller's own copies in the app. */
async function mine(conn: MessageConnection, context: RequestContext): Promise<SQL> {
  const predicate = await recipientPlan(conn, context)
  return sql`${predicate}
    AND message_recipients.membership_id = ${context.membershipId}::uuid
    AND message_recipients.in_app
    AND messages.status = 'sent'`
}

const INBOX_FROM = sql`FROM message_recipients
  JOIN messages ON messages.school_id = message_recipients.school_id AND messages.id = message_recipients.message_id`

async function unreadCount(conn: MessageConnection, context: RequestContext): Promise<number> {
  const result = await conn.db.execute<{ count: number }>(
    sql`SELECT count(*)::int AS count ${INBOX_FROM}
         WHERE ${await mine(conn, context)} AND message_recipients.read_at IS NULL`,
  )
  return Number(result.rows[0]?.count ?? 0)
}

type InboxRow = Pick<
  MessageRow,
  | 'audience'
  | 'recipients'
  | 'grade_id'
  | 'grade_to_id'
  | 'section_id'
  | 'staff_id'
  | 'created_by_membership_id'
  | 'kind'
  | 'title'
  | 'body'
> & {
  id: string
  recipient_id: string
  recipient_student_id: string | null
  student_id: string | null
  sent_at: string
  read_at: string | null
}

export function registerInboxRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/messages/inbox',
    permission: 'communication.read',
    query: InboxQuery,
    response: InboxList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const filters = [await mine(conn, context)]
        if (query.kind !== undefined) filters.push(sql`messages.kind = ${query.kind}`)
        if (query.show === 'unread') filters.push(sql`message_recipients.read_at IS NULL`)
        const where = sql.join(filters, sql` AND `)

        const total = await conn.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count ${INBOX_FROM} WHERE ${where}`,
        )
        const page = await conn.db.execute<InboxRow>(
          sql`SELECT messages.id, message_recipients.id AS recipient_id,
                     message_recipients.student_id AS recipient_student_id, messages.student_id,
                     messages.audience, messages.recipients, messages.grade_id, messages.grade_to_id,
                     messages.section_id, messages.staff_id,
                     messages.created_by_membership_id, messages.kind, messages.title, messages.body,
                     ${sql.raw(isoOf('messages.sent_at'))} AS sent_at,
                     ${sql.raw(isoOf('message_recipients.read_at'))} AS read_at
                ${INBOX_FROM}
               WHERE ${where}
               ORDER BY messages.sent_at DESC, messages.id DESC
               LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
        )
        const rows = [...page.rows]
        const labels = await labelMessages(conn, context, rows)
        // The pupil a message is about, named only when the caller may read
        // that pupil's name (a parent reads their own child's).
        // A pupil's own inbox is all about the pupil, so it names nobody.
        const about = (row: InboxRow) =>
          context.membershipKind === 'student' ? undefined : (row.student_id ?? row.recipient_student_id)
        const pupils = await readablePupils(
          conn,
          context,
          rows.flatMap((row) => {
            const id = about(row)
            return id ? [id] : []
          }),
        )
        const items: InboxItem[] = rows.map((row) => {
          const pupilId = about(row)
          const pupil = pupilId ? pupils.get(pupilId) : undefined
          return {
            recipientId: row.recipient_id,
            messageId: row.id,
            kind: row.kind as MessageKind,
            title: row.title,
            preview: row.body.slice(0, 160),
            sentAt: row.sent_at,
            ...(row.read_at === null ? {} : { readAt: row.read_at }),
            sender: requireFound(labels.senders.get(row.id)),
            ...(pupil && pupilId ? { pupil: { id: pupilId, name: pupil.name } } : {}),
            attachmentCount: labels.attachments.get(row.id) ?? 0,
          }
        })
        return {
          items,
          total: Number(total.rows[0]?.count ?? 0),
          unread: await unreadCount(conn, context),
          page: query.page,
          pageSize: query.pageSize,
        }
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/messages/inbox/unread',
    permission: 'communication.read',
    response: UnreadCount,
    handler: async ({ context }) => {
      const unread = await withTenantTransaction(deps.pools.runtime, context, (conn) => unreadCount(conn, context))
      // The web asks this every minute while anybody in the school has the
      // app open, so it is what keeps the school's messages moving. The pump
      // runs in the background and never holds up this answer.
      kickMessagePump(deps, context.schoolId)
      return { unread }
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages/inbox/:recipientId/read',
    permission: 'communication.read',
    response: MarkReadResponse,
    handler: async ({ context, param }) => {
      const recipientId = assertUuidParam(param('recipientId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const found = await conn.db.execute<{ read_at: string | null }>(
          sql`SELECT ${sql.raw(isoOf('message_recipients.read_at'))} AS read_at ${INBOX_FROM}
               WHERE ${await mine(conn, context)} AND message_recipients.id = ${recipientId}::uuid`,
        )
        const row = found.rows[0]
        if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
        if (row.read_at !== null) return { recipientId, readAt: row.read_at }

        // Only the first opening moves read_at; two tabs opening it at once
        // both answer, and only the one that set it writes the audit row.
        const updated = await conn.client.query<{ read_at: string }>(
          `UPDATE message_recipients SET read_at = now()
            WHERE school_id = $1 AND id = $2 AND read_at IS NULL
            RETURNING ${isoOf('read_at')} AS read_at`,
          [context.schoolId, recipientId],
        )
        const first = updated.rows[0]
        if (!first) {
          const again = await conn.client.query<{ read_at: string }>(
            `SELECT ${isoOf('read_at')} AS read_at FROM message_recipients WHERE school_id = $1 AND id = $2`,
            [context.schoolId, recipientId],
          )
          return { recipientId, readAt: requireFound(again.rows[0]).read_at }
        }
        await writeAudit(conn, context, {
          action: 'communication.read',
          targetType: 'communication',
          targetId: recipientId,
          summary: 'Opened a message.',
          safeChanges: { recipientId },
        })
        return { recipientId, readAt: first.read_at }
      })
    },
  })
}
