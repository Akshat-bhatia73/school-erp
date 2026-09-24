import { Readable } from 'node:stream'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  FilesDocumentParams,
  FilesExportJobParams,
  FilesExportJobSummary,
  PERMISSION_CATALOGUE,
  PermissionKey,
  type PermissionKey as PermissionKeyType,
  type ResourceType,
} from '@erp/contracts'
import type { AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { requireMembership } from '../../auth/guards.ts'
import { decideResource, authorizeSchoolAction } from '../shared/authorize.ts'
import { decideAction } from '../../memberships/authorize.ts'
import { writeAudit } from '../shared/audit.ts'
import { exportFormatFor } from '../../exports/run.ts'
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
  // A timetable export is the same read in another format, so it carries the
  // read permission rather than an export permission of its own.
  'timetable.read',
  // The dues list and the collection register are exports; one receipt is the
  // same read in another format, so the office counter and a parent can both
  // have it without holding an export key.
  'fees.export',
  'fees.read',
  // A section's register and the staff register are exports; one pupil's
  // month is the same read in another format, so a parent can print it.
  'attendance.export',
  'attendance.read',
  'staff_attendance.export',
  // A paper's marks register and the report card files. A parent holds
  // report_cards.export at their own children, so they print their own copy.
  'exams.export',
  'report_cards.export',
  // A message's delivery record, for the office.
  'communication.export',
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
  kind: string
  criteria: unknown
  requested_by_membership_id: string
  access_version: number
  permission: string
  expired: boolean
  storage_key: string | null
  file_name: string | null
  content_type: string | null
}

/**
 * A stored status outside the contract's four values is a producer bug, not a
 * caller error, so it answers like any other response that cannot be shaped to
 * the contract rather than escaping as a framework error.
 */
function summary(id: string, row?: ExportJobRow, status?: string): FilesExportJobSummary {
  const ready = row && row.status === 'ready' && row.file_name && row.content_type
  const format = ready ? exportFormatFor(row.content_type as string) : undefined
  const parsed = FilesExportJobSummary.safeParse({
    id,
    status: status ?? row?.status,
    ...(ready ? { fileName: row.file_name } : {}),
    ...(format ? { format } : {}),
  })
  if (!parsed.success) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return parsed.data
}

/**
 * The job as this caller may see it. A job that can never produce a file again
 * is reported by its terminal status only; a usable one carries its row and
 * the permission it was made for.
 */
type ExportJobLookup =
  | { readonly usable: false; readonly status: string }
  | {
      readonly usable: true
      readonly row: ExportJobRow
      readonly permission: PermissionKeyType
    }

/**
 * The job kinds whose criteria name one record. Holding the permission across
 * the school is not enough for these: the record itself has to be decided
 * again, exactly as the route that made the job decided it.
 */
const SINGLE_RECORD_KINDS: Readonly<
  Record<string, { resourceType: ResourceType; field: string }>
> = {
  student_profile: { resourceType: 'student', field: 'studentId' },
  staff_profile: { resourceType: 'staff', field: 'staffId' },
  fee_receipt: { resourceType: 'fee', field: 'receiptId' },
  attendance_pupil_month: { resourceType: 'attendance', field: 'studentId' },
  // A teacher whose assignment has ended cannot download their old register,
  // and a family whose link has gone cannot download the card they printed.
  exam_marks_register: { resourceType: 'exam', field: 'paperId' },
  report_card: { resourceType: 'report_card', field: 'versionId' },
  report_cards_section: { resourceType: 'report_card', field: 'sectionId' },
  message_delivery: { resourceType: 'communication', field: 'messageId' },
}

/**
 * Whether the one record this job names may still be exported by this caller.
 * A job of any other kind says yes: its producer re-applied the read plan when
 * the file was made, so its rows were already decided.
 */
async function namedRecordAllowed(
  conn: AuthzConnection,
  context: RequestContext,
  row: ExportJobRow,
  permission: PermissionKeyType,
): Promise<boolean> {
  const single = SINGLE_RECORD_KINDS[row.kind]
  if (!single) return true
  const criteria = row.criteria
  const id =
    typeof criteria === 'object' && criteria !== null
      ? (criteria as Record<string, unknown>)[single.field]
      : undefined
  // A job whose criteria names nothing readable can never be decided again, so
  // it stops being downloadable rather than being trusted.
  if (typeof id !== 'string') return false
  const decision = await decideResource(conn, context, permission, single.resourceType, id)
  return decision.allowed
}

/**
 * Every check the status route and the download route share, in one place so
 * the two can never drift: the floor, the job's owner, its age, the access
 * version it was made under, and the permission it was made for. A job that
 * fails any of the last four is marked expired here, so the caller simply asks
 * again instead of being refused.
 */
async function loadExportJob(
  conn: AuthzConnection,
  context: RequestContext,
  jobId: string,
): Promise<ExportJobLookup> {
  // The floor every other route gets from the shared helper: a caller who
  // could not have asked for any export is refused before a row is read at
  // all, so the route cannot be used to probe job ids.
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
    `SELECT status, kind, criteria, requested_by_membership_id, access_version, permission,
            (expires_at <= now()) AS expired, storage_key, file_name, content_type
       FROM export_jobs
      WHERE school_id = $1 AND id = $2`,
    [context.schoolId, jobId],
  )
  const row = found.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  // Another member's job is not visible at all, so its existence cannot be
  // probed by asking for its status.
  if (row.requested_by_membership_id !== context.membershipId) {
    throw new ApiFailure('RESOURCE_NOT_FOUND')
  }

  // Terminal states are the end of the job's life and are reported as stored;
  // nothing here rewrites a recorded failure into an expiry.
  if (row.status === 'expired' || row.status === 'failed') {
    return { usable: false, status: row.status }
  }

  const permission = PermissionKey.safeParse(row.permission)
  const usable =
    permission.success && PERMISSION_CATALOGUE[permission.data].availability === 'active'
  // Access changed under the job, the job aged out, or the permission it was
  // made for no longer exists: in every case the answer is expired, never the
  // file.
  let stale = !usable || row.expired || row.access_version !== context.accessVersion
  if (!stale && permission.success) {
    try {
      await authorizeSchoolAction(conn, context, permission.data)
    } catch {
      // A permission the caller has lost expires the job rather than refusing
      // the request, so the caller can simply ask again.
      stale = true
    }
  }
  // A record that has moved out of the caller's scope since the job was made,
  // such as a child who changed section, takes the file with it.
  if (!stale && permission.success) {
    stale = !(await namedRecordAllowed(conn, context, row, permission.data))
  }
  if (stale || !permission.success) {
    await conn.client.query(
      `UPDATE export_jobs SET status = 'expired', updated_at = now()
        WHERE school_id = $1 AND id = $2`,
      [context.schoolId, jobId],
    )
    return { usable: false, status: 'expired' }
  }
  return { usable: true, row, permission: permission.data }
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
   * one permission, because students, staff, audit and timetable exports each
   * carry their own, so the job's recorded permission is re-decided here
   * instead.
   */
  app.get(
    '/api/schools/:schoolId/exports/:jobId',
    { preHandler: requireMembership(deps) },
    async (request) => {
      const context = requireContext(request)
      const jobId = jobParam(request)

      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const job = await loadExportJob(conn, context, jobId)
        return job.usable ? summary(jobId, job.row) : summary(jobId, undefined, job.status)
      })
    },
  )

  /**
   * The bytes of a ready export. This route streams, so it repeats by hand
   * what the shared route helper would do, and it applies exactly the checks
   * the status route applies: a job that is not this caller's, not ready any
   * more, or made under access the caller no longer has, answers like a record
   * that does not exist.
   */
  app.get(
    '/api/schools/:schoolId/exports/:jobId/file',
    { preHandler: requireMembership(deps) },
    async (request, reply) => {
      const context = requireContext(request)
      const jobId = jobParam(request)

      const file = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const job = await loadExportJob(conn, context, jobId)
        // A queued, failed or expired job has no bytes to hand over, and the
        // caller learns nothing beyond what the status route already said.
        // Refusing is reported after the transaction, because the lookup may
        // have just written the expiry and throwing here would undo it.
        if (!job.usable || job.row.status !== 'ready') return null
        const {
          storage_key: storageKey,
          file_name: fileName,
          content_type: contentType,
        } = job.row
        if (!storageKey || !fileName || !contentType) return null

        // The storage key is server state: it is read here and never returned,
        // logged or put in a header.
        const bytes = await deps.documents.read(storageKey)
        // Missing bytes are a missing record. Nothing was delivered, so no
        // audit row is written and the transaction rolls back.
        if (!bytes) throw new ApiFailure('RESOURCE_NOT_FOUND')

        await writeAudit(conn, context, {
          action: job.permission,
          targetType: 'export_job',
          targetId: jobId,
          summary: 'Downloaded an export file',
        })
        // The type is the job's own, set when the bytes were made. The store
        // is asked for bytes only and never for what they are.
        return { bytes, fileName: safeFileName(fileName), contentType }
      })
      if (!file) throw new ApiFailure('RESOURCE_NOT_FOUND')

      return reply
        .header('content-type', file.contentType)
        .header('content-length', String(file.bytes.sizeBytes))
        .header('content-disposition', `attachment; filename="${file.fileName}"`)
        .header('cache-control', 'no-store')
        .send(asNodeStream(file.bytes))
    },
  )
}
