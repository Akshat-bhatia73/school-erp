import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import {
  MessageDetail,
  MessageList,
  MessageListQuery,
  MessageRecipientList,
  MessageRecipientQuery,
  type MessageRecipientRow,
  type RecipientOutcome,
  type EmailStatus,
} from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure, assertUuidParam, protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import {
  guardianReadablePupils,
  isoOf,
  loadMessage,
  MESSAGE_COLUMNS,
  messagePlans,
  projectSummaries,
  readableStaff,
  readablePupils,
  readMessageDetail,
  readsAsSender,
  recipientPlan,
  sectionLabels,
  type MessageRow,
} from './shared-reads.ts'

/**
 * The sent messages and their delivery records: the list of messages a caller
 * wrote or reaches other than as a recipient, one message, and the people it
 * went to. A person's own inbox is in inbox.ts.
 */

/** A title search, with the pattern characters taken literally. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

type RecipientDbRow = {
  id: string
  guardian_id: string | null
  staff_id: string | null
  student_id: string | null
  section_id: string | null
  outcome: RecipientOutcome
  in_app: boolean
  email_status: EmailStatus
  email_masked: string | null
  read_at: string | null
}

export function registerMessageReadRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/messages',
    permission: 'communication.read',
    query: MessageListQuery,
    response: MessageList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plans = await messagePlans(conn, context)
        const me = sql`${context.membershipId}::uuid`
        // What the caller wrote, or reaches other than as a recipient; never
        // somebody else's draft. A family's inbox is not this list.
        const filters = [
          plans.all,
          sql`(${plans.asReader} OR messages.created_by_membership_id = ${me})`,
          sql`(messages.status <> 'draft' OR messages.created_by_membership_id = ${me})`,
        ]
        if (query.kind !== undefined) filters.push(sql`messages.kind = ${query.kind}`)
        if (query.status !== undefined) filters.push(sql`messages.status = ${query.status}`)
        if (query.audience !== undefined) filters.push(sql`messages.audience = ${query.audience}`)
        if (query.author === 'mine') filters.push(sql`messages.created_by_membership_id = ${me}`)
        if (query.q !== undefined) filters.push(sql`messages.title ILIKE ${likePattern(query.q)}`)
        const where = sql.join(filters, sql` AND `)

        const total = await conn.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM messages WHERE ${where}`,
        )
        const page = await conn.db.execute<MessageRow>(
          sql`SELECT ${sql.raw(MESSAGE_COLUMNS)} FROM messages WHERE ${where}
               ORDER BY COALESCE(messages.sent_at, messages.send_at, messages.created_at) DESC, messages.id DESC
               LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
        )
        // Every row here is the caller's own or reached other than as a
        // recipient, so each carries its delivery figures.
        const items = await projectSummaries(conn, context, [...page.rows], () => true)
        return {
          items,
          total: Number(total.rows[0]?.count ?? 0),
          page: query.page,
          pageSize: query.pageSize,
        }
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/messages/:messageId',
    permission: 'communication.read',
    response: MessageDetail,
    handler: async ({ context, param }) => {
      const id = assertUuidParam(param('messageId'))
      return withTenantTransaction(deps.pools.runtime, context, (conn) => readMessageDetail(conn, context, id))
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/messages/:messageId/recipients',
    permission: 'communication.read',
    query: MessageRecipientQuery,
    response: MessageRecipientList,
    handler: async ({ context, query, param }) => {
      const id = assertUuidParam(param('messageId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // The delivery list is the author's, and a reader's who reaches the
        // message other than as one of its recipients. A recipient, or a
        // stranger, is told it is not there.
        const row = await loadMessage(conn, context.schoolId, id)
        if (row.status === 'draft' && row.created_by_membership_id !== context.membershipId) {
          throw new ApiFailure('RESOURCE_NOT_FOUND')
        }
        if (!(await readsAsSender(conn, context, row))) throw new ApiFailure('RESOURCE_NOT_FOUND')

        const predicate = await recipientPlan(conn, context)
        const filters = [predicate, sql`message_recipients.message_id = ${id}::uuid`]
        if (query.outcome !== undefined) filters.push(sql`message_recipients.outcome = ${query.outcome}`)
        if (query.emailStatus !== undefined) filters.push(sql`message_recipients.email_status = ${query.emailStatus}`)
        if (query.read === 'read') filters.push(sql`message_recipients.read_at IS NOT NULL`)
        if (query.read === 'unread') filters.push(sql`message_recipients.in_app AND message_recipients.read_at IS NULL`)
        const where = sql.join(filters, sql` AND `)

        const total = await conn.db.execute<{ count: number }>(
          sql`SELECT count(*)::int AS count FROM message_recipients WHERE ${where}`,
        )
        const page = await conn.db.execute<RecipientDbRow>(
          sql`SELECT message_recipients.id, message_recipients.guardian_id, message_recipients.staff_id,
                     message_recipients.student_id, message_recipients.section_id, message_recipients.outcome,
                     message_recipients.in_app, message_recipients.email_status, message_recipients.email_masked,
                     ${sql.raw(isoOf('message_recipients.read_at'))} AS read_at
                FROM message_recipients WHERE ${where}
               ORDER BY message_recipients.created_at, message_recipients.id
               LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
        )
        const rows = [...page.rows]
        const items = await projectRecipients(conn, context, rows)
        return { items, total: Number(total.rows[0]?.count ?? 0), page: query.page, pageSize: query.pageSize }
      })
    },
  })
}

/**
 * Names on a delivery list, each through its own plan: the pupil under
 * students.read_basic, the guardian and relation only where the caller may
 * read that pupil's guardian contacts ("Guardian" otherwise), a staff member
 * under staff.read_directory ("Staff member" otherwise).
 */
async function projectRecipients(
  conn: Parameters<typeof readablePupils>[0],
  context: Parameters<typeof readablePupils>[1],
  rows: readonly RecipientDbRow[],
): Promise<MessageRecipientRow[]> {
  const studentIds = rows.flatMap((row) => (row.student_id ? [row.student_id] : []))
  const pupils = await readablePupils(conn, context, studentIds)
  const guardianReach = await guardianReadablePupils(conn, context, studentIds)
  const staffNames = await readableStaff(conn, context, rows.flatMap((row) => (row.staff_id ? [row.staff_id] : [])))
  const sections = await sectionLabels(conn, context.schoolId, rows.flatMap((row) => (row.section_id ? [row.section_id] : [])))

  // Guardian names and relations, only for pairs whose pupil the guardian
  // contact plan reaches.
  const pairs = rows.filter(
    (row) => row.guardian_id !== null && row.student_id !== null && guardianReach.has(row.student_id),
  )
  const guardians = new Map<string, { name: string; relation: string }>()
  if (pairs.length > 0) {
    const result = await conn.client.query<{ guardian_id: string; student_id: string; first_name: string; last_name: string | null; relation: string }>(
      `SELECT g.id AS guardian_id, sg.student_id, g.first_name, g.last_name, sg.relation
         FROM guardians g
         JOIN student_guardians sg ON sg.school_id = g.school_id AND sg.guardian_id = g.id
        WHERE g.school_id = $1 AND (g.id, sg.student_id) IN (
              SELECT * FROM unnest($2::uuid[], $3::uuid[]))`,
      [context.schoolId, pairs.map((row) => row.guardian_id), pairs.map((row) => row.student_id)],
    )
    for (const row of result.rows) {
      const name = [row.first_name, row.last_name ?? ''].map((part) => part.trim()).filter(Boolean).join(' ')
      if (name.length > 0) {
        guardians.set(`${row.guardian_id}:${row.student_id}`, { name: name.slice(0, 160), relation: row.relation })
      }
    }
  }

  return rows.map((row) => {
    const pupil = row.student_id ? pupils.get(row.student_id) : undefined
    const section = row.section_id ? sections.get(row.section_id) : undefined
    const guardian =
      row.guardian_id && row.student_id ? guardians.get(`${row.guardian_id}:${row.student_id}`) : undefined
    const base = {
      id: row.id,
      outcome: row.outcome,
      inApp: row.in_app,
      emailStatus: row.email_status,
      ...(row.email_masked === null ? {} : { emailMasked: row.email_masked }),
      ...(row.read_at === null ? {} : { readAt: row.read_at }),
      ...(pupil && row.student_id
        ? { pupil: { id: row.student_id, name: pupil.name, ...(section ? { section: section.label } : {}) } }
        : {}),
    }
    if (row.staff_id !== null) {
      return { ...base, kind: 'staff' as const, name: staffNames.get(row.staff_id) ?? 'Staff member' }
    }
    return {
      ...base,
      kind: 'guardian' as const,
      name: guardian?.name ?? 'Guardian',
      ...(guardian ? { relation: guardian.relation.slice(0, 40) } : {}),
    }
  })
}
