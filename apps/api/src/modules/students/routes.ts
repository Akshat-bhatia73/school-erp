import type { FastifyInstance } from 'fastify'
import { sql } from 'drizzle-orm'
import { planPredicate, scopedTableFor } from '@erp/authz'
import { withTenantTransaction } from '@erp/db'
import {
  AuthorizedCount,
  AuthorizedSiblingList,
  EmptySuccess,
  EndEnrollmentRequest,
  GuardianDetail,
  GuardianDetailList,
  MoveStudentRequest,
  StudentBasicDetail,
  StudentCreated,
  StudentDetailByAudience,
  StudentDocumentMetadataList,
  StudentListRequest,
  StudentRosterPage,
  StudentSearchResults,
  StudentsAddGuardianRequest,
  StudentsAdmitRequest,
  StudentsCountRequest,
  StudentsSearchRequest,
  StudentsUpdateGuardianRequest,
  StudentsUpdateSensitiveRequest,
  UpdateStudentBasicRequest,
  EnrollmentSummaryList,
  StudentApaarReveal,
  StudentAadhaarReveal,
  GuardianIdentityReveal,
} from '@erp/contracts'
import type { PermissionKey } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import {
  ApiFailure,
  allowedActionsFor,
  assertUuidParam,
  authorizeResource,
  decideResource,
  open,
  protectedRoute,
  readPlan,
  requireFound,
} from '../shared/index.ts'
import type { ModuleDependencies } from '../shared/route.ts'
import {
  countStudents,
  getStudent,
  listStudents,
  rosterFilters,
  searchStudents,
  siblingIds,
  enrollmentVisibility,
  guardianColumns,
  type ModuleConnection,
  type StudentReadOptions,
} from './reads.ts'
import {
  toGuardianContact,
  toGuardianPrivate,
  toStudentBasic,
  toStudentMedical,
  toStudentSensitive,
  type GuardianRow,
} from './project.ts'
import {
  addGuardian,
  admitStudent,
  currentEnrollment,
  endEnrollment,
  loadGuardian,
  moveStudent,
  touchesMedical,
  updateBasic,
  updateGuardian,
  updateSensitive,
} from './writes.ts'

/** The scoped table description of a resource type, or a startup failure. */
function tableFor(resourceType: 'guardian' | 'student_document' | 'enrollment') {
  const table = scopedTableFor(resourceType)
  if (!table) throw new Error(`the authorizer has no scoped table for ${resourceType}`)
  return table
}

/**
 * A student the caller may read at all. Every nested read starts here, so an
 * unreadable or missing student is one answer: it is simply not there.
 */
async function requireVisibleStudent(
  conn: ModuleConnection,
  context: RequestContext,
  studentId: string,
  options?: StudentReadOptions,
) {
  const plan = await readPlan(conn, context, 'students.read_basic', 'student')
  const visible = await enrollmentVisibility(conn, context)
  return requireFound(await getStudent(conn, plan, visible, studentId, options))
}

export function registerStudentRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  const inTransaction = <T>(context: RequestContext, work: (conn: ModuleConnection) => Promise<T>) =>
    withTenantTransaction(deps.pools.runtime, context, work)

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students',
    permission: 'students.read_basic',
    query: StudentListRequest,
    response: StudentRosterPage,
    handler: async ({ context, query }) =>
      inTransaction(context, async (conn) => {
        const plan = await readPlan(conn, context, 'students.read_basic', 'student')
        const visible = await enrollmentVisibility(conn, context)
        const { rows, total } = await listStudents(conn, plan, visible, query)
        return {
          items: rows.map(toStudentBasic),
          total,
          page: query.page,
          pageSize: query.pageSize,
        }
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/count',
    permission: 'students.read_basic',
    query: StudentsCountRequest,
    response: AuthorizedCount,
    handler: async ({ context, query }) =>
      inTransaction(context, async (conn) => {
        const plan = await readPlan(conn, context, 'students.read_basic', 'student')
        const visible = await enrollmentVisibility(conn, context)
        return { count: await countStudents(conn, plan, visible, rosterFilters(query)) }
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/search',
    permission: 'students.read_basic',
    query: StudentsSearchRequest,
    response: StudentSearchResults,
    handler: async ({ context, query }) =>
      inTransaction(context, async (conn) => {
        const plan = await readPlan(conn, context, 'students.read_basic', 'student')
        const visible = await enrollmentVisibility(conn, context)
        return (await searchStudents(conn, plan, visible, query.q)).map(toStudentBasic)
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId',
    permission: 'students.read_basic',
    response: StudentDetailByAudience,
    // Reading one child's record is the event a school may be asked about, so
    // the row also names which blocks the reader actually received.
    auditRead: {
      targetType: 'student',
      param: 'studentId',
      summary: 'Opened the student record.',
      detail: (result) => ({
        blocks: [
          ...('sensitive' in result ? ['sensitive'] : []),
          ...('medical' in result ? ['medical'] : []),
          ...('guardianContacts' in result ? ['guardianContacts'] : []),
        ],
      }),
    },
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        // Each block is a separate decision, so an audience that may read the
        // roster does not thereby read health notes or a home address. The
        // decisions come first because they choose the columns the statement
        // is allowed to name at all.
        const may = async (permission: PermissionKey) =>
          (await decideResource(conn, context, permission, 'student', studentId)).allowed
        const options = {
          sensitive: await may('students.read_sensitive'),
          medical: await may('students.read_medical'),
        }
        const row = await requireVisibleStudent(conn, context, studentId, options)
        const sensitive = options.sensitive ? toStudentSensitive(row) : undefined
        const medical = options.medical ? toStudentMedical(row) : undefined
        const contacts = (await may('students.read_guardian_contact'))
          ? await loadGuardianRows(conn, context.schoolId, studentId)
          : undefined
        return {
          student: toStudentBasic(row),
          ...(sensitive === undefined ? {} : { sensitive }),
          ...(medical === undefined ? {} : { medical }),
          ...(contacts === undefined
            ? {}
            : {
                guardianContacts: contacts
                  .map(toGuardianContact)
                  .filter((contact): contact is NonNullable<typeof contact> => contact !== undefined),
              }),
          allowedActions: [
            ...(await allowedActionsFor(conn, context, {
              schoolId: context.schoolId,
              resourceType: 'student',
              id: studentId,
            })),
          ],
        }
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/apaar',
    permission: 'students.read_sensitive',
    response: StudentApaarReveal,
    // Seeing the whole identifier is the event worth recording. It is the
    // shared read audit, so a reveal leaves exactly one row.
    auditRead: {
      targetType: 'student',
      param: 'studentId',
      summary: 'Revealed the full APAAR id.',
    },
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await authorizeResource(conn, context, 'students.read_sensitive', 'student', studentId)
        const row = await requireVisibleStudent(conn, context, studentId, {
          sensitive: true,
          medical: false,
        })
        const sealed = row.apaar_ciphertext
        if (typeof sealed !== 'string' || sealed === '') throw new ApiFailure('RESOURCE_NOT_FOUND')
        return { apaarId: open(sealed, deps.config.DATA_ENCRYPTION_KEY) }
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/aadhaar',
    permission: 'students.read_sensitive',
    response: StudentAadhaarReveal,
    // Seeing the whole number is the event worth recording, exactly as it is
    // for the APAAR id, so a reveal leaves one row and a screen leaves none.
    auditRead: {
      targetType: 'student',
      param: 'studentId',
      summary: 'Revealed the full Aadhaar number of a student.',
    },
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await authorizeResource(conn, context, 'students.read_sensitive', 'student', studentId)
        const row = await requireVisibleStudent(conn, context, studentId, {
          sensitive: true,
          medical: false,
        })
        const sealed = row.aadhaar_ciphertext
        if (typeof sealed !== 'string' || sealed === '') throw new ApiFailure('RESOURCE_NOT_FOUND')
        return { aadhaar: open(sealed, deps.config.DATA_ENCRYPTION_KEY) }
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/guardians/:guardianId/identity',
    permission: 'students.read_guardians',
    response: GuardianIdentityReveal,
    auditRead: {
      targetType: 'guardian',
      param: 'guardianId',
      summary: 'Revealed the full identity numbers of a guardian.',
    },
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      const guardianId = assertUuidParam(param('guardianId'))
      return inTransaction(context, async (conn) => {
        // The student must be readable and must actually hold this link, so a
        // guardian cannot be read through a child who is not theirs.
        await requireVisibleStudent(conn, context, studentId)
        await authorizeResource(conn, context, 'students.read_guardians', 'guardian', guardianId)
        requireFound(await loadGuardian(conn, context.schoolId, studentId, guardianId))
        // The sealed columns are named only here, in the one route allowed to
        // open them.
        const rows = await conn.db.execute<{
          pan_ciphertext: string | null
          aadhaar_ciphertext: string | null
        }>(
          sql`SELECT pan_ciphertext, aadhaar_ciphertext FROM guardians
               WHERE school_id = ${context.schoolId}::uuid AND id = ${guardianId}::uuid`,
        )
        const row = requireFound(rows.rows[0] ?? null)
        const key = deps.config.DATA_ENCRYPTION_KEY
        const pan = row.pan_ciphertext === null ? undefined : open(row.pan_ciphertext, key)
        const aadhaar =
          row.aadhaar_ciphertext === null ? undefined : open(row.aadhaar_ciphertext, key)
        // A guardian who carries neither number has nothing to reveal.
        if (pan === undefined && aadhaar === undefined) throw new ApiFailure('RESOURCE_NOT_FOUND')
        return {
          ...(pan === undefined ? {} : { pan }),
          ...(aadhaar === undefined ? {} : { aadhaar }),
        }
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/guardians',
    permission: 'students.read_guardians',
    response: GuardianDetailList,
    auditRead: {
      targetType: 'student',
      param: 'studentId',
      summary: 'Read the guardian details of the student.',
    },
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await requireVisibleStudent(conn, context, studentId)
        const plan = await readPlan(conn, context, 'students.read_guardians', 'guardian')
        const rows = await conn.db.execute<GuardianRow>(
          sql`SELECT ${guardianColumns}
                FROM guardians
                JOIN student_guardians sg ON sg.school_id = guardians.school_id
                 AND sg.guardian_id = guardians.id
               WHERE ${planPredicate(plan, tableFor('guardian'))}
                 AND sg.student_id = ${studentId}::uuid
               ORDER BY sg.is_primary DESC, guardians.id`,
        )
        return rows.rows
          .map(toGuardianPrivate)
          .filter((guardian): guardian is NonNullable<typeof guardian> => guardian !== undefined)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/siblings',
    permission: 'students.read_siblings',
    response: AuthorizedSiblingList,
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await authorizeResource(conn, context, 'students.read_siblings', 'student', studentId)
        const ids = await siblingIds(conn, context.schoolId, studentId)
        // A sibling link never widens access: each sibling is read through the
        // ordinary basic predicate and is dropped when that refuses it.
        const plan = await readPlan(conn, context, 'students.read_basic', 'student')
        const visible = await enrollmentVisibility(conn, context)
        const siblings = []
        for (const id of ids) {
          const row = await getStudent(conn, plan, visible, id)
          if (row) siblings.push(toStudentBasic(row))
        }
        return siblings
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/documents',
    permission: 'students.read_documents',
    response: StudentDocumentMetadataList,
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await requireVisibleStudent(conn, context, studentId)
        const plan = await readPlan(conn, context, 'students.read_documents', 'student_document')
        // The storage key is server state and is never selected here.
        const rows = await conn.db.execute<{
          id: string
          student_id: string
          file_name: string
          document_type: string
          size_bytes: string
          verified: boolean
        }>(
          sql`SELECT student_documents.id, student_documents.student_id, student_documents.file_name,
                     student_documents.document_type, student_documents.size_bytes::text AS size_bytes,
                     student_documents.verified
                FROM student_documents
               WHERE ${planPredicate(plan, tableFor('student_document'))}
                 AND student_documents.student_id = ${studentId}::uuid
               ORDER BY student_documents.id`,
        )
        const documents = []
        for (const row of rows.rows) {
          documents.push({
            id: row.id,
            studentId: row.student_id,
            fileName: row.file_name,
            type: row.document_type,
            sizeBytes: Number(row.size_bytes),
            verified: row.verified,
            allowedActions: await allowedActionsFor(conn, context, {
              schoolId: context.schoolId,
              resourceType: 'student_document',
              id: row.id,
            }),
          })
        }
        return documents
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/students/:studentId/enrollments',
    permission: 'students.read_enrollments',
    response: EnrollmentSummaryList,
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await requireVisibleStudent(conn, context, studentId)
        const plan = await readPlan(conn, context, 'students.read_enrollments', 'enrollment')
        const rows = await conn.db.execute<{
          id: string
          roll_number: number | null
          outcome: string
          year_id: string
          year_name: string
          section_id: string
          section_name: string
          grade_id: string
          grade_name: string
        }>(
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
               ORDER BY enrollments.joined_on DESC, enrollments.id`,
        )
        return rows.rows.map((row) => ({
          id: row.id,
          academicYear: { id: row.year_id, name: row.year_name },
          section: { id: row.section_id, name: row.section_name },
          grade: { id: row.grade_id, name: row.grade_name },
          ...(row.roll_number === null ? {} : { rollNumber: Number(row.roll_number) }),
          outcome: (['ongoing', 'promoted', 'detained', 'left'] as const).find(
            (value) => value === row.outcome,
          ) ?? 'ongoing',
        }))
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/students',
    permission: 'students.create',
    body: StudentsAdmitRequest,
    response: StudentCreated,
    successStatus: 201,
    handler: async ({ context, body }) =>
      inTransaction(context, async (conn) => {
        const studentId = await admitStudent(conn, context, body, deps.config.DATA_ENCRYPTION_KEY)
        const plan = await readPlan(conn, context, 'students.read_basic', 'student')
        const visible = await enrollmentVisibility(conn, context)
        return toStudentBasic(requireFound(await getStudent(conn, plan, visible, studentId)))
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/students/:studentId',
    permission: 'students.update_basic',
    body: UpdateStudentBasicRequest,
    response: StudentBasicDetail,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await authorizeResource(conn, context, 'students.update_basic', 'student', studentId)
        await updateBasic(conn, context, studentId, body)
        const plan = await readPlan(conn, context, 'students.read_basic', 'student')
        const visible = await enrollmentVisibility(conn, context)
        return toStudentBasic(requireFound(await getStudent(conn, plan, visible, studentId)))
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/students/:studentId/sensitive',
    permission: 'students.update_sensitive',
    body: StudentsUpdateSensitiveRequest,
    response: StudentBasicDetail,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await authorizeResource(conn, context, 'students.update_sensitive', 'student', studentId)
        // Writing health fields needs the key that reads them, so an editor
        // who may never see medical notes can never overwrite them either.
        if (touchesMedical(body)) {
          const medical = await decideResource(
            conn,
            context,
            'students.read_medical',
            'student',
            studentId,
          )
          if (!medical.allowed) throw new ApiFailure('ACCESS_DENIED')
        }
        await updateSensitive(conn, context, studentId, body, deps.config.DATA_ENCRYPTION_KEY)
        const plan = await readPlan(conn, context, 'students.read_basic', 'student')
        const visible = await enrollmentVisibility(conn, context)
        return toStudentBasic(requireFound(await getStudent(conn, plan, visible, studentId)))
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/students/:studentId/move',
    permission: 'students.manage_enrollment',
    body: MoveStudentRequest,
    response: EmptySuccess,
    successStatus: 204,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        const enrollment = requireFound(await currentEnrollment(conn, context.schoolId, studentId))
        await authorizeResource(
          conn,
          context,
          'students.manage_enrollment',
          'enrollment',
          enrollment.id,
        )
        await moveStudent(conn, context, studentId, enrollment, body)
        return null
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/students/:studentId/leave',
    permission: 'students.manage_enrollment',
    body: EndEnrollmentRequest,
    response: EmptySuccess,
    successStatus: 204,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        const enrollment = requireFound(await currentEnrollment(conn, context.schoolId, studentId))
        await authorizeResource(
          conn,
          context,
          'students.manage_enrollment',
          'enrollment',
          enrollment.id,
        )
        await endEnrollment(conn, context, studentId, enrollment, body)
        return null
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/students/:studentId/guardians',
    permission: 'students.manage_guardians',
    body: StudentsAddGuardianRequest,
    response: GuardianDetail,
    successStatus: 201,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return inTransaction(context, async (conn) => {
        await requireVisibleStudent(conn, context, studentId)
        if (body.guardianId !== undefined) {
          await authorizeResource(
            conn,
            context,
            'students.manage_guardians',
            'guardian',
            body.guardianId,
          )
        }
        const guardianId = await addGuardian(
          conn,
          context,
          studentId,
          body,
          deps.config.DATA_ENCRYPTION_KEY,
        )
        const row = requireFound(await loadGuardian(conn, context.schoolId, studentId, guardianId))
        // A guardian with no usable telephone number cannot be described by
        // the contract, so the request is rejected rather than half answered.
        const guardian = toGuardianPrivate(row)
        if (!guardian) throw new ApiFailure('INVALID_REQUEST')
        return guardian
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/students/:studentId/guardians/:guardianId',
    permission: 'students.manage_guardians',
    body: StudentsUpdateGuardianRequest,
    response: GuardianDetail,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      const guardianId = assertUuidParam(param('guardianId'))
      return inTransaction(context, async (conn) => {
        await requireVisibleStudent(conn, context, studentId)
        await authorizeResource(conn, context, 'students.manage_guardians', 'guardian', guardianId)
        requireFound(await loadGuardian(conn, context.schoolId, studentId, guardianId))
        await updateGuardian(
          conn,
          context,
          studentId,
          guardianId,
          body,
          deps.config.DATA_ENCRYPTION_KEY,
        )
        const row = requireFound(await loadGuardian(conn, context.schoolId, studentId, guardianId))
        const guardian = toGuardianPrivate(row)
        if (!guardian) throw new ApiFailure('INVALID_REQUEST')
        return guardian
      })
    },
  })
}

/** Guardian rows behind the minimal contact projection on a student detail. */
export async function loadGuardianRows(
  conn: ModuleConnection,
  schoolId: string,
  studentId: string,
): Promise<GuardianRow[]> {
  const rows = await conn.db.execute<GuardianRow>(
    sql`SELECT ${guardianColumns}
          FROM guardians
          JOIN student_guardians sg ON sg.school_id = guardians.school_id
           AND sg.guardian_id = guardians.id
         WHERE guardians.school_id = ${schoolId}::uuid AND sg.student_id = ${studentId}::uuid
         ORDER BY sg.is_primary DESC, guardians.id`,
  )
  return rows.rows
}
