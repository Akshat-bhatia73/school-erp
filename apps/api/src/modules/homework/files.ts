import { randomBytes } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  HOMEWORK_ATTACHMENT_MAX_BYTES,
  HOMEWORK_ATTACHMENT_TYPES,
  HOMEWORK_ATTACHMENTS_MAX,
  HomeworkAttachmentRemoveRequest,
  HomeworkAttachmentUploadQuery,
  HomeworkDetail,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { requireMembership } from '../../auth/guards.ts'
import { cleanPhoto, sniffImageType } from '../../files/images.ts'
import {
  ApiFailure,
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
import { cleanFileName, removeStoredFiles, sendFile } from '../communication/attachments.ts'
import {
  assertNotRemoved,
  decideHomework,
  homeworkReadPlans,
  itemMatches,
  readItemRow,
  type HomeworkConnection,
} from './common.ts'
import { readHomeworkDetail } from './reads.ts'

/**
 * The files an item carries: up to HOMEWORK_ATTACHMENTS_MAX PDF, JPEG or PNG
 * files of 4 MB each, in the private document store exactly as a message's
 * files are. Adding or removing one is homework.set on the item and bumps its
 * version. The bytes are served only by the byte route below, which decides
 * the item again for every request, so a family never downloads a file of a
 * removed item or of another class's.
 */

const COLLECTION = '/api/schools/:schoolId/homework/:homeworkId/attachments'
const ONE = `${COLLECTION}/:attachmentId`

type AttachmentType = (typeof HOMEWORK_ATTACHMENT_TYPES)[number]

function requireContext(request: FastifyRequest): RequestContext {
  const context = request.context
  if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
  return context
}

function pathId(request: FastifyRequest, name: 'homeworkId' | 'attachmentId'): string {
  const params = request.params as Record<string, string | undefined>
  return assertUuidParam(params[name] ?? '')
}

/** The version and the file name from the query string, through the contract. */
function uploadQuery(request: FastifyRequest): { expectedVersion: number; fileName: string } {
  const raw = (request.query ?? {}) as Record<string, unknown>
  const version = raw.expectedVersion
  const parsed = HomeworkAttachmentUploadQuery.safeParse({
    ...raw,
    expectedVersion: typeof version === 'string' && /^\d{1,9}$/.test(version) ? Number(version) : Number.NaN,
  })
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  return parsed.data
}

/**
 * What the bytes are, from their first bytes and never from the upload's own
 * claim; a picture is rewritten without its description blocks. The reason
 * for a refusal stays in the server's log.
 */
function checkFile(
  bytes: Uint8Array,
): { ok: true; bytes: Uint8Array; contentType: AttachmentType } | { ok: false; reason: string } {
  if (bytes.length === 0) return { ok: false, reason: 'the upload is empty' }
  const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1')
  if (head === '%PDF-') return { ok: true, bytes, contentType: 'application/pdf' }
  const image = sniffImageType(bytes)
  if (image !== 'image/jpeg' && image !== 'image/png') return { ok: false, reason: 'not a PDF, JPEG or PNG file' }
  const cleaned = cleanPhoto(bytes, HOMEWORK_ATTACHMENT_MAX_BYTES)
  if (!cleaned.ok) return { ok: false, reason: cleaned.reason }
  const contentType = cleaned.image.contentType
  if (contentType !== 'image/jpeg' && contentType !== 'image/png') return { ok: false, reason: 'unexpected picture type' }
  return { ok: true, bytes: cleaned.image.bytes, contentType }
}

/** A key nobody can guess and nobody can choose. Server state: never returned, logged or put in a header. */
function attachmentKey(schoolId: string, homeworkId: string): string {
  return `homework/${schoolId}/${homeworkId}/${randomBytes(16).toString('hex')}`
}

/** Files change with homework.set on a live item, at the version the caller read. */
async function decideForFiles(
  conn: HomeworkConnection,
  context: RequestContext,
  homeworkId: string,
  expectedVersion: number,
) {
  await decideHomework(conn, context, 'homework.set', homeworkId)
  const row = await readItemRow(conn, context.schoolId, homeworkId, { forUpdate: true })
  assertNotRemoved(row)
  assertVersion(expectedVersion, row.version)
  return row
}

export function registerHomeworkFileRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  // The parser lives inside this plugin, so only these routes accept a file
  // body at all, and the limit is applied before anything is read into memory.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      [...HOMEWORK_ATTACHMENT_TYPES],
      { parseAs: 'buffer', bodyLimit: HOMEWORK_ATTACHMENT_MAX_BYTES },
      (_request, body, done) => done(null, body),
    )

    // An upload that says up front that it is too big is answered before a
    // byte of it is read. A body that understates its length still meets the
    // parser's limit.
    scope.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'POST') return
      const declared = Number(request.headers['content-length'] ?? '0')
      if (!Number.isFinite(declared) || declared <= HOMEWORK_ATTACHMENT_MAX_BYTES) return
      await reply.status(413).send({
        error: {
          code: 'INVALID_REQUEST',
          reason: 'homework_attachment_too_large',
          message: 'A file can be up to 4 MB.',
          requestId: request.id,
        },
      })
    })

    scope.post(
      COLLECTION,
      { preHandler: requireMembership(deps), bodyLimit: HOMEWORK_ATTACHMENT_MAX_BYTES },
      async (request, reply) => {
        const context = requireContext(request)
        const homeworkId = pathId(request, 'homeworkId')
        const query = uploadQuery(request)
        const body = request.body
        if (!Buffer.isBuffer(body) || body.length === 0) throw new ApiFailure('INVALID_REQUEST')
        if (body.length > HOMEWORK_ATTACHMENT_MAX_BYTES) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'homework_attachment_too_large')
        }
        const checked = checkFile(new Uint8Array(body))
        if (!checked.ok) {
          request.log.warn({ requestId: request.id, reason: checked.reason }, 'homework file refused')
          throw new ApiFailure('INVALID_REQUEST', undefined, 'homework_attachment_type')
        }
        const fileName = cleanFileName(query.fileName)

        // Nothing is stored until the caller has been allowed to change this
        // exact item. A holder, so the cleanup sees the key the transaction
        // wrote.
        const written: { key: string | null } = { key: null }
        let detail: unknown
        try {
          detail = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
            await authorizeSchoolAction(conn, context, 'homework.set')
            await lockSchool(conn, context.schoolId)
            const row = await decideForFiles(conn, context, homeworkId, query.expectedVersion)
            const count = await conn.client.query<{ count: number }>(
              'SELECT count(*)::int AS count FROM homework_attachments WHERE school_id = $1 AND homework_id = $2',
              [context.schoolId, homeworkId],
            )
            if (Number(count.rows[0]?.count ?? 0) >= HOMEWORK_ATTACHMENTS_MAX) {
              throw new ApiFailure('INVALID_REQUEST', undefined, 'homework_too_many_attachments')
            }

            const key = attachmentKey(context.schoolId, homeworkId)
            await deps.documents.write(key, checked.bytes, checked.contentType)
            written.key = key
            const inserted = await conn.client.query<{ id: string }>(
              `INSERT INTO homework_attachments (school_id, homework_id, file_name, content_type, size_bytes, storage_key,
                                                 created_by_membership_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
              [context.schoolId, homeworkId, fileName, checked.contentType, checked.bytes.length, key, context.membershipId],
            )
            const attachmentId = requireFound(inserted.rows[0]).id
            await bumpVersion(conn, 'homework', {
              schoolId: context.schoolId,
              id: homeworkId,
              expectedVersion: query.expectedVersion,
              set: { updated_by_membership_id: context.membershipId },
            })
            await writeAudit(conn, context, {
              action: 'homework.set',
              targetType: 'homework',
              targetId: homeworkId,
              summary: 'Attached a file to homework.',
              safeChanges: {
                sectionId: row.section_id,
                subjectId: row.subject_id,
                attachmentId,
                contentType: checked.contentType,
                sizeBytes: checked.bytes.length,
              },
            })
            return readHomeworkDetail(conn, context, homeworkId)
          })
        } catch (error) {
          // The transaction kept no row naming these bytes, so they belong to nobody.
          if (written.key !== null) await removeStoredFiles(deps, request, [written.key])
          throw error
        }
        const answer = HomeworkDetail.safeParse(detail)
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
      permission: 'homework.set',
      query: HomeworkAttachmentRemoveRequest,
      response: HomeworkDetail,
      handler: async ({ context, query, param, request }) => {
        const homeworkId = assertUuidParam(param('homeworkId'))
        const attachmentId = assertUuidParam(param('attachmentId'))
        const outcome = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
          await lockSchool(conn, context.schoolId)
          const row = await decideForFiles(conn, context, homeworkId, query.expectedVersion)
          const removed = await conn.client.query<{ storage_key: string }>(
            `DELETE FROM homework_attachments WHERE school_id = $1 AND homework_id = $2 AND id = $3
             RETURNING storage_key`,
            [context.schoolId, homeworkId, attachmentId],
          )
          const key = requireFound(removed.rows[0]).storage_key
          await bumpVersion(conn, 'homework', {
            schoolId: context.schoolId,
            id: homeworkId,
            expectedVersion: query.expectedVersion,
            set: { updated_by_membership_id: context.membershipId },
          })
          await writeAudit(conn, context, {
            action: 'homework.set',
            targetType: 'homework',
            targetId: homeworkId,
            summary: 'Removed a file from homework.',
            safeChanges: { sectionId: row.section_id, subjectId: row.subject_id, attachmentId },
          })
          return { key, detail: await readHomeworkDetail(conn, context, homeworkId) }
        })
        // Only after the commit: the row no longer names these bytes.
        if (outcome.key !== '') await removeStoredFiles(deps, request, [outcome.key])
        return outcome.detail
      },
    })

    /**
     * The bytes. This route streams, so it repeats by hand what the shared
     * route helper does: the aggregate gate first, then the item decided
     * again exactly as its detail read decides it, through the same plan. A
     * file of an item the caller may not read answers like one that does not
     * exist.
     */
    scope.get(ONE, { preHandler: requireMembership(deps) }, async (request, reply) => {
      const context = requireContext(request)
      const homeworkId = pathId(request, 'homeworkId')
      const attachmentId = pathId(request, 'attachmentId')

      const file = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'homework.read')
        await decideHomework(conn, context, 'homework.read', homeworkId)
        // Through the same plan as the detail read: a family never reads a removed item.
        const plans = await homeworkReadPlans(conn, context)
        if (!(await itemMatches(conn, context.schoolId, homeworkId, plans.items))) {
          throw new ApiFailure('RESOURCE_NOT_FOUND')
        }
        const found = await conn.client.query<{ file_name: string; content_type: string; storage_key: string }>(
          `SELECT file_name, content_type, storage_key FROM homework_attachments
            WHERE school_id = $1 AND homework_id = $2 AND id = $3`,
          [context.schoolId, homeworkId, attachmentId],
        )
        const row = requireFound(found.rows[0])
        if (row.storage_key === '') throw new ApiFailure('RESOURCE_NOT_FOUND')
        // The storage key is read here and never returned, logged or put in a header.
        const bytes = await deps.documents.read(row.storage_key)
        if (!bytes) throw new ApiFailure('RESOURCE_NOT_FOUND')
        return { bytes, contentType: row.content_type, fileName: row.file_name }
      })

      return sendFile(reply, file.bytes, file.contentType, file.fileName)
    })
  })
}
