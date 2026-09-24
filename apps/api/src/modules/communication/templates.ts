import type { FastifyInstance } from 'fastify'
import {
  ArchiveMessageTemplateRequest,
  CreateMessageTemplateRequest,
  MessageTemplate,
  MessageTemplateList,
  MessageTemplateQuery,
  UpdateMessageTemplateRequest,
  unknownPlaceholders,
  type MessageKind,
  type PermissionKey,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import {
  allowedActionsFor,
  allowedActionsForMany,
  ApiFailure,
  assertUuidParam,
  authorizeSchoolAction,
  bumpVersion,
  decideResource,
  lockSchool,
  protectedRoute,
  requireFound,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { refusedAsMissing, type MessageConnection } from './shared-reads.ts'

/**
 * The school's own wording: notice templates a sender may start from, and
 * one live template per automatic kind that replaces the built-in words. A
 * template is never deleted, only archived, so a message can always say
 * which template it came from.
 */

type TemplateRow = {
  id: string
  kind: MessageKind
  name: string
  title: string
  body: string
  archived: boolean
  version: number
}

const TEMPLATE_COLUMNS = 'id, kind, name, title, body, archived_at IS NOT NULL AS archived, version'

function project(row: TemplateRow, actions: readonly PermissionKey[]): MessageTemplate {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    title: row.title,
    body: row.body,
    archived: row.archived,
    version: Number(row.version),
    allowedActions: [...actions],
  }
}

/** Placeholders the kind cannot fill are refused when the template is saved, never left in a message. */
function assertPlaceholders(kind: MessageKind, title: string, body: string): void {
  if (unknownPlaceholders(`${title}\n${body}`, kind).length > 0) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'message_placeholder_unknown')
  }
}

async function loadTemplate(conn: MessageConnection, schoolId: string, id: string): Promise<TemplateRow> {
  const result = await conn.client.query<TemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS} FROM message_templates WHERE school_id = $1 AND id = $2`,
    [schoolId, id],
  )
  return requireFound(result.rows[0])
}

async function readTemplate(conn: MessageConnection, context: RequestContext, id: string): Promise<MessageTemplate> {
  const row = await loadTemplate(conn, context.schoolId, id)
  const actions = await allowedActionsFor(conn, context, {
    schoolId: context.schoolId,
    resourceType: 'communication',
    id,
  })
  return project(row, actions)
}

/** A template is the school's: decided under manage on its own id, which only the school scope reaches. */
async function decideTemplate(conn: MessageConnection, context: RequestContext, id: string): Promise<TemplateRow> {
  const decision = await decideResource(conn, context, 'communication.manage', 'communication', id)
  if (!decision.allowed) throw refusedAsMissing(decision.code)
  return loadTemplate(conn, context.schoolId, id)
}

export function registerMessageTemplateRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/messages/templates',
    permission: 'communication.send',
    query: MessageTemplateQuery,
    response: MessageTemplateList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const show =
          query.show === 'live' ? 'AND archived_at IS NULL' : query.show === 'archived' ? 'AND archived_at IS NOT NULL' : ''
        const result = await conn.client.query<TemplateRow>(
          `SELECT ${TEMPLATE_COLUMNS} FROM message_templates
            WHERE school_id = $1 AND ($2::text IS NULL OR kind = $2) ${show}
            ORDER BY kind, archived_at DESC NULLS FIRST, lower(name), id
            LIMIT 200`,
          [context.schoolId, query.kind ?? null],
        )
        const rows = result.rows
        const actions = await allowedActionsForMany(conn, context, 'communication', rows.map((row) => row.id))
        return { items: rows.map((row) => project(row, actions.get(row.id) ?? [])) }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages/templates',
    permission: 'communication.manage',
    body: CreateMessageTemplateRequest,
    response: MessageTemplate,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'communication.manage')
        assertPlaceholders(body.kind, body.title, body.body)

        // An automatic kind has one live wording: the new one replaces the
        // old in the same write.
        let replaced = 0
        if (body.kind !== 'notice') {
          const archived = await conn.client.query(
            `UPDATE message_templates SET archived_at = now(), version = version + 1, updated_at = now()
              WHERE school_id = $1 AND kind = $2 AND archived_at IS NULL`,
            [context.schoolId, body.kind],
          )
          replaced = archived.rowCount ?? 0
        }
        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO message_templates (school_id, kind, name, title, body, created_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [context.schoolId, body.kind, body.name, body.title, body.body, context.membershipId],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'communication.manage',
          targetType: 'communication',
          targetId: id,
          summary: 'Saved a message template.',
          safeChanges: { templateId: id, kind: body.kind, replaced },
        })
        return readTemplate(conn, context, id)
      }),
  })

  protectedRoute(app, deps, {
    method: 'PATCH',
    path: '/api/schools/:schoolId/messages/templates/:templateId',
    permission: 'communication.manage',
    body: UpdateMessageTemplateRequest,
    response: MessageTemplate,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('templateId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const row = await decideTemplate(conn, context, id)
        if (row.archived) throw new ApiFailure('INVALID_REQUEST', undefined, 'message_template_archived')
        assertPlaceholders(row.kind, body.title ?? row.title, body.body ?? row.body)

        const set: Record<string, string> = {}
        if (body.name !== undefined) set.name = body.name
        if (body.title !== undefined) set.title = body.title
        if (body.body !== undefined) set.body = body.body
        await bumpVersion(conn, 'message_templates', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set,
        })
        await writeAudit(conn, context, {
          action: 'communication.manage',
          targetType: 'communication',
          targetId: id,
          summary: 'Changed a message template.',
          safeChanges: { templateId: id, kind: row.kind, changed: Object.keys(set) },
        })
        return readTemplate(conn, context, id)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/messages/templates/:templateId/archive',
    permission: 'communication.manage',
    body: ArchiveMessageTemplateRequest,
    response: MessageTemplate,
    handler: async ({ context, body, param }) => {
      const id = assertUuidParam(param('templateId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        const row = await decideTemplate(conn, context, id)
        if (row.archived) throw new ApiFailure('INVALID_REQUEST', undefined, 'message_template_archived')
        // For an automatic kind this puts the built-in wording back.
        await bumpVersion(conn, 'message_templates', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: { archived_at: new Date() },
        })
        await writeAudit(conn, context, {
          action: 'communication.manage',
          targetType: 'communication',
          targetId: id,
          summary: 'Archived a message template.',
          safeChanges: { templateId: id, kind: row.kind },
        })
        return readTemplate(conn, context, id)
      })
    },
  })
}
