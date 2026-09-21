import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PHOTO_MAX_BYTES } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { requireMembership } from '../../auth/guards.ts'
import { cleanPhoto } from '../../files/images.ts'
import type { DocumentFile } from '../../files/storage.ts'
import { reportError } from '../../observability.ts'
import {
  assertVersion,
  authorizeResource,
  authorizeSchoolAction,
  decideResource,
  lockSchool,
  writeAudit,
  bumpVersion,
  type ModuleDependencies,
  type TenantConnection,
} from '../shared/index.ts'
import { recordId } from './reads.ts'

const PATH = '/api/schools/:schoolId/staff/:staffId/photo'

interface PhotoRow {
  version: number
  photo_storage_key: string | null
  photo_content_type: string | null
}

function requireContext(request: FastifyRequest): RequestContext {
  const context = request.context
  if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
  return context
}

function staffId(request: FastifyRequest): string {
  const params = request.params as { staffId?: string }
  return recordId(params.staffId ?? '')
}

/** The version the caller believes it is replacing, from the query string. */
function expectedVersion(request: FastifyRequest): number {
  const query = request.query as { expectedVersion?: unknown }
  const raw = query?.expectedVersion
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw new ApiFailure('INVALID_REQUEST')
  return Number(raw)
}

/** The upload body, which the scoped parser has already limited to 1 MB. */
function uploadedBytes(request: FastifyRequest): Uint8Array {
  const body = request.body
  if (!Buffer.isBuffer(body) || body.length === 0) throw new ApiFailure('INVALID_REQUEST')
  return new Uint8Array(body)
}

function asNodeStream(file: DocumentFile): NodeJS.ReadableStream {
  const stream = file.stream
  return stream instanceof ReadableStream
    ? Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0])
    : (stream as NodeJS.ReadableStream)
}

/**
 * A key nobody can guess and nobody can choose. It is server state: it is
 * never returned, logged or put in a header, and a replacement gets a fresh
 * random name so a cached copy of the old bytes cannot be fetched again.
 */
function photoKey(schoolId: string, id: string): string {
  return `photos/${schoolId}/staff/${id}-${randomBytes(16).toString('hex')}`
}

async function loadPhotoRow(
  conn: TenantConnection,
  schoolId: string,
  id: string,
): Promise<PhotoRow> {
  const found = await conn.client.query<PhotoRow>(
    `SELECT version, photo_storage_key, photo_content_type
       FROM staff WHERE school_id = $1 AND id = $2`,
    [schoolId, id],
  )
  const row = found.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

/**
 * Staff photographs (Task 16). The same rules as a student photograph: the
 * bytes live in the private document store, only the streaming route below
 * hands them over, and it decides the record again for every request. The
 * type comes from the first bytes of the file and the picture is rewritten
 * without its description blocks before anything is stored.
 */
export function registerStaffPhotoRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  // The parser is registered inside this plugin, so only these routes accept
  // an image body at all, and the limit is applied before anything is read
  // into memory.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      /^image\//,
      { parseAs: 'buffer', bodyLimit: PHOTO_MAX_BYTES },
      (_request, body, done) => done(null, body),
    )

    // An upload that says up front that it is too big is answered before a
    // byte of it is read, so a person sees a plain message instead of a
    // closed connection. A body that understates its own length still meets
    // the parser's limit below.
    scope.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'PUT') return
      const declared = Number(request.headers['content-length'] ?? '0')
      if (!Number.isFinite(declared) || declared <= PHOTO_MAX_BYTES) return
      await reply.status(413).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Choose a photo smaller than 1 MB.',
          requestId: request.id,
        },
      })
    })

    scope.put(
      PATH,
      { preHandler: requireMembership(deps), bodyLimit: PHOTO_MAX_BYTES },
      async (request, reply) => {
        const context = requireContext(request)
        const id = staffId(request)
        const version = expectedVersion(request)
        const checked = cleanPhoto(uploadedBytes(request))
        if (!checked.ok) {
          // Our own reason, never the caller's: the answer says only that the
          // request was invalid.
          request.log.warn({ requestId: request.id, reason: checked.reason }, 'photo refused')
          throw new ApiFailure('INVALID_REQUEST')
        }

        // Nothing is stored until the caller has been allowed to change this
        // exact record: a person who may not edit it, or an id that is not
        // here, never causes a write to the store.
        // A holder, so the cleanup below sees the key the transaction wrote.
        const written: { key: string | null } = { key: null }
        let previous: string | null = null
        try {
          previous = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
            await lockSchool(conn, context.schoolId)
            await authorizeResource(conn, context, 'staff.update_private', 'staff', id)
            const row = await loadPhotoRow(conn, context.schoolId, id)
            // The version the caller quoted, checked before the bytes are
            // written as well as in the update itself.
            assertVersion(version, row.version)
            const key = photoKey(context.schoolId, id)
            await deps.documents.write(key, checked.image.bytes, checked.image.contentType)
            written.key = key
            await bumpVersion(conn, 'staff', {
              schoolId: context.schoolId,
              id,
              expectedVersion: version,
              set: {
                photo_storage_key: key,
                photo_content_type: checked.image.contentType,
                photo_updated_at: new Date(),
              },
            })
            await writeAudit(conn, context, {
              action: 'staff.update_private',
              targetType: 'staff',
              targetId: id,
              summary: 'Set the staff photograph.',
              safeChanges: { photo: row.photo_storage_key === null ? 'added' : 'replaced' },
            })
            return row.photo_storage_key
          })
        } catch (error) {
          // The row still names whatever it named before, so any bytes that
          // were written belong to nobody.
          if (written.key !== null) await removeQuietly(deps, request, written.key)
          throw error
        }
        // Only after the commit: the row no longer names these bytes.
        if (previous !== null) await removeQuietly(deps, request, previous)
        return reply.status(204).send()
      },
    )

    scope.delete(PATH, { preHandler: requireMembership(deps) }, async (request, reply) => {
      const context = requireContext(request)
      const id = staffId(request)
      const version = expectedVersion(request)

      const previous = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeResource(conn, context, 'staff.update_private', 'staff', id)
        const row = await loadPhotoRow(conn, context.schoolId, id)
        // There is nothing to remove, and a record with no photograph answers
        // the same way to everyone who may edit it.
        if (row.photo_storage_key === null) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await bumpVersion(conn, 'staff', {
          schoolId: context.schoolId,
          id,
          expectedVersion: version,
          set: { photo_storage_key: null, photo_content_type: null, photo_updated_at: null },
        })
        await writeAudit(conn, context, {
          action: 'staff.update_private',
          targetType: 'staff',
          targetId: id,
          summary: 'Removed the staff photograph.',
          safeChanges: { photo: 'removed' },
        })
        return row.photo_storage_key
      })
      await removeQuietly(deps, request, previous)
      return reply.status(204).send()
    })

    /**
     * The bytes. This route streams, so it repeats by hand what the shared
     * route helper does: the aggregate gate first, then a fresh decision on
     * this exact record. A staff member the caller may not read answers
     * exactly like one that does not exist. Looking at a photograph is not an
     * event a school needs recorded, so no audit row is written.
     */
    scope.get(PATH, { preHandler: requireMembership(deps) }, async (request, reply) => {
      const context = requireContext(request)
      const id = staffId(request)

      const photo = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'staff.read_directory')
        const decision = await decideResource(conn, context, 'staff.read_directory', 'staff', id)
        if (!decision.allowed) {
          throw new ApiFailure(
            decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND',
          )
        }
        const row = await loadPhotoRow(conn, context.schoolId, id)
        if (row.photo_storage_key === null || row.photo_content_type === null) {
          throw new ApiFailure('RESOURCE_NOT_FOUND')
        }
        // The storage key is server state: read here, never returned, logged
        // or put in a header.
        const bytes = await deps.documents.read(row.photo_storage_key)
        if (!bytes) throw new ApiFailure('RESOURCE_NOT_FOUND')
        // The type is the record's own, set when the bytes were checked. The
        // store is asked for bytes only and never for what they are.
        return { bytes, contentType: row.photo_content_type }
      })

      return sendPhoto(reply, photo.bytes, photo.contentType)
    })
  })
}

/**
 * The response headers a photograph is served with. The name is neutral, so
 * nothing about the person is in a header, and the browser is told not to
 * reinterpret the type or keep a copy.
 */
function sendPhoto(reply: FastifyReply, file: DocumentFile, contentType: string): FastifyReply {
  return reply
    .header('content-type', contentType)
    .header('content-length', String(file.sizeBytes))
    .header('content-disposition', 'inline; filename="photo"')
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .send(asNodeStream(file))
}

/**
 * Bytes nothing points at any more. A store that cannot be reached must not
 * turn a finished write into a failure, so the request still answers, but the
 * leftover is not swallowed either: it is counted in the error reporter so
 * somebody can go and clear it. Neither the key nor the store's own message
 * is sent, because both can name a person's record.
 */
async function removeQuietly(
  deps: ModuleDependencies,
  request: FastifyRequest,
  key: string,
): Promise<void> {
  try {
    await deps.documents.remove(key)
  } catch (error) {
    request.log.warn({ err: error }, 'a photograph could not be removed from the store')
    reportError(new Error('a photograph could not be removed from the store'), {
      requestId: request.id,
      route: request.routeOptions.url,
    })
  }
}
