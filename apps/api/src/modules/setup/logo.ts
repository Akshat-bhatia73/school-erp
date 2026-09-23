import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { LOGO_MAX_BYTES } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { requireMembership } from '../../auth/guards.ts'
import { cleanPhoto } from '../../files/images.ts'
import type { DocumentFile, DocumentStorage } from '../../files/storage.ts'
import { reportError } from '../../observability.ts'
import {
  assertVersion,
  authorizeSchoolAction,
  bumpVersion,
  lockSchool,
  writeAudit,
  type ModuleDependencies,
  type TenantConnection,
} from '../shared/index.ts'

const PATH = '/api/schools/:schoolId/school/logo'

interface LogoRow {
  version: number
  logo_storage_key: string | null
  logo_content_type: string | null
}

function requireContext(request: FastifyRequest): RequestContext {
  const context = request.context
  if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
  return context
}

/** The version of the school profile the caller believes it is changing. */
function expectedVersion(request: FastifyRequest): number {
  const query = request.query as { expectedVersion?: unknown }
  const raw = query?.expectedVersion
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw new ApiFailure('INVALID_REQUEST')
  return Number(raw)
}

/** The upload body, which the scoped parser has already limited to 512 KB. */
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
 * A key nobody can guess and nobody can choose, never returned, logged or put
 * in a header. A replacement gets a fresh name.
 */
function logoKey(schoolId: string): string {
  return `logos/${schoolId}-${randomBytes(16).toString('hex')}`
}

async function loadLogoRow(conn: Pick<TenantConnection, 'client'>, schoolId: string): Promise<LogoRow> {
  const found = await conn.client.query<LogoRow>(
    'SELECT version, logo_storage_key, logo_content_type FROM schools WHERE id = $1',
    [schoolId],
  )
  const row = found.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

/**
 * The logo's bytes for the report card file, or null when the school has
 * none. The caller has already decided what it is producing.
 */
export async function readLogo(
  conn: Pick<TenantConnection, 'client'>,
  documents: DocumentStorage,
  schoolId: string,
): Promise<{ bytes: Uint8Array; contentType: 'image/png' | 'image/jpeg' } | null> {
  const row = await loadLogoRow(conn, schoolId)
  if (row.logo_storage_key === null) return null
  const contentType = row.logo_content_type
  if (contentType !== 'image/png' && contentType !== 'image/jpeg') return null
  const file = await documents.read(row.logo_storage_key)
  if (!file) return null
  const chunks: Buffer[] = []
  for await (const chunk of asNodeStream(file)) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array))
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks)), contentType }
}

/**
 * The school logo (Task 21), printed on report cards. The bytes live in the
 * private document store and are served only by the route below. Nothing an
 * upload claims about itself is trusted: the type comes from its first bytes
 * and the picture is rewritten without its description blocks. Only PNG and
 * JPEG are kept, because the PDF library cannot draw a WebP.
 */
export function registerSchoolLogoRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      /^image\//,
      { parseAs: 'buffer', bodyLimit: LOGO_MAX_BYTES },
      (_request, body, done) => done(null, body),
    )

    // An upload that says up front it is too big is answered before a byte
    // of it is read.
    scope.addHook('onRequest', async (request, reply) => {
      if (request.method !== 'PUT') return
      const declared = Number(request.headers['content-length'] ?? '0')
      if (!Number.isFinite(declared) || declared <= LOGO_MAX_BYTES) return
      await reply.status(413).send({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Choose a logo smaller than 512 KB.',
          requestId: request.id,
        },
      })
    })

    scope.put(PATH, { preHandler: requireMembership(deps), bodyLimit: LOGO_MAX_BYTES }, async (request, reply) => {
      const context = requireContext(request)
      const version = expectedVersion(request)
      const checked = cleanPhoto(uploadedBytes(request))
      if (!checked.ok || (checked.image.contentType !== 'image/png' && checked.image.contentType !== 'image/jpeg')) {
        request.log.warn({ requestId: request.id, reason: checked.ok ? 'not png or jpeg' : checked.reason }, 'logo refused')
        throw new ApiFailure('INVALID_REQUEST')
      }
      const image = checked.image

      const written: { key: string | null } = { key: null }
      let previous: string | null = null
      try {
        previous = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
          await lockSchool(conn, context.schoolId)
          await authorizeSchoolAction(conn, context, 'school.update')
          const row = await loadLogoRow(conn, context.schoolId)
          assertVersion(version, row.version)
          const key = logoKey(context.schoolId)
          await deps.documents.write(key, image.bytes, image.contentType)
          written.key = key
          await bumpVersion(conn, 'schools', {
            schoolId: context.schoolId,
            id: context.schoolId,
            expectedVersion: version,
            set: {
              logo_storage_key: key,
              logo_content_type: image.contentType,
              logo_updated_at: new Date(),
            },
          })
          await writeAudit(conn, context, {
            action: 'school.update',
            targetType: 'school',
            targetId: context.schoolId,
            summary: 'Set the school logo.',
            safeChanges: { logo: row.logo_storage_key === null ? 'added' : 'replaced' },
          })
          return row.logo_storage_key
        })
      } catch (error) {
        // The row still names whatever it named before.
        if (written.key !== null) await removeQuietly(deps, request, written.key)
        throw error
      }
      if (previous !== null) await removeQuietly(deps, request, previous)
      return reply.status(204).send()
    })

    scope.delete(PATH, { preHandler: requireMembership(deps) }, async (request, reply) => {
      const context = requireContext(request)
      const version = expectedVersion(request)
      const previous = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'school.update')
        const row = await loadLogoRow(conn, context.schoolId)
        if (row.logo_storage_key === null) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await bumpVersion(conn, 'schools', {
          schoolId: context.schoolId,
          id: context.schoolId,
          expectedVersion: version,
          set: { logo_storage_key: null, logo_content_type: null, logo_updated_at: null },
        })
        await writeAudit(conn, context, {
          action: 'school.update',
          targetType: 'school',
          targetId: context.schoolId,
          summary: 'Removed the school logo.',
          safeChanges: { logo: 'removed' },
        })
        return row.logo_storage_key
      })
      await removeQuietly(deps, request, previous)
      return reply.status(204).send()
    })

    /**
     * The bytes, for every role: a teacher and a parent see the logo on a
     * card. holidays.read is the floor every role holds, the same one
     * /academic-years/current uses. No audit row: a logo is not about anybody.
     */
    scope.get(PATH, { preHandler: requireMembership(deps) }, async (request, reply) => {
      const context = requireContext(request)
      const logo = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'holidays.read')
        const row = await loadLogoRow(conn, context.schoolId)
        if (row.logo_storage_key === null || row.logo_content_type === null) {
          throw new ApiFailure('RESOURCE_NOT_FOUND')
        }
        const bytes = await deps.documents.read(row.logo_storage_key)
        if (!bytes) throw new ApiFailure('RESOURCE_NOT_FOUND')
        return { bytes, contentType: row.logo_content_type }
      })
      return sendLogo(reply, logo.bytes, logo.contentType)
    })
  })
}

function sendLogo(reply: FastifyReply, file: DocumentFile, contentType: string): FastifyReply {
  return reply
    .header('content-type', contentType)
    .header('content-length', String(file.sizeBytes))
    .header('content-disposition', 'inline; filename="logo"')
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', 'private, no-store')
    .send(asNodeStream(file))
}

/** Bytes nothing points at any more; a store that cannot be reached is reported, not fatal. */
async function removeQuietly(deps: ModuleDependencies, request: FastifyRequest, key: string): Promise<void> {
  try {
    await deps.documents.remove(key)
  } catch (error) {
    request.log.warn({ err: error }, 'a logo could not be removed from the store')
    reportError(new Error('a logo could not be removed from the store'), {
      requestId: request.id,
      route: request.routeOptions.url,
    })
  }
}
