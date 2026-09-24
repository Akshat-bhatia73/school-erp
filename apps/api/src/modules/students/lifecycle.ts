import type { FastifyInstance } from 'fastify'
import {
  AnonymiseRequest,
  RETENTION,
  StudentDetailByAudience,
  UnlinkGuardianRequest,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { AuthzConnection } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import {
  allowedActionsFor,
  assertUuidParam,
  authorizeResource,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { bumpVersion } from '../shared/version.ts'

/** Anonymisation is only offered once the student has actually left. */
const LEFT_STATUSES = new Set(['left', 'alumni'])

interface RegisterRow {
  id: string
  school_id: string
  version: number
  first_name: string
  last_name: string | null
  admission_number: string
  status: string
  anonymised_at: string | null
  photo_storage_key: string | null
}

/**
 * End of life for a student record (Task 12). What the school must keep is the
 * register: who was admitted, under which number, and when they left. This
 * module clears everything else, and the guardians nobody else is attached to,
 * once the retention period has run.
 */
export function registerStudentLifecycleRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/students/:studentId/anonymise',
    permission: 'students.anonymise',
    body: AnonymiseRequest,
    response: StudentDetailByAudience,
    handler: async ({ context, body, param, request }) => {
      const studentId = assertUuidParam(param('studentId'))
      const { response, documentKeys } = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeResource(conn, context, 'students.anonymise', 'student', studentId)

        const current = await loadRegisterRow(conn, context.schoolId, studentId)
        // Nothing about the request is wrong; the record is simply not ready.
        if (current.anonymised_at !== null) throw new ApiFailure('NOT_ALLOWED_YET')
        if (!LEFT_STATUSES.has(current.status)) throw new ApiFailure('NOT_ALLOWED_YET')
        if (!(await retentionElapsed(conn, context.schoolId, studentId))) {
          throw new ApiFailure('NOT_ALLOWED_YET')
        }

        await bumpVersion(conn, 'students', {
          schoolId: context.schoolId,
          id: studentId,
          expectedVersion: body.expectedVersion,
          set: {
            date_of_birth: null,
            gender: null,
            blood_group: null,
            category: null,
            religion: null,
            mother_tongue: null,
            nationality: null,
            aadhaar_ciphertext: null,
            aadhaar_last4: null,
            apaar_ciphertext: null,
            apaar_last4: null,
            address: null,
            previous_school: null,
            left_reason: null,
            medical_notes: null,
            house: null,
            photo_storage_key: null,
            photo_content_type: null,
            photo_updated_at: null,
            anonymised_at: new Date(),
          },
        })

        const documentKeys = await clearDocuments(conn, context.schoolId, studentId)
        // The photograph is bytes in the same store, so it leaves with them.
        if (current.photo_storage_key !== null) documentKeys.push(current.photo_storage_key)
        const guardians = await anonymiseOrphanedGuardians(conn, context.schoolId, studentId)
        // The money rows stay, and so does the bank or cheque reference on
        // them: the accounts have to stand for eight years. What goes is the
        // name of the person who paid, which is the one edit the ledger
        // allows at all.
        const cleared = await conn.client.query(
          `UPDATE fee_receipts SET payer_name = NULL
            WHERE school_id = $1 AND student_id = $2 AND payer_name IS NOT NULL`,
          [context.schoolId, studentId],
        )

        // Remarks a teacher wrote about the child follow the pupil's own
        // retention period, so they go now: the working rows (with a version
        // bump, like every edit to them) and the published copies, where the
        // database allows clearing remarks and nothing else. Marks, grades
        // and the published figures stay: they are the academic record.
        const entriesCleared = await conn.client.query(
          `UPDATE report_card_entries
              SET remarks = NULL, version = version + 1, updated_at = now(), updated_by_membership_id = $3
            WHERE school_id = $1 AND student_id = $2 AND remarks IS NOT NULL`,
          [context.schoolId, studentId, context.membershipId],
        )
        const versionsCleared = await conn.client.query(
          `UPDATE report_card_versions SET remarks = NULL
            WHERE school_id = $1 AND student_id = $2 AND remarks IS NOT NULL`,
          [context.schoolId, studentId],
        )

        // Messages about the child lose their words, whatever their status,
        // and the masked email addresses of the guardians anonymised just now
        // go from the delivery record. A guardian anonymised in this
        // transaction carries this transaction's now() as anonymised_at.
        const messagesRedacted = await conn.client.query(
          `UPDATE messages SET title = '', body = '', redacted_at = now(), updated_at = now()
            WHERE school_id = $1 AND student_id = $2 AND redacted_at IS NULL`,
          [context.schoolId, studentId],
        )
        const messageEmailsCleared = await conn.client.query(
          `UPDATE message_recipients SET email_masked = NULL
            WHERE school_id = $1 AND email_masked IS NOT NULL
              AND guardian_id IN (
                SELECT id FROM guardians WHERE school_id = $1 AND anonymised_at = now())`,
          [context.schoolId],
        )

        await writeAudit(conn, context, {
          action: 'students.anonymise',
          targetType: 'student',
          targetId: studentId,
          summary: 'Anonymised a former student record after the retention period.',
          safeChanges: {
            status: current.status,
            documents: documentKeys.length,
            guardians,
            feeReceiptsCleared: cleared.rowCount ?? 0,
            reportCardRemarksCleared: entriesCleared.rowCount ?? 0,
            reportCardVersionRemarksCleared: versionsCleared.rowCount ?? 0,
            messagesRedacted: messagesRedacted.rowCount ?? 0,
            messageEmailsCleared: messageEmailsCleared.rowCount ?? 0,
          },
          note: body.reason,
        })

        return { response: await detailResponse(conn, context, studentId), documentKeys }
      })

      // Only after the commit: the rows are already blank, so a blob left
      // behind is unreachable through the API, whereas removing the bytes
      // before a rollback would leave a live row pointing at nothing.
      for (const key of documentKeys) {
        try {
          await deps.documents.remove(key)
        } catch (error) {
          request.log.warn({ err: error, key }, 'a document could not be removed after anonymisation')
        }
      }
      return response
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/students/:studentId/guardians/:guardianId/unlink',
    permission: 'students.manage_guardians',
    body: UnlinkGuardianRequest,
    response: StudentDetailByAudience,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      const guardianId = assertUuidParam(param('guardianId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        // The permission is declared over the guardian record, so that is what
        // is decided; the student is then proven to hold this very link.
        await authorizeResource(conn, context, 'students.manage_guardians', 'guardian', guardianId)

        const current = await loadRegisterRow(conn, context.schoolId, studentId)
        const links = await conn.client.query<{ guardian_id: string }>(
          `SELECT guardian_id FROM student_guardians
            WHERE school_id = $1 AND student_id = $2`,
          [context.schoolId, studentId],
        )
        if (!links.rows.some((row) => row.guardian_id === guardianId)) {
          throw new ApiFailure('RESOURCE_NOT_FOUND')
        }
        // A student still at the school must always have somebody to call.
        if (links.rows.length === 1 && current.status === 'active') {
          throw new ApiFailure('NOT_ALLOWED_YET')
        }

        // The link belongs to the student, so the student's version is the
        // concurrency check and the write that records the change.
        await bumpVersion(conn, 'students', {
          schoolId: context.schoolId,
          id: studentId,
          expectedVersion: body.expectedVersion,
        })
        await conn.client.query(
          `DELETE FROM student_guardians
            WHERE school_id = $1 AND student_id = $2 AND guardian_id = $3`,
          [context.schoolId, studentId, guardianId],
        )
        const guardians = await anonymiseUnlinkedGuardians(conn, context.schoolId, [guardianId])

        await writeAudit(conn, context, {
          action: 'students.manage_guardians',
          targetType: 'student',
          targetId: studentId,
          summary: 'Unlinked a guardian from a student record.',
          safeChanges: { guardiansAnonymised: guardians },
          note: body.reason,
        })

        return detailResponse(conn, context, studentId)
      })
    },
  })
}

async function loadRegisterRow(
  conn: AuthzConnection,
  schoolId: string,
  studentId: string,
): Promise<RegisterRow> {
  const result = await conn.client.query<RegisterRow>(
    `SELECT id, school_id, version, first_name, last_name, admission_number, status,
            anonymised_at::text AS anonymised_at, photo_storage_key
       FROM students WHERE school_id = $1 AND id = $2`,
    [schoolId, studentId],
  )
  const row = result.rows[0]
  if (!row) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return row
}

/**
 * The register block the caller gets back. Sensitive, medical and guardian
 * blocks are deliberately absent: after this write there is nothing in them,
 * and an unlink answers with the record it changed, not a fresh audience read.
 */
async function detailResponse(conn: AuthzConnection, context: RequestContext, studentId: string) {
  const row = await loadRegisterRow(conn, context.schoolId, studentId)
  const lastName = row.last_name?.trim()
  return {
    student: {
      id: row.id,
      schoolId: row.school_id,
      version: Number(row.version),
      firstName: row.first_name,
      ...(lastName ? { lastName } : {}),
      admissionNumber: row.admission_number,
      status: row.status as 'active' | 'left' | 'alumni' | 'suspended',
      anonymised: row.anonymised_at !== null,
      hasPhoto: row.photo_storage_key !== null,
    },
    allowedActions: [
      ...(await allowedActionsFor(conn, context, {
        schoolId: context.schoolId,
        resourceType: 'student',
        id: studentId,
      })),
    ],
  }
}

/** The database compares against its own clock, not the API host's. */
async function retentionElapsed(
  conn: AuthzConnection,
  schoolId: string,
  studentId: string,
): Promise<boolean> {
  const result = await conn.client.query<{ elapsed: boolean }>(
    `SELECT left_on IS NOT NULL
        AND left_on <= current_date - make_interval(years => $3::int) AS elapsed
       FROM students WHERE school_id = $1 AND id = $2`,
    [schoolId, studentId, RETENTION.studentSensitiveYears],
  )
  return result.rows[0]?.elapsed === true
}

/**
 * The row keeps only its type and size: DELETE is revoked on student_documents,
 * and a blanked name and key is what the projection reads as "no document here
 * any more". The keys are returned so the bytes go after the commit.
 */
async function clearDocuments(
  conn: AuthzConnection,
  schoolId: string,
  studentId: string,
): Promise<string[]> {
  const rows = await conn.client.query<{ id: string; storage_key: string }>(
    `SELECT id, storage_key FROM student_documents
      WHERE school_id = $1 AND student_id = $2 AND storage_key <> ''`,
    [schoolId, studentId],
  )
  await conn.client.query(
    `UPDATE student_documents SET file_name = '', storage_key = '', updated_at = now()
      WHERE school_id = $1 AND student_id = $2`,
    [schoolId, studentId],
  )
  return rows.rows.map((row) => row.storage_key)
}

/**
 * A guardian belongs to the students they are linked to. Anonymising one
 * student takes with it every guardian who has nobody else left, and leaves a
 * guardian shared with a sibling exactly as it was.
 */
async function anonymiseOrphanedGuardians(
  conn: AuthzConnection,
  schoolId: string,
  studentId: string,
): Promise<number> {
  const linked = await conn.client.query<{ guardian_id: string }>(
    `SELECT guardian_id FROM student_guardians WHERE school_id = $1 AND student_id = $2`,
    [schoolId, studentId],
  )
  return anonymiseGuardians(conn, schoolId, linked.rows.map((row) => row.guardian_id), studentId)
}

async function anonymiseUnlinkedGuardians(
  conn: AuthzConnection,
  schoolId: string,
  guardianIds: readonly string[],
): Promise<number> {
  return anonymiseGuardians(conn, schoolId, guardianIds, null)
}

/**
 * Clears the guardians in the list who have no student left that is still a
 * living record. `exceptStudentId` is the student being anonymised in this same
 * transaction: its own anonymised_at is already set, so it is excluded anyway,
 * but naming it keeps the intent readable.
 */
async function anonymiseGuardians(
  conn: AuthzConnection,
  schoolId: string,
  guardianIds: readonly string[],
  exceptStudentId: string | null,
): Promise<number> {
  if (guardianIds.length === 0) return 0
  const updated = await conn.client.query(
    `UPDATE guardians
        SET first_name = 'Former guardian', last_name = NULL, phone = NULL, alt_phone = NULL,
            email = NULL, occupation = NULL, qualification = NULL, annual_income = NULL,
            address = NULL, office_address = NULL,
            pan_ciphertext = NULL, pan_last4 = NULL,
            aadhaar_ciphertext = NULL, aadhaar_last4 = NULL,
            anonymised_at = now(), version = version + 1, updated_at = now()
      WHERE school_id = $1 AND id = ANY($2::uuid[]) AND anonymised_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM student_guardians sg
            JOIN students s ON s.school_id = sg.school_id AND s.id = sg.student_id
           WHERE sg.school_id = guardians.school_id AND sg.guardian_id = guardians.id
             AND s.anonymised_at IS NULL AND ($3::uuid IS NULL OR s.id <> $3::uuid)
        )`,
    [schoolId, [...guardianIds], exceptStudentId],
  )
  return updated.rowCount ?? 0
}
