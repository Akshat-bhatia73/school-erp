import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { planPredicate, scopedTableFor, type AuthzConnection } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import { ConsentList, RecordConsentRequest } from '@erp/contracts'
import type { ConsentMethod, ConsentPurpose, ConsentStatus } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import type { TenantConnection } from '../shared/audit.ts'
import {
  ApiFailure,
  allowedActionsFor,
  assertUuidParam,
  lockSchool,
  protectedRoute,
  readPlan,
  requireFound,
  writeAudit,
} from '../shared/index.ts'
import type { ModuleDependencies } from '../shared/route.ts'

/** One consent event to record. Admission passes these from its `consents` array. */
export interface ConsentEntry {
  readonly guardianId: string
  readonly purpose: ConsentPurpose
  readonly status: ConsentStatus
  readonly method: ConsentMethod
  readonly evidenceReference?: string
}

interface ConsentRow extends Record<string, unknown> {
  readonly id: string
  readonly student_id: string
  readonly guardian_id: string
  readonly guardian_display_name: string
  readonly purpose: ConsentPurpose
  readonly status: ConsentStatus
  readonly method: ConsentMethod
  readonly evidence_reference: string | null
  readonly recorded_at: Date | string
  readonly recorded_by_guardian: boolean
}

/** The student table as the authorizer describes it, for the visibility check. */
function studentTable() {
  const table = scopedTableFor('student')
  if (!table) throw new Error('the authorizer has no scoped table for students')
  return table
}

/**
 * The student this caller may read at all under `permission`. An unreadable or
 * missing student is one answer, exactly as the student detail route gives, so
 * a parent asking about another family's child learns nothing.
 */
async function requireDecidedStudent(
  conn: AuthzConnection,
  context: RequestContext,
  permission: 'students.read_consents' | 'students.manage_consents',
  studentId: string,
): Promise<void> {
  const plan = await readPlan(conn, context, permission, 'student')
  const found = await conn.db.execute<{ id: string }>(
    sql`SELECT students.id FROM students
         WHERE ${planPredicate(plan, studentTable())}
           AND students.id = ${studentId}::uuid`,
  )
  requireFound(found.rows[0])
}

/** The guardian this actor is, in this school, or null when the actor is staff. */
async function actorGuardianId(
  conn: TenantConnection,
  context: RequestContext,
): Promise<string | null> {
  const result = await conn.client.query<{ guardian_id: string }>(
    `SELECT guardian_id FROM membership_guardian_links
      WHERE school_id = $1 AND membership_id = $2`,
    [context.schoolId, context.membershipId],
  )
  return result.rows[0]?.guardian_id ?? null
}

/**
 * The one insertion path for guardian_consents rows (Task 12). Runs inside the
 * caller's tenant transaction after the caller has decided the student record;
 * validates that each guardian is linked to the student in this school.
 */
export async function recordConsents(
  conn: TenantConnection,
  context: RequestContext,
  studentId: string,
  entries: readonly ConsentEntry[],
): Promise<readonly string[]> {
  if (entries.length === 0) return []

  const guardianIds = [...new Set(entries.map((entry) => entry.guardianId))]
  const linked = await conn.client.query<{ guardian_id: string }>(
    `SELECT guardian_id FROM student_guardians
      WHERE school_id = $1 AND student_id = $2 AND guardian_id = ANY($3::uuid[])`,
    [context.schoolId, studentId, guardianIds],
  )
  const known = new Set(linked.rows.map((row) => row.guardian_id))
  // A guardian of another student, or of no student, is a bad request and not
  // a hint that some other record exists.
  if (guardianIds.some((id) => !known.has(id))) throw new ApiFailure('INVALID_REQUEST')

  // A guardian answering for their own child answers through the portal, so
  // the stored method says what actually happened rather than what was sent.
  const actorGuardian = await actorGuardianId(conn, context)
  const throughPortal = actorGuardian !== null && known.has(actorGuardian)

  for (const entry of entries) {
    await conn.client.query(
      `INSERT INTO guardian_consents
         (school_id, student_id, guardian_id, purpose, status, method,
          recorded_by_membership_id, evidence_reference)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        context.schoolId,
        studentId,
        entry.guardianId,
        entry.purpose,
        entry.status,
        throughPortal ? 'portal' : entry.method,
        context.membershipId,
        entry.evidenceReference ?? null,
      ],
    )
  }

  // A photograph is only held while the family agrees to it, so withdrawing
  // that purpose takes the picture with it in the same transaction. The keys
  // are handed back so the bytes go after the commit.
  const withdrawnPhotos = entries.some(
    (entry) => entry.purpose === 'photographs' && entry.status === 'withdrawn',
  )
    ? await clearPhoto(conn, context.schoolId, studentId)
    : []

  await writeAudit(conn, context, {
    action: 'students.manage_consents',
    targetType: 'student',
    targetId: studentId,
    summary: 'Recorded guardian consent.',
    // Evidence references are a person's words about a paper form; only the
    // structure of the decision belongs in an audit row.
    safeChanges: {
      entries: entries.map((entry) => ({ purpose: entry.purpose, status: entry.status })),
      ...(withdrawnPhotos.length > 0 ? { photo: 'removed' } : {}),
    },
  })
  return withdrawnPhotos
}

/**
 * The photograph columns cleared, and the key of the bytes that are now
 * unreachable. A record with no photograph simply returns nothing to remove.
 */
async function clearPhoto(
  conn: TenantConnection,
  schoolId: string,
  studentId: string,
): Promise<string[]> {
  // The key has to be read before the update: RETURNING hands back the new
  // row, which by then names nothing, and the bytes would be left behind.
  const cleared = await conn.client.query<{ photo_storage_key: string }>(
    `WITH previous AS (
       SELECT id, photo_storage_key FROM students
        WHERE school_id = $1 AND id = $2 AND photo_storage_key IS NOT NULL
     )
     UPDATE students s
        SET photo_storage_key = NULL, photo_content_type = NULL, photo_updated_at = NULL,
            version = s.version + 1, updated_at = now()
       FROM previous p
      WHERE s.school_id = $1 AND s.id = p.id
      RETURNING p.photo_storage_key`,
    [schoolId, studentId],
  )
  return cleared.rows.map((row) => row.photo_storage_key)
}

/** The newest row per guardian and purpose: the current answer, nothing older. */
async function listConsents(
  conn: AuthzConnection,
  context: RequestContext,
  studentId: string,
): Promise<ConsentList> {
  const rows = await conn.db.execute<ConsentRow>(
    sql`SELECT DISTINCT ON (gc.guardian_id, gc.purpose)
               gc.id, gc.student_id, gc.guardian_id, gc.purpose, gc.status, gc.method,
               gc.evidence_reference, gc.recorded_at,
               TRIM(BOTH FROM g.first_name || ' ' || COALESCE(g.last_name, '')) AS guardian_display_name,
               (mgl.guardian_id IS NOT NULL) AS recorded_by_guardian
          FROM guardian_consents gc
          JOIN guardians g ON g.school_id = gc.school_id AND g.id = gc.guardian_id
          LEFT JOIN membership_guardian_links mgl
            ON mgl.school_id = gc.school_id
           AND mgl.membership_id = gc.recorded_by_membership_id
           AND mgl.guardian_id = gc.guardian_id
         WHERE gc.school_id = ${context.schoolId}::uuid
           AND gc.student_id = ${studentId}::uuid
         ORDER BY gc.guardian_id, gc.purpose, gc.recorded_at DESC, gc.id DESC`,
  )
  return {
    items: rows.rows.map((row) => ({
      id: row.id,
      studentId: row.student_id,
      guardianId: row.guardian_id,
      guardianDisplayName: row.guardian_display_name,
      purpose: row.purpose,
      status: row.status,
      method: row.method,
      ...(row.evidence_reference === null ? {} : { evidenceReference: row.evidence_reference }),
      recordedAt: new Date(row.recorded_at).toISOString(),
      recordedBy: row.recorded_by_guardian ? 'guardian' : 'office',
    })),
    allowedActions: [
      ...(await allowedActionsFor(conn, context, {
        schoolId: context.schoolId,
        resourceType: 'student',
        id: studentId,
      })),
    ],
  }
}

/** Guardian consent records (Task 12): the list, recording and withdrawal. */
export function registerConsentRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  const inTransaction = <T>(context: RequestContext, work: (conn: AuthzConnection) => Promise<T>) =>
    withTenantTransaction(deps.pools.runtime, context, work)

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/consents',
    permission: 'students.read_consents',
    response: ConsentList,
    auditRead: {
      targetType: 'student',
      param: 'studentId',
      summary: 'Read the consent records of the student.',
    },
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await requireDecidedStudent(conn, context, 'students.read_consents', studentId)
        return listConsents(conn, context, studentId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/students/:studentId/consents',
    permission: 'students.manage_consents',
    body: RecordConsentRequest,
    response: ConsentList,
    handler: async ({ context, body, param, request }) => {
      const studentId = assertUuidParam(param('studentId'))
      const { list, photoKeys } = await inTransaction(context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await requireDecidedStudent(conn, context, 'students.manage_consents', studentId)
        const photoKeys = await recordConsents(conn, context, studentId, [body])
        return { list: await listConsents(conn, context, studentId), photoKeys }
      })
      // Only after the commit: the row no longer names these bytes, so a
      // rollback could not have left a record pointing at nothing.
      for (const key of photoKeys) {
        try {
          await deps.documents.remove(key)
        } catch (error) {
          request.log.warn({ err: error }, 'a photograph could not be removed after withdrawal')
        }
      }
      return list
    },
  })
}
