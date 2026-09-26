import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  ASSISTANT_KEEP_DAYS,
  AssistantThread,
  AssistantThreadList,
  CreateAssistantThreadResponse,
  type AssistantStoredMessage,
  type AssistantThreadSummary,
  type PermissionKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { open, seal } from '../modules/shared/crypto.ts'
import { assertUuidParam, requireFound } from '../modules/shared/errors.ts'
import { writeAudit, type TenantConnection } from '../modules/shared/audit.ts'
import { protectedRoute, type ModuleDependencies } from '../modules/shared/route.ts'
import { isOffered, toolsFor } from './tools/registry.ts'
import type { AnyReadTool } from './tools/types.ts'
import { proposeToolsFor } from './proposals/registry.ts'
import type { AnyProposeTool } from './proposals/types.ts'

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

/** Tests only: the tools on offer in place of the registries'. */
export interface ToolOverrides {
  readonly assistantTools?: readonly AnyReadTool[]
  readonly assistantProposeTools?: readonly AnyProposeTool[]
}

/** The read tools this person is offered: those whose keys they hold somewhere. */
export function offeredTools(deps: ToolOverrides, capabilities: ReadonlySet<PermissionKey>): readonly AnyReadTool[] {
  if (deps.assistantTools) return deps.assistantTools.filter((tool) => isOffered(tool, capabilities))
  return toolsFor(capabilities)
}

/** The change tools this person is offered: those whose write permission they hold somewhere. */
export function offeredProposeTools(
  deps: ToolOverrides,
  capabilities: ReadonlySet<PermissionKey>,
): readonly AnyProposeTool[] {
  if (deps.assistantProposeTools) return deps.assistantProposeTools.filter((tool) => capabilities.has(tool.permission))
  return proposeToolsFor(capabilities)
}

/** The names of every tool, read or change, this person is offered now. */
export function offeredToolNames(deps: ToolOverrides, capabilities: ReadonlySet<PermissionKey>): ReadonlySet<string> {
  return new Set([...offeredTools(deps, capabilities), ...offeredProposeTools(deps, capabilities)].map((tool) => tool.name))
}

/** What the model reads in place of an old result from a tool the person is no longer offered. */
export const HIDDEN_RESULT = 'This result is hidden because you no longer have access to it.'

/** The tool a UI message part called, or null for a part that is not a tool call. */
function toolNameOf(part: Record<string, unknown>): string | null {
  if (part.type === 'dynamic-tool') return typeof part.toolName === 'string' ? part.toolName : null
  return typeof part.type === 'string' && part.type.startsWith('tool-') ? part.type.slice('tool-'.length) : null
}

/**
 * The same messages with the result of every tool call to a tool this person
 * is no longer offered replaced by `hidden`. A result was read under the
 * permissions of the day it was asked; once a permission is gone, so is what
 * it showed, on the screen and in what the model reads again. The call itself
 * stays, so the conversation is still well formed.
 */
export function hideUnoffered<T extends Pick<KeptMessage, 'parts'>>(
  messages: readonly T[],
  offered: ReadonlySet<string>,
  hidden: unknown,
): T[] {
  return messages.map((message) => {
    let changed = false
    const parts = message.parts.map((part) => {
      const name = toolNameOf(part)
      if (name === null || offered.has(name) || !('output' in part)) return part
      changed = true
      return { ...part, output: hidden }
    })
    return changed ? { ...message, parts } : message
  })
}

export function registerAssistantThreadRoutes(app: FastifyInstance, deps: ModuleDependencies & ToolOverrides): void {
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
      const offered = offeredToolNames(deps, new Set(await deps.authz.capabilities(context)))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const row = requireFound(await ownThread(conn, context, threadId))
        // An old card from a tool the person is no longer offered comes back
        // as "not available", which the screen draws as nothing.
        const kept = hideUnoffered(await keptMessages(conn, context, threadId, key), offered, { status: 'not_available' })
        const messages: AssistantStoredMessage[] = kept.map(
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
