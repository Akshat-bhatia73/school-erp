import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { planPredicate, scopedTableFor } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import { SubjectAccessExport } from '@erp/contracts'
import type {
  ConsentMethod,
  ConsentPurpose,
  ConsentRecord,
  ConsentStatus,
  PermissionKey,
  SubjectAccessEvent,
  SubjectSensitive,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { decideAction } from '../../memberships/authorize.ts'
import { resolveDisplayNames, type MemberRow } from '../../memberships/directory.ts'
import {
  allowedActionsFor,
  assertUuidParam,
  decideResource,
  decideSchoolAction,
  open,
  protectedRoute,
  readPlan,
  requireFound,
} from '../shared/index.ts'
import type { ModuleDependencies } from '../shared/route.ts'
import {
  enrollmentVisibility,
  getStudent,
  guardianColumns,
  type ModuleConnection,
} from './reads.ts'
import {
  toStudentBasic,
  toStudentMedical,
  toStudentSensitive,
  toSubjectGuardian,
  type GuardianRow,
} from './project.ts'

type Export = SubjectAccessExport

/** The scoped table description of a resource type, or a startup failure. */
function tableFor(resourceType: 'guardian' | 'student_document' | 'enrollment') {
  const table = scopedTableFor(resourceType)
  if (!table) throw new Error(`the authorizer has no scoped table for ${resourceType}`)
  return table
}

const OUTCOMES = ['ongoing', 'promoted', 'detained', 'left'] as const

interface EnrollmentRow extends Record<string, unknown> {
  id: string
  roll_number: number | null
  outcome: string
  year_id: string
  year_name: string
  section_id: string
  section_name: string
  grade_id: string
  grade_name: string
}

async function loadEnrollments(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
): Promise<Export['enrollments']> {
  const plan = await readPlan(conn, context, 'students.read_enrollments', 'enrollment')
  const rows = await conn.db.execute<EnrollmentRow>(
    sql`SELECT enrollments.id, enrollments.roll_number, enrollments.outcome,
               ay.id AS year_id, ay.name AS year_name, sec.id AS section_id,
               sec.name AS section_name, gr.id AS grade_id, gr.name AS grade_name
          FROM enrollments
          JOIN sections sec ON sec.school_id = enrollments.school_id AND sec.id = enrollments.section_id
          JOIN academic_years ay ON ay.school_id = enrollments.school_id
           AND ay.id = enrollments.academic_year_id
          JOIN grades gr ON gr.school_id = enrollments.school_id AND gr.id = sec.grade_id
         WHERE ${planPredicate(plan, tableFor('enrollment'))}
           AND enrollments.student_id = ${studentId}::uuid
         ORDER BY enrollments.joined_on DESC, enrollments.id
         LIMIT 50`,
  )
  return rows.rows.map((row) => ({
    id: row.id,
    academicYear: { id: row.year_id, name: row.year_name },
    section: { id: row.section_id, name: row.section_name },
    grade: { id: row.grade_id, name: row.grade_name },
    ...(row.roll_number === null ? {} : { rollNumber: Number(row.roll_number) }),
    outcome: OUTCOMES.find((value) => value === row.outcome) ?? 'ongoing',
  }))
}

/** The guardian rows of this student the caller's plan lets through. */
async function loadGuardians(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  permission: 'students.read_guardians' | 'students.read_guardian_contact',
): Promise<GuardianRow[]> {
  const where =
    permission === 'students.read_guardians'
      ? planPredicate(await readPlan(conn, context, permission, 'guardian'), tableFor('guardian'))
      : // The contact projection is decided on the student, not on each
        // guardian, exactly as the student detail route decides it.
        sql`guardians.school_id = ${context.schoolId}::uuid`
  const rows = await conn.db.execute<GuardianRow>(
    sql`SELECT ${guardianColumns}
          FROM guardians
          JOIN student_guardians sg ON sg.school_id = guardians.school_id
           AND sg.guardian_id = guardians.id
         WHERE ${where}
           AND sg.student_id = ${studentId}::uuid
         ORDER BY sg.is_primary DESC, guardians.id
         LIMIT 20`,
  )
  return rows.rows
}

interface DocumentRow extends Record<string, unknown> {
  id: string
  student_id: string
  file_name: string
  document_type: string
  size_bytes: string
  verified: boolean
}

async function loadDocuments(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
): Promise<Export['documents']> {
  const plan = await readPlan(conn, context, 'students.read_documents', 'student_document')
  // The storage key is server state and is never selected here.
  const rows = await conn.db.execute<DocumentRow>(
    sql`SELECT student_documents.id, student_documents.student_id, student_documents.file_name,
               student_documents.document_type, student_documents.size_bytes::text AS size_bytes,
               student_documents.verified
          FROM student_documents
         WHERE ${planPredicate(plan, tableFor('student_document'))}
           AND student_documents.student_id = ${studentId}::uuid
         ORDER BY student_documents.id
         LIMIT 100`,
  )
  const documents: Export['documents'] = []
  for (const row of rows.rows) {
    documents.push({
      id: row.id,
      studentId: row.student_id,
      fileName: row.file_name,
      type: row.document_type,
      sizeBytes: Number(row.size_bytes),
      verified: row.verified,
      allowedActions: [
        ...(await allowedActionsFor(conn, context, {
          schoolId: context.schoolId,
          resourceType: 'student_document',
          id: row.id,
        })),
      ],
    })
  }
  return documents
}

interface ConsentRow extends Record<string, unknown> {
  id: string
  student_id: string
  guardian_id: string
  guardian_display_name: string
  purpose: ConsentPurpose
  status: ConsentStatus
  method: ConsentMethod
  evidence_reference: string | null
  recorded_at: Date | string
  recorded_by_guardian: boolean
}

/**
 * The newest row per guardian and purpose, the same answer the consent list
 * route gives. It is written out here rather than shared because that module
 * keeps its query private to its own routes.
 */
async function loadConsents(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
): Promise<ConsentRecord[]> {
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
         ORDER BY gc.guardian_id, gc.purpose, gc.recorded_at DESC, gc.id DESC
         LIMIT 100`,
  )
  return rows.rows.map((row) => ({
    id: row.id,
    studentId: row.student_id,
    guardianId: row.guardian_id,
    guardianDisplayName: row.guardian_display_name,
    purpose: row.purpose,
    status: row.status,
    method: row.method,
    ...(row.evidence_reference === null ? {} : { evidenceReference: row.evidence_reference }),
    recordedAt: new Date(row.recorded_at).toISOString(),
    recordedBy: row.recorded_by_guardian ? ('guardian' as const) : ('office' as const),
  }))
}

interface HistoryRow extends Record<string, unknown> {
  created_at: Date | string
  action: string
  result: string
  actor_membership_id: string | null
  actor_user_id: string | null
}

/**
 * Who touched this record, from the audit trail. Names are resolved exactly as
 * the member directory resolves them, so this list and the audit screen never
 * disagree about who somebody is.
 */
async function loadAccessHistory(
  conn: ModuleConnection,
  context: RequestContext,
  authPool: ModuleDependencies['pools']['auth'],
  studentId: string,
): Promise<SubjectAccessEvent[]> {
  const rows = await conn.db.execute<HistoryRow>(
    sql`SELECT created_at, action, result, actor_membership_id, actor_user_id
          FROM audit_events
         WHERE school_id = ${context.schoolId}::uuid
           AND target_id = ${studentId}::uuid
         ORDER BY created_at DESC, id DESC
         LIMIT 200`,
  )
  const membershipIds = [
    ...new Set(rows.rows.map((row) => row.actor_membership_id).filter((id): id is string => id !== null)),
  ]
  const names = new Map<string, string>()
  if (membershipIds.length > 0) {
    const found = await conn.client.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM school_memberships WHERE school_id = $1 AND id = ANY($2::uuid[])`,
      [context.schoolId, membershipIds],
    )
    // resolveDisplayNames reads only the identity of a row, so the rest is
    // filled with harmless placeholders rather than queried.
    const memberRows: MemberRow[] = found.rows.map((row) => ({
      id: row.id,
      schoolId: context.schoolId,
      userId: row.user_id,
      status: 'active',
      kind: 'adult',
      version: 1,
      accessVersion: 1,
      roleKeys: [],
      staffId: null,
    }))
    for (const [id, name] of await resolveDisplayNames(conn, authPool, context.schoolId, memberRows)) {
      names.set(id, name)
    }
  }
  return rows.rows.map((row) => ({
    at: new Date(row.created_at).toISOString(),
    action: row.action.slice(0, 100),
    actorDisplayName:
      row.actor_membership_id === null
        ? 'System'
        : (names.get(row.actor_membership_id) ?? 'Unnamed member').slice(0, 160),
    outcome: row.result === 'allowed' ? ('allowed' as const) : ('denied' as const),
  }))
}

/**
 * The subject access export of one student (Task 13): everything the system
 * holds about this child, assembled through the very reads the detail screens
 * use, so the caller receives exactly the blocks they could already open one
 * at a time. The sensitive block carries the full APAAR id, because handing a
 * person what we hold about them is the whole point of the request.
 */
export function registerSubjectAccessRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/subject-access',
    permission: 'students.export_subject',
    response: SubjectAccessExport,
    // Handing over everything held about one child is exactly the event a
    // school may be asked about later, so the row names the blocks that left.
    auditRead: {
      targetType: 'student',
      param: 'studentId',
      summary: 'Exported the full student record for a subject access request.',
      detail: (result) => ({
        blocks: [
          ...(result.sensitive === undefined ? [] : ['sensitive']),
          ...(result.medical === undefined ? [] : ['medical']),
          ...(result.guardians.length === 0 ? [] : ['guardians']),
          ...(result.documents.length === 0 ? [] : ['documents']),
          ...(result.consents.length === 0 ? [] : ['consents']),
          ...(result.accessHistory === undefined ? [] : ['accessHistory']),
        ],
      }),
    },
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const may = async (permission: PermissionKey) =>
          (await decideResource(conn, context, permission, 'student', studentId)).allowed

        // Each block is a separate decision, and the sensitive and medical
        // decisions come first because they choose the columns the statement
        // is allowed to name at all.
        const options = {
          sensitive: await may('students.read_sensitive'),
          medical: await may('students.read_medical'),
        }
        const plan = await readPlan(conn, context, 'students.export_subject', 'student')
        const visible = await enrollmentVisibility(conn, context)
        const row = requireFound(await getStudent(conn, plan, visible, studentId, options))
        const student = toStudentBasic(row)

        // An anonymised record holds nothing but the register fields, so the
        // export says so plainly rather than answering with empty blocks.
        const anonymised = student.anonymised

        const sensitiveBlock = options.sensitive && !anonymised ? toStudentSensitive(row) : undefined
        let sensitive: SubjectSensitive | undefined
        if (sensitiveBlock !== undefined) {
          const { apaarMasked: _masked, aadhaarLast4: _last4, ...rest } = sensitiveBlock
          const sealed = row.apaar_ciphertext
          const apaarId =
            typeof sealed === 'string' && sealed !== ''
              ? open(sealed, deps.config.DATA_ENCRYPTION_KEY)
              : undefined
          // This copy goes to the person the record is about, so their own
          // Aadhaar number is opened in full, exactly as the APAAR id is. A
          // guardian's own number stays masked below: a guardian is a
          // different person, and this request is not theirs.
          const sealedAadhaar = row.aadhaar_ciphertext
          const aadhaar =
            typeof sealedAadhaar === 'string' && sealedAadhaar !== ''
              ? open(sealedAadhaar, deps.config.DATA_ENCRYPTION_KEY)
              : undefined
          sensitive = {
            ...rest,
            ...(apaarId === undefined ? {} : { apaarId }),
            ...(aadhaar === undefined ? {} : { aadhaar }),
          }
        }
        const medical = options.medical && !anonymised ? toStudentMedical(row) : undefined

        const guardianPermission: 'students.read_guardians' | 'students.read_guardian_contact' | null =
          anonymised
            ? null
            // A guardian record is its own kind of record, so the full block
            // is decided for the school and then narrowed guardian by guardian
            // by the read plan below, exactly as the guardian list route does.
            : (await decideSchoolAction(conn, context, 'students.read_guardians')).allowed
              ? 'students.read_guardians'
              : (await may('students.read_guardian_contact'))
                ? 'students.read_guardian_contact'
                : null
        const guardianRows =
          guardianPermission === null
            ? []
            : await loadGuardians(conn, context, studentId, guardianPermission)
        const guardians = guardianRows.map((guardian) =>
          toSubjectGuardian(guardian, guardianPermission === 'students.read_guardians'),
        )

        const enrollments = (await may('students.read_enrollments'))
          ? await loadEnrollments(conn, context, studentId)
          : []
        const documents =
          !anonymised && (await may('students.read_documents'))
            ? await loadDocuments(conn, context, studentId)
            : []
        const consents =
          !anonymised && (await may('students.read_consents'))
            ? await loadConsents(conn, context, studentId)
            : []
        // The trail is decided against the school as a whole: there is no one
        // audit row to decide, and the rows named here are this student's.
        const history = (await decideAction(conn, context, 'audit.read', context.schoolId, true))
          .allowed
          ? await loadAccessHistory(conn, context, deps.pools.auth, studentId)
          : undefined

        return {
          generatedAt: new Date().toISOString(),
          schoolId: context.schoolId,
          student,
          ...(sensitive === undefined ? {} : { sensitive }),
          ...(medical === undefined ? {} : { medical }),
          guardians,
          enrollments,
          documents,
          consents,
          ...(history === undefined ? {} : { accessHistory: history }),
        }
      })
    },
  })
}
