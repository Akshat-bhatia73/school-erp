import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  DeleteMessageRequest,
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_TYPES,
  MESSAGE_ATTACHMENTS_MAX,
  MessageAttachmentUploadQuery,
  MessageDetail,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { requireMembership } from '../../auth/guards.ts'
import { cleanPhoto, sniffImageType } from '../../files/images.ts'
import type { DocumentFile } from '../../files/storage.ts'
import { reportError } from '../../observability.ts'
import {
  assertUuidParam,
  assertVersion,
  authorizeSchoolAction,
  bumpVersion,
  lockSchool,
  protectedRoute,
  requireFound,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { auditFacts, decideMessage, readMessageDetail, type MessageConnection, type MessageRow } from './shared-reads.ts'

/**
 * The files a notice carries: up to three PDF, JPEG or PNG files of 2 MB
 * each, in the private document store exactly as a photograph is kept. They
 * are served only by the byte route below, which decides the message again
 * for every request, and they travel with the email.
 */

const COLLECTION = '/api/schools/:schoolId/messages/:messageId/attachments'
const ONE = `${COLLECTION}/:attachmentId`

type AttachmentType = (typeof MESSAGE_ATTACHMENT_TYPES)[number]

function requireContext(request: FastifyRequest): RequestContext {
  const context = request.context
  if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
  return context
}

function pathId(request: FastifyRequest, name: 'messageId' | 'attachmentId'): string {
  const params = request.params as Record<string, string | undefined>
  return assertUuidParam(params[name] ?? '')
}

/** The version and the file name from the query string, through the contract. */
function uploadQuery(request: FastifyRequest): { expectedVersion: number; fileName: string } {
  const raw = (request.query ?? {}) as Record<string, unknown>
  const version = raw.expectedVersion
  const parsed = MessageAttachmentUploadQuery.safeParse({
    ...raw,
    expectedVersion: typeof version === 'string' && /^\d{1,9}$/.test(version) ? Number(version) : Number.NaN,
  })
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  return parsed.data
}

/**
 * A name a person may see and a header may carry: no path, no control
 * characters, nothing that could end a header or climb a directory.
 */
function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[^\p{L}\p{N} ._()-]/gu, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned.length > 0 && !/^\.+$/.test(cleaned) ? cleaned : 'file'
}

/** The same name in the plain characters every browser's download header understands. */
function headerFileName(name: string): string {
  const ascii = name.replace(/[^A-Za-z0-9 ._()-]/g, '_').trim()
  return ascii.length > 0 ? ascii : 'file'
}

/**
 * What the bytes are, from their first bytes and never from the upload's own
 * claim; a picture is rewritten without its description blocks, as a
 * photograph is. The reason for a refusal stays in the server's log.
 */
function checkFile(
  bytes: Uint8Array,
): { ok: true; bytes: Uint8Array; contentType: AttachmentType } | { ok: false; reason: string } {
  if (bytes.length === 0) return { ok: false, reason: 'the upload is empty' }
  const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1')
  if (head === '%PDF-') return { ok: true, bytes, contentType: 'application/pdf' }
  const image = sniffImageType(bytes)
  if (image !== 'image/jpeg' && image !== 'image/png') return { ok: false, reason: 'not a PDF, JPEG or PNG file' }
  const cleaned = cleanPhoto(bytes, MESSAGE_ATTACHMENT_MAX_BYTES)
  if (!cleaned.ok) return { ok: false, reason: cleaned.reason }
  const contentType = cleaned.image.contentType
  if (contentType !== 'image/jpeg' && contentType !== 'image/png') return { ok: false, reason: 'unexpected picture type' }
  return { ok: true, bytes: cleaned.image.bytes, contentType }
}

/**
 * A key nobody can guess and nobody can choose. It is server state: never
 * returned, logged or put in a header.
 */
function attachmentKey(schoolId: string, messageId: string): string {
  return `messages/${schoolId}/${messageId}/${randomBytes(16).toString('hex')}`
}

/** Files are added and removed by the message's author, while it has not gone out. */
async function decideForFiles(
  conn: MessageConnection,
  context: RequestContext,
  messageId: string,
): Promise<MessageRow> {
  const row = await decideMessage(conn, context, 'communication.send', messageId, { forUpdate: true })
  if (row.status !== 'draft' && row.status !== 'scheduled') {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'message_not_editable')
  }
  if (row.created_by_membership_id !== context.membershipId) throw new ApiFailure('ACCESS_DENIED')
  return row
}

function asNodeStream(file: DocumentFile): NodeJS.ReadableStream {
  const stream = file.stream
  return stream instanceof ReadableStream
    ? Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0])
    : (stream as NodeJS.ReadableStream)
}

/**
 * Bytes nothing points at any more. A store that cannot be reached must not
 * turn a finished write into a failure, so the request still answers, but the
 * leftover is reported so somebody can clear it. Neither the key nor the
 * store's own message is sent anywhere.
 */
export async function removeStoredFiles(
  deps: Pick<ModuleDependencies, 'documents'>,
  request: FastifyRequest,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    try {
      await deps.documents.remove(key)
    } catch (error) {
      request.log.warn({ err: error }, 'a message file could not be removed from the store')
      reportError(new Error('a message file could not be removed from the store'), {
        requestId: request.id,
        route: request.routeOptions.url,
      })
    }
  }
}

export function registerMessageAttachmentRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  // The parser lives inside this plugin, so only these routes accept a file
  // body at all, and the limit is applied before anything is read into memory.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      [...MESSAGE_ATTACHMENT_TYPES],
      { parseAs: 'buffer', bodyLimit: MESSAGE_ATTACHMENT_MAX_BYTES },
      (_request, body, done) => done(null, body),
    )

    // An upload that says up front that it is too big is answered before a
    // byte of it is read. A body that understates its length still meets the
    // parser's limit.
    scope.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'POST') return
      const declared = Number(request.headers['content-length'] ?? '0')
      if (!Number.isFinite(declared) || declared <= MESSAGE_ATTACHMENT_MAX_BYTES) return
      await reply.status(413).send({
        error: { code: 'INVALID_REQUEST', message: 'A file can be at most 2 MB.', requestId: request.id },
      })
    })

    scope.post(
      COLLECTION,
      { preHandler: requireMembership(deps), bodyLimit: MESSAGE_ATTACHMENT_MAX_BYTES },
      async (request, reply) => {
        const context = requireContext(request)
        const messageId = pathId(request, 'messageId')
        const query = uploadQuery(request)
        const body = request.body
        if (!Buffer.isBuffer(body) || body.length === 0) throw new ApiFailure('INVALID_REQUEST')
        if (body.length > MESSAGE_ATTACHMENT_MAX_BYTES) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'message_attachment_too_large')
        }
        const checked = checkFile(new Uint8Array(body))
        if (!checked.ok) {
          request.log.warn({ requestId: request.id, reason: checked.reason }, 'message file refused')
          throw new ApiFailure('INVALID_REQUEST', undefined, 'message_attachment_type')
        }
        const fileName = cleanFileName(query.fileName)

        // Nothing is stored until the caller has been allowed to change this
        // exact message. A holder, so the cleanup sees the key the
        // transaction wrote.
        const written: { key: string | null } = { key: null }
        let detail: unknown
        try {
          detail = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
            await authorizeSchoolAction(conn, context, 'communication.send')
            await lockSchool(conn, context.schoolId)
            const row = await decideForFiles(conn, context, messageId)
            const count = await conn.client.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM message_attachments WHERE school_id = $1 AND message_id = $2',
              [context.schoolId, messageId],
            )
            if (Number(count.rows[0]?.count ?? 0) >= MESSAGE_ATTACHMENTS_MAX) {
              throw new ApiFailure('INVALID_REQUEST', undefined, 'message_too_many_attachments')
            }
            assertVersion(query.expectedVersion, row.version)

            const key = attachmentKey(context.schoolId, messageId)
            await deps.documents.write(key, checked.bytes, checked.contentType)
            written.key = key
            const inserted = await conn.client.query<{ id: string }>(
              `INSERT INTO message_attachments (school_id, message_id, file_name, content_type, size_bytes, storage_key)
               VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
              [context.schoolId, messageId, fileName, checked.contentType, checked.bytes.length, key],
            )
            const attachmentId = requireFound(inserted.rows[0]).id
            await bumpVersion(conn, 'messages', {
              schoolId: context.schoolId,
              id: messageId,
              expectedVersion: query.expectedVersion,
            })
            await writeAudit(conn, context, {
              action: 'communication.send',
              targetType: 'communication',
              targetId: messageId,
              summary: 'Attached a file to a message.',
              safeChanges: await auditFacts(conn, context.schoolId, row, {
                scheduled: row.status === 'scheduled',
                attachmentId,
                contentType: checked.contentType,
              }),
            })
            return readMessageDetail(conn, context, messageId)
          })
        } catch (error) {
          // The transaction kept no row naming these bytes, so they belong
          // to nobody.
          if (written.key !== null) await removeStoredFiles(deps, request, [written.key])
          throw error
        }
        const answer = MessageDetail.safeParse(detail)
        if (!answer.success) {
          request.log.error({ requestId: request.id, route: `POST ${COLLECTION}` }, 'response failed its contract')
          throw new ApiFailure('SERVICE_UNAVAILABLE')
        }
        return reply.status(200).send(answer.data)
      },
    )

    protectedRoute(scope, deps, {
      method: 'DELETE',
      path: ONE,
      permission: 'communication.send',
      query: DeleteMessageRequest,
      response: MessageDetail,
      handler: async ({ context, query, param, request }) => {
        const messageId = assertUuidParam(param('messageId'))
        const attachmentId = assertUuidParam(param('attachmentId'))
        const outcome = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
          await lockSchool(conn, context.schoolId)
          const row = await decideForFiles(conn, context, messageId)
          assertVersion(query.expectedVersion, row.version)
          const removed = await conn.client.query<{ storage_key: string }>(
            `DELETE FROM message_attachments WHERE school_id = $1 AND message_id = $2 AND id = $3
             RETURNING storage_key`,
            [context.schoolId, messageId, attachmentId],
          )
          const key = requireFound(removed.rows[0]).storage_key
          await bumpVersion(conn, 'messages', {
            schoolId: context.schoolId,
            id: messageId,
            expectedVersion: query.expectedVersion,
          })
          await writeAudit(conn, context, {
            action: 'communication.send',
            targetType: 'communication',
            targetId: messageId,
            summary: 'Removed a file from a message.',
            safeChanges: await auditFacts(conn, context.schoolId, row, {
              scheduled: row.status === 'scheduled',
              attachmentId,
            }),
          })
          return { key, detail: await readMessageDetail(conn, context, messageId) }
        })
        // Only after the commit: the row no longer names these bytes.
        await removeStoredFiles(deps, request, [outcome.key])
        return outcome.detail
      },
    })

    /**
     * The bytes. This route streams, so it repeats by hand what the shared
     * route helper does: the aggregate gate first, then the message decided
     * again exactly as its detail read decides it. A file of a message the
     * caller may not read answers like one that does not exist.
     */
    scope.get(ONE, { preHandler: requireMembership(deps) }, async (request, reply) => {
      const context = requireContext(request)
      const messageId = pathId(request, 'messageId')
      const attachmentId = pathId(request, 'attachmentId')

      const file = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'communication.read')
        await decideMessage(conn, context, 'communication.read', messageId)
        const found = await conn.client.query<{ file_name: string; content_type: string; storage_key: string }>(
          `SELECT file_name, content_type, storage_key FROM message_attachments
            WHERE school_id = $1 AND message_id = $2 AND id = $3`,
          [context.schoolId, messageId, attachmentId],
        )
        const row = requireFound(found.rows[0])
        // The storage key is read here and never returned, logged or put in a header.
        const bytes = await deps.documents.read(row.storage_key)
        if (!bytes) throw new ApiFailure('RESOURCE_NOT_FOUND')
        return { bytes, contentType: row.content_type, fileName: row.file_name }
      })

      return sendFile(reply, file.bytes, file.contentType, file.fileName)
    })
  })
}

/** A download: the type from the file's own row, its own name cleaned, never cached, never sniffed. */
function sendFile(reply: FastifyReply, file: DocumentFile, contentType: string, fileName: string): FastifyReply {
  return reply
    .header('content-type', contentType)
    .header('content-length', String(file.sizeBytes))
    .header('content-disposition', `attachment; filename="${headerFileName(fileName)}"`)
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .send(asNodeStream(file))
}
