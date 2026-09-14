import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  FilesDocumentParams,
  FilesExportJobParams,
  FilesExportJobSummary,
  PERMISSION_CATALOGUE,
  PermissionKey,
  type PermissionKey as PermissionKeyType,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { requireMembership } from '../../auth/guards.ts'
import { decideResource, authorizeSchoolAction } from '../shared/authorize.ts'
import { decideAction } from '../../memberships/authorize.ts'
import { writeAudit } from '../shared/audit.ts'
import type { ModuleDependencies } from '../shared/route.ts'
import type { DocumentFile } from '../../files/storage.ts'

/**
 * Identifiers in this module are database uuids, and the contract enforces
 * that shape. Any value that cannot be one is answered like a missing record:
 * no such row can exist, and every kind of malformed id gets the same answer
 * so nothing can be learned from the difference between two error codes.
 */
function documentParams(request: FastifyRequest): {
  studentId: string
  documentId: string
} {
  const parsed = FilesDocumentParams.safeParse(request.params)
  if (!parsed.success) throw new ApiFailure('RESOURCE_NOT_FOUND')
  const { studentId, documentId } = parsed.data
  return { studentId, documentId }
}

function jobParam(request: FastifyRequest): string {
  const parsed = FilesExportJobParams.safeParse(request.params)
  if (!parsed.success) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return parsed.data.jobId
}

/**
 * The export permissions that can produce a job today. The status route is
 * shared by all of them, so the floor it applies before touching a row is
 * "holds at least one of these somewhere in the school"; the job's own
 * permission is re-decided afterwards.
 */
const EXPORT_PERMISSIONS: readonly PermissionKeyType[] = [
  'students.export',
  'staff.export',
  'audit.export',
]

/**
 * A stored file name is data, and a header is not. Anything that could end the
 * header value or start a new one is removed rather than escaped, and a name
 * left empty falls back to a neutral one.
 */
function safeFileName(fileName: string): string {
  const cleaned = fileName
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\x20-\x7e]/g, '')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'document'
}

function asNodeStream(file: DocumentFile): NodeJS.ReadableStream {
  const stream = file.stream
  // The local storage hands back a Node stream; the in-memory one a web
  // stream. Fastify sends the Node shape, so only the web one is converted.
  return stream instanceof ReadableStream
    ? Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0])
    : (stream as NodeJS.ReadableStream)
}

interface DocumentRow {
  student_id: string
  file_name: string
  storage_key: string
}

interface ExportJobRow {
  status: string
  requested_by_membership_id: string
  access_version: number
  permission: string
  expired: boolean
}

/**
 * A stored status outside the contract's four values is a producer bug, not a
 * caller error, so it answers like any other response that cannot be shaped to
 * the contract rather than escaping as a framework error.
 */
function summary(id: string, status: string): FilesExportJobSummary {
  const parsed = FilesExportJobSummary.safeParse({ id, status })
  if (!parsed.success) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return parsed.data
}

function requireContext(request: FastifyRequest): RequestContext {
  const context = request.context
  if (!context) throw new ApiFailure('AUTHENTICATION_REQUIRED')
  return context
}

export function registerFileRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  /**
   * Private document bytes. This route streams, so it cannot use the shared
   * route helper's response contract; it repeats the same floor by hand: the
   * aggregate gate, then a fresh per-request decision on this exact document.
   */
  app.get(
    '/api/schools/:schoolId/students/:studentId/documents/:documentId/content',
    { preHandler: requireMembership(deps) },
    async (request, reply) => {
      const context = requireContext(request)
      const { studentId, documentId } = documentParams(request)

      const file = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'students.download_documents')
        // The fresh check the plan demands: decided now, on this record, not
        // inherited from whatever listed the document earlier. A record the
        // caller may not have answers exactly like a missing one, so holding
        // the permission somewhere never reveals which document ids exist.
        // Only a missing second factor is reported as itself, because that is
        // about the session and not about this row.
        const decision = await decideResource(
          conn,
          context,
          'students.download_documents',
          'student_document',
          documentId,
        )
        if (!decision.allowed) {
          throw new ApiFailure(
            decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND',
          )
        }

        const found = await conn.client.query<DocumentRow>(
          `SELECT student_id, file_name, storage_key
             FROM student_documents
            WHERE school_id = $1 AND id = $2`,
          [context.schoolId, documentId],
        )
        const row = found.rows[0]
        // A document of another student is not this student's document, and a
        // caller must not learn which of the two it was.
        if (!row || row.student_id !== studentId) throw new ApiFailure('RESOURCE_NOT_FOUND')

        // The storage key is server state: it is read here and never returned,
        // logged or put in a header.
        const bytes = await deps.documents.read(row.storage_key)
        // Missing bytes are a missing record. Nothing was delivered, so no
        // audit row is written and the transaction rolls back.
        if (!bytes) throw new ApiFailure('RESOURCE_NOT_FOUND')

        await writeAudit(conn, context, {
          action: 'students.download_documents',
          targetType: 'student_document',
          targetId: documentId,
          summary: 'Downloaded a student document',
        })
        return { bytes, fileName: safeFileName(row.file_name) }
      })

      return reply
        .header('content-type', file.bytes.contentType)
        .header('content-length', String(file.bytes.sizeBytes))
        .header('content-disposition', `attachment; filename="${file.fileName}"`)
        .header('cache-control', 'no-store')
        .send(asNodeStream(file.bytes))
    },
  )

  /**
   * The status of an export the caller asked for. The route gate cannot name
   * one permission, because students, staff and audit exports each carry their
   * own, so the job's recorded permission is re-decided here instead.
   */
  app.get(
    '/api/schools/:schoolId/exports/:jobId',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = requireContext(request)
      const jobId = jobParam(request)

      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // The floor every other route gets from the shared helper: a caller
        // who could not have asked for any export is refused before a row is
        // read at all, so the route cannot be used to probe job ids.
        let mayExportSomething = false
        for (const permission of EXPORT_PERMISSIONS) {
          const decision = await decideAction(conn, context, permission, context.schoolId, true)
          if (decision.allowed) {
            mayExportSomething = true
            break
          }
        }
        if (!mayExportSomething) throw new ApiFailure('ACCESS_DENIED')

        const found = await conn.client.query<ExportJobRow>(
          `SELECT status, requested_by_membership_id, access_version, permission,
                  (expires_at <= now()) AS expired
             FROM export_jobs
            WHERE school_id = $1 AND id = $2`,
          [context.schoolId, jobId],
        )
        const row = found.rows[0]
        if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
        // Another member's job is not visible at all, so its existence cannot
        // be probed by asking for its status.
        if (row.requested_by_membership_id !== context.membershipId) {
          throw new ApiFailure('RESOURCE_NOT_FOUND')
        }

        // Terminal states are the end of the job's life and are reported as
        // stored; nothing here rewrites a recorded failure into an expiry.
        if (row.status === 'expired' || row.status === 'failed') {
          return summary(jobId, row.status)
        }

        const permission = PermissionKey.safeParse(row.permission)
        const usable =
          permission.success && PERMISSION_CATALOGUE[permission.data].availability === 'active'
        // Access changed under the job, the job aged out, or the permission it
        // was made for no longer exists: in every case the answer is expired,
        // never the file.
        let stale = !usable || row.expired || row.access_version !== context.accessVersion
        if (!stale && permission.success) {
          try {
            await authorizeSchoolAction(conn, context, permission.data)
          } catch {
            // A permission the caller has lost expires the job rather than
            // refusing the request, so the caller can simply ask again.
            stale = true
          }
        }
        if (stale) {
          await conn.client.query(
            `UPDATE export_jobs SET status = 'expired', updated_at = now()
              WHERE school_id = $1 AND id = $2`,
            [context.schoolId, jobId],
          )
          return summary(jobId, 'expired')
        }
        return summary(jobId, row.status)
      })
    },
  )
}
