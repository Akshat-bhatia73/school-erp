import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ASSISTANT_KEEP_DAYS,
  AssistantThread,
  AssistantThreadList,
  CreateAssistantThreadResponse,
  type AssistantStoredMessage,
  type AssistantThreadSummary,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { open, seal } from '../modules/shared/crypto.ts'
import { assertUuidParam, requireFound } from '../modules/shared/errors.ts'
import { writeAudit, type TenantConnection } from '../modules/shared/audit.ts'
import { protectedRoute, type ModuleDependencies } from '../modules/shared/route.ts'

/**
 * A conversation is its owner's alone. Every query here names the caller's
 * own membership as well as the school, so another person's thread, the
 * owner's included, answers exactly like one that does not exist.
 */

/** Shown for a conversation that has no question in it yet. */
export const NEW_THREAD_TITLE = 'New chat'
const TITLE_LENGTH = 60

/** The first words of the first question, on one line. */
export function titleFrom(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim()
  if (line.length <= TITLE_LENGTH) return line
  return `${line.slice(0, TITLE_LENGTH).trimEnd()}…`
}

/** A kept message as the AI SDK's UI message: id, role and parts. */
export interface KeptMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly parts: readonly Record<string, unknown>[]
}

interface ThreadRow {
  id: string
  title_sealed: string | null
  created_at: string
  last_message_at: string
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

export async function ownThread(
  conn: Pick<TenantConnection, 'client'>,
  context: RequestContext,
  threadId: string,
): Promise<ThreadRow | null> {
  const found = await conn.client.query<ThreadRow>(
    `SELECT id, title_sealed,
            to_char(created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at,
            to_char(last_message_at AT TIME ZONE 'UTC', ${ISO}) AS last_message_at
       FROM assistant_threads
      WHERE school_id = $1 AND membership_id = $2 AND id = $3`,
    [context.schoolId, context.membershipId, threadId],
  )
  return found.rows[0] ?? null
}

function titleOf(row: ThreadRow, key: string): string {
  return row.title_sealed === null ? NEW_THREAD_TITLE : open(row.title_sealed, key)
}

function summaryOf(row: ThreadRow, key: string): AssistantThreadSummary {
  return { id: row.id, title: titleOf(row, key), createdAt: row.created_at, lastMessageAt: row.last_message_at }
}

/** The thread's kept messages, oldest first; `limit` keeps only the newest ones. */
export async function keptMessages(
  conn: Pick<TenantConnection, 'client'>,
  context: RequestContext,
  threadId: string,
  key: string,
  limit = 400,
): Promise<(KeptMessage & { readonly createdAt: string })[]> {
  const found = await conn.client.query<{ content_sealed: string; created_text: string }>(
    `SELECT content_sealed, to_char(created_at AT TIME ZONE 'UTC', ${ISO}) AS created_text FROM (
       SELECT content_sealed, created_at, id
         FROM assistant_messages
        WHERE school_id = $1 AND membership_id = $2 AND thread_id = $3
        ORDER BY created_at DESC, id DESC
        LIMIT $4) AS newest
      ORDER BY newest.created_at, newest.id`,
    [context.schoolId, context.membershipId, threadId, limit],
  )
  return found.rows.map((row) => {
    const message = JSON.parse(open(row.content_sealed, key)) as KeptMessage
    return { id: message.id, role: message.role, parts: message.parts, createdAt: row.created_text }
  })
}

/** Seal and keep one message. The whole UI message is sealed: words, tool calls and results. */
export async function keepMessage(
  conn: Pick<TenantConnection, 'client'>,
  context: RequestContext,
  threadId: string,
  message: KeptMessage,
  key: string,
): Promise<void> {
  await conn.client.query(
    `INSERT INTO assistant_messages (school_id, thread_id, membership_id, message_key, role, content_sealed)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      context.schoolId,
      threadId,
      context.membershipId,
      message.id,
      message.role,
      seal(JSON.stringify({ id: message.id, role: message.role, parts: message.parts }), key),
    ],
  )
  await conn.client.query(
    `UPDATE assistant_threads SET last_message_at = now()
      WHERE school_id = $1 AND membership_id = $2 AND id = $3`,
    [context.schoolId, context.membershipId, threadId],
  )
}

export function registerAssistantThreadRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  const key = deps.config.DATA_ENCRYPTION_KEY

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/assistant/threads',
    permission: 'ai_assistant.use',
    response: AssistantThreadList,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A conversation shows while it still holds a message younger than
        // the keeping period; the sweep removes the rest.
        const found = await conn.client.query<ThreadRow>(
          `SELECT t.id, t.title_sealed,
                  to_char(t.created_at AT TIME ZONE 'UTC', ${ISO}) AS created_at,
                  to_char(t.last_message_at AT TIME ZONE 'UTC', ${ISO}) AS last_message_at
             FROM assistant_threads t
            WHERE t.school_id = $1 AND t.membership_id = $2
              AND EXISTS (
                SELECT 1 FROM assistant_messages m
                 WHERE m.school_id = t.school_id AND m.thread_id = t.id
                   AND m.created_at > now() - make_interval(days => $3))
            ORDER BY t.last_message_at DESC, t.id
            LIMIT 500`,
          [context.schoolId, context.membershipId, ASSISTANT_KEEP_DAYS],
        )
        return { items: found.rows.map((row) => summaryOf(row, key)) }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/assistant/threads',
    permission: 'ai_assistant.use',
    response: CreateAssistantThreadResponse,
    successStatus: 201,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const created = await conn.client.query<{ id: string }>(
          `INSERT INTO assistant_threads (school_id, membership_id) VALUES ($1, $2) RETURNING id`,
          [context.schoolId, context.membershipId],
        )
        return { id: requireFound(created.rows[0]).id }
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/assistant/threads/:threadId',
    permission: 'ai_assistant.use',
    response: AssistantThread,
    handler: async ({ context, param }) => {
      const threadId = assertUuidParam(param('threadId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const row = requireFound(await ownThread(conn, context, threadId))
        const messages: AssistantStoredMessage[] = (await keptMessages(conn, context, threadId, key)).map(
          (message) => ({
            id: message.id,
            role: message.role,
            parts: message.parts.map((part) => ({ ...part, type: String(part.type) })),
            createdAt: message.createdAt,
          }),
        )
        return { ...summaryOf(row, key), messages }
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/assistant/threads/:threadId',
    permission: 'ai_assistant.use',
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, param }) => {
      const threadId = assertUuidParam(param('threadId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const removed = await conn.client.query(
          `DELETE FROM assistant_threads WHERE school_id = $1 AND membership_id = $2 AND id = $3`,
          [context.schoolId, context.membershipId, threadId],
        )
        if (removed.rowCount === 0) requireFound(null)
        // The messages go with the thread. The row names the thread and
        // nothing that was said in it.
        await writeAudit(conn, context, {
          action: 'ai_assistant.use',
          targetType: 'assistant_thread',
          targetId: threadId,
          summary: 'Deleted an assistant conversation.',
        })
        return null
      })
    },
  })
}
