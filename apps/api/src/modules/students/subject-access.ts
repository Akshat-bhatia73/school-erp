import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { AuthorizationError, communicationScopedTable, planPredicate, scopedTableFor } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import { SubjectAccessExport } from '@erp/contracts'
import type {
  AttendanceMark,
  AttendanceYearRecord,
  ConsentMethod,
  ConsentPurpose,
  ConsentRecord,
  ConsentStatus,
  ExamResultsResponse,
  PermissionKey,
  ReportCardView,
  SubjectAccessEvent,
  SubjectAssistantConversation,
  SubjectMessage,
  SubjectSensitive,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { decideAction } from '../../memberships/authorize.ts'
import { readStatement } from '../fees/statement.ts'
import {
  attendanceFiguresCte,
  attendancePlans,
  schoolToday,
  toSummary,
  type FiguresRow,
} from '../attendance/figures.ts'
import { examPlans, mayOnExam, mayOnReportCard, reportCardPlans } from '../exams/common.ts'
import { readStudentResults } from '../exams/reads.ts'
import { readReportCardView } from '../report-cards/reads.ts'
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

/**
 * The years this pupil has fee data in: one they were enrolled for, or one a
 * ledger row of theirs belongs to. A leaver still has both, which is the
 * point: the statements go back as far as the money does.
 */
async function feeYears(
  conn: ModuleConnection,
  schoolId: string,
  studentId: string,
): Promise<string[]> {
  const rows = await conn.client.query<{ id: string }>(
    `SELECT ay.id
       FROM academic_years ay
      WHERE ay.school_id = $1
        AND (EXISTS (SELECT 1 FROM enrollments e
                      WHERE e.school_id = ay.school_id AND e.academic_year_id = ay.id
                        AND e.student_id = $2)
          OR EXISTS (SELECT 1 FROM fee_receipts r
                      WHERE r.school_id = ay.school_id AND r.academic_year_id = ay.id
                        AND r.student_id = $2))
      ORDER BY ay.start_date, ay.id
      LIMIT 30`,
    [schoolId, studentId],
  )
  return rows.rows.map((row) => row.id)
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

/** A year of marks is long, but a pupil's whole school life is not endless. */
const ATTENDANCE_MARK_LIMIT = 400

/**
 * Every mark this pupil carries, year by year, through the caller's own
 * attendance plan and the same figures the screens use. A year the pupil was
 * never enrolled in is not here, and the summary counts the whole year up to
 * today.
 */
async function loadAttendanceYears(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
): Promise<AttendanceYearRecord[]> {
  const schoolId = context.schoolId
  const plans = await attendancePlans(conn, context)
  const today = await schoolToday(conn, schoolId)
  const years = await conn.db.execute<{ id: string; name: string; start_date: string; end_date: string }>(
    sql`SELECT ay.id, ay.name,
               to_char(ay.start_date, 'YYYY-MM-DD') AS start_date,
               to_char(ay.end_date, 'YYYY-MM-DD') AS end_date
          FROM academic_years ay
         WHERE ay.school_id = ${schoolId}::uuid
           AND EXISTS (SELECT 1 FROM enrollments
                        WHERE enrollments.school_id = ay.school_id
                          AND enrollments.academic_year_id = ay.id
                          AND enrollments.student_id = ${studentId}::uuid)
         ORDER BY ay.start_date, ay.id`,
  )

  const records: AttendanceYearRecord[] = []
  for (const year of years.rows) {
    const cte = attendanceFiguresCte({
      schoolId,
      from: year.start_date,
      to: year.end_date,
      asOf: today,
      holidays: plans.holidays,
      spans: sql`enrollments.student_id = ${studentId}::uuid
                 AND enrollments.academic_year_id = ${year.id}::uuid
                 AND EXISTS (SELECT 1 FROM students
                              WHERE students.school_id = enrollments.school_id
                                AND students.id = enrollments.student_id
                                AND (${plans.pupils}))`,
      entries: plans.entries,
    })
    const marks = await conn.db.execute<{ day: string; mark: AttendanceMark; corrected: boolean | null }>(
      sql`${cte}
          SELECT to_char(day, 'YYYY-MM-DD') AS day, mark, corrected
            FROM att_pupil_days
           WHERE mark IS NOT NULL
           ORDER BY day
           LIMIT ${ATTENDANCE_MARK_LIMIT}`,
    )
    const figures = await conn.db.execute<FiguresRow>(sql`${cte} SELECT * FROM att_figures`)
    records.push({
      academicYear: { id: year.id, name: year.name.slice(0, 160) },
      marks: marks.rows.map((row) => ({
        date: row.day,
        mark: row.mark,
        corrected: row.corrected === true,
      })),
      summary: toSummary(figures.rows[0]),
    })
  }
  return records
}

/**
 * The subject access export of one student (Task 13): everything the system
 * holds about this child, assembled through the very reads the detail screens
 * use, so the caller receives exactly the blocks they could already open one
 * at a time. The sensitive block carries the full APAAR id, because handing a
 * person what we hold about them is the whole point of the request.
 */

/**
 * The pupil's results for every year they have a mark in, each exactly as the
 * results screen answers this caller. The years come from the marks the
 * caller's own plan reaches, so a parent's copy names only years with a
 * published mark, and each year is the published figure, never a live one.
 */
async function loadExamYears(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
): Promise<ExamResultsResponse[]> {
  const plans = await examPlans(conn, context)
  const years = await conn.db.execute<{ academic_year_id: string }>(
    sql`SELECT exam_marks.academic_year_id
          FROM exam_marks
          JOIN academic_years ay ON ay.school_id = exam_marks.school_id AND ay.id = exam_marks.academic_year_id
         WHERE exam_marks.school_id = ${context.schoolId}::uuid
           AND exam_marks.student_id = ${studentId}::uuid
           AND (${plans.marks})
         GROUP BY exam_marks.academic_year_id, ay.start_date
         ORDER BY ay.start_date DESC
         LIMIT 30`,
  )
  const results: ExamResultsResponse[] = []
  for (const row of years.rows) {
    results.push(await readStudentResults(conn, context, studentId, row.academic_year_id))
  }
  return results
}

/**
 * Every published report card version of the pupil the caller's plan reaches,
 * newest first, each shaped for the caller's view exactly as the card screen
 * shapes it (grades alone for a family when the card was published so).
 */
async function loadReportCards(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
): Promise<ReportCardView[]> {
  const plans = await reportCardPlans(conn, context)
  const versions = await conn.db.execute<{ id: string }>(
    sql`SELECT report_card_versions.id
          FROM report_card_versions
         WHERE report_card_versions.school_id = ${context.schoolId}::uuid
           AND report_card_versions.student_id = ${studentId}::uuid
           AND (${plans.cards})
         ORDER BY report_card_versions.published_at DESC, report_card_versions.version_number DESC
         LIMIT 120`,
  )
  const cards: ReportCardView[] = []
  for (const row of versions.rows) cards.push(await readReportCardView(conn, context, row.id))
  return cards
}

/**
 * The messages about this pupil that went out, under the caller's own
 * communication.read plan, newest first. Undefined when the caller holds that
 * key nowhere, so the block is left out rather than emptied. A parent's plan
 * reaches what was addressed to them.
 */
async function loadMessages(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
): Promise<SubjectMessage[] | undefined> {
  let predicate
  try {
    predicate = planPredicate(
      await readPlan(conn, context, 'communication.read', 'communication'),
      communicationScopedTable('message'),
    )
  } catch (error) {
    if (error instanceof AuthorizationError && error.code === 'ACCESS_DENIED') return undefined
    throw error
  }
  const result = await conn.db.execute<{
    id: string
    kind: SubjectMessage['kind']
    title: string
    body: string
    sent_at: string
  }>(
    sql`SELECT messages.id, messages.kind, messages.title, messages.body,
               to_char(messages.sent_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS sent_at
          FROM messages
         WHERE messages.school_id = ${context.schoolId}::uuid
           AND messages.student_id = ${studentId}::uuid
           AND messages.status = 'sent'
           AND messages.sent_at IS NOT NULL
           AND (${predicate})
         ORDER BY messages.sent_at DESC, messages.id DESC
         LIMIT 500`,
  )
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    sentAt: row.sent_at,
  }))
}

interface ConversationRow {
  id: string
  title_sealed: string | null
  created_at: string
}

/** The text of a kept UI message: its text parts, in order. */
function messageText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .flatMap((part: unknown) =>
      typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : [],
    )
    .join('')
    .trim()
    .slice(0, 40000)
}

/**
 * The pupil's own assistant conversations (Task 24), opened from their sealed
 * form. They belong to the pupil's login, found through the link that names
 * the pupil; undefined when the pupil never had a login.
 */
async function loadAssistantConversations(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  key: string,
): Promise<SubjectAssistantConversation[] | undefined> {
  const logins = await conn.client.query<{ membership_id: string }>(
    `SELECT membership_id FROM membership_student_links WHERE school_id = $1 AND student_id = $2`,
    [context.schoolId, studentId],
  )
  if (logins.rows.length === 0) return undefined
  const iso = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`
  const threads = await conn.client.query<ConversationRow>(
    `SELECT id, title_sealed, to_char(created_at AT TIME ZONE 'UTC', ${iso}) AS created_at
       FROM assistant_threads
      WHERE school_id = $1 AND membership_id = ANY($2::uuid[])
      ORDER BY created_at DESC, id
      LIMIT 500`,
    [context.schoolId, logins.rows.map((row) => row.membership_id)],
  )
  const conversations: SubjectAssistantConversation[] = []
  for (const thread of threads.rows) {
    const kept = await conn.client.query<{ role: 'user' | 'assistant'; content_sealed: string; created_at: string }>(
      `SELECT role, content_sealed, to_char(created_at AT TIME ZONE 'UTC', ${iso}) AS created_at
         FROM assistant_messages
        WHERE school_id = $1 AND thread_id = $2
        ORDER BY created_at, id
        LIMIT 400`,
      [context.schoolId, thread.id],
    )
    const messages = kept.rows.flatMap((row) => {
      const text = messageText((JSON.parse(open(row.content_sealed, key)) as { parts?: unknown }).parts)
      return text === '' ? [] : [{ role: row.role, text, createdAt: row.created_at }]
    })
    if (messages.length === 0) continue
    conversations.push({
      id: thread.id,
      title: thread.title_sealed === null ? 'Conversation' : open(thread.title_sealed, key),
      createdAt: thread.created_at,
      messages,
    })
  }
  return conversations
}

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
          ...(result.fees === undefined ? [] : ['fees']),
          ...(result.attendance === undefined ? [] : ['attendance']),
          ...(result.exams === undefined ? [] : ['exams']),
          ...(result.reportCards === undefined ? [] : ['reportCards']),
          ...(result.messages === undefined ? [] : ['messages']),
          ...(result.accessHistory === undefined ? [] : ['accessHistory']),
          ...(result.assistantConversations === undefined ? [] : ['assistantConversations']),
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
        // The money is kept even when everything else about the child has
        // been cleared: the accounts must stand for eight years, so an
        // anonymised pupil still exports their fee statements. The block is
        // left out altogether, rather than emptied, when the caller may not
        // read this pupil's fees.
        const feeDecision = await decideResource(conn, context, 'fees.read', 'fee', studentId)
        const fees = feeDecision.allowed
          ? await (async () => {
              const statements = []
              for (const yearId of await feeYears(conn, context.schoolId, studentId)) {
                statements.push(await readStatement(conn, context, studentId, yearId))
              }
              return statements
            })()
          : undefined

        // Attendance is decided on the pupil, exactly as their own month is,
        // and the block is left out altogether rather than emptied when the
        // caller may not read it.
        const attendanceDecision = await decideResource(conn, context, 'attendance.read', 'attendance', studentId)
        const attendance = attendanceDecision.allowed
          ? await loadAttendanceYears(conn, context, studentId)
          : undefined

        // Marks and report cards are decided on the pupil, exactly as their
        // results and their cards are, and each block is left out rather
        // than emptied when refused. A family's plan reaches published rows
        // only, so a parent's copy never holds a mark before it is published.
        const exams = (await mayOnExam(conn, context, 'exams.read', studentId))
          ? await loadExamYears(conn, context, studentId)
          : undefined
        const reportCards = (await mayOnReportCard(conn, context, 'report_cards.read', studentId))
          ? await loadReportCards(conn, context, studentId)
          : undefined

        // Messages about the pupil, under the caller's own messages plan; left
        // out when the caller holds communication.read nowhere.
        const messages = await loadMessages(conn, context, studentId)

        // The trail is decided against the school as a whole: there is no one
        // audit row to decide, and the rows named here are this student's.
        const history = (await decideAction(conn, context, 'audit.read', context.schoolId, true))
          .allowed
          ? await loadAccessHistory(conn, context, deps.pools.auth, studentId)
          : undefined

        // The pupil's own conversations with the assistant: they are the
        // pupil's words, so they are part of what is held about the pupil.
        const assistantConversations = anonymised
          ? undefined
          : await loadAssistantConversations(conn, context, studentId, deps.config.DATA_ENCRYPTION_KEY)

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
          ...(fees === undefined ? {} : { fees }),
          ...(attendance === undefined ? {} : { attendance }),
          ...(exams === undefined ? {} : { exams }),
          ...(reportCards === undefined ? {} : { reportCards }),
          ...(messages === undefined ? {} : { messages }),
          ...(history === undefined ? {} : { accessHistory: history }),
          ...(assistantConversations === undefined ? {} : { assistantConversations }),
        }
      })
    },
  })
}
