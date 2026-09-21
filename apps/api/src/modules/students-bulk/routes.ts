import type { FastifyInstance } from 'fastify'
import { and, inArray, sql } from 'drizzle-orm'
import { enrollments, students } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { planPredicate, scopedTableFor } from '@erp/authz'
import {
  BulkCommitResult,
  CommitStudentImportRequest,
  ExportStudentsRequest,
  PromoteStudentsRequest,
  PromotionPreview,
  PromotionResult,
  StudentExportJob,
  StudentImportPreview,
  StudentsImportPreviewRequest,
  StudentsPromotePreviewQuery,
} from '@erp/contracts'
import { photoMoment } from '../students/project.ts'
import { createAndMaybeProduce } from '../../exports/run.ts'
import type { ModuleDependencies } from '../shared/route.ts'
import { protectedRoute } from '../shared/route.ts'
import { ApiFailure } from '../shared/errors.ts'
import { authorizeSchoolAction, readPlan } from '../shared/authorize.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { allocateAdmissionNumber, syncAdmissionSequence } from '../shared/sequences.ts'
import { assertVersion, bumpVersion } from '../shared/version.ts'
import {
  insertStudent,
  lockPreview,
  requireAcademicYear,
  revalidate,
  validateRows,
  type StoredImportRow,
} from './import.ts'
import {
  assertAllEnrolled,
  assertNotAlreadyInYear,
  closeEnrollments,
  detainedSection,
  openEnrollments,
  sectionInYear,
} from './promote.ts'

const BASE = '/api/schools/:schoolId/students'

/** As many students as one promote request may name: 100 promoted, 100 detained. */
const ROSTER_LIMIT = 200

/** The one table these routes list students through, with its scope columns. */
function studentTable() {
  const table = scopedTableFor('student')
  // The catalogue and the scoped tables are written together; a missing entry
  // is a programming error, never something a request can cause.
  if (!table) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return table
}

/**
 * Bulk student work: staged imports, year-end promotion and export requests.
 * Each one touches many records at once, so each authorizes the whole request
 * before it writes anything and refuses the lot if a single record fails.
 */
export function registerStudentBulkRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/import/preview`,
    permission: 'students.import',
    body: StudentsImportPreviewRequest,
    response: StudentImportPreview,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'students.import')
        await requireAcademicYear(conn.client, context.schoolId, body.academicYearId)

        const outcome = await validateRows(conn.client, context.schoolId, body)
        const inserted = await conn.client.query<{ id: string; version: number; expires_at: Date }>(
          `INSERT INTO student_import_previews
             (school_id, created_by_membership_id, academic_year_id, status,
              total_rows, valid_rows, rows, errors, expires_at)
           VALUES ($1, $2, $3, 'pending', $4, $5, $6::jsonb, $7::jsonb, now() + interval '1 hour')
           RETURNING id, version, expires_at`,
          [
            context.schoolId,
            context.membershipId,
            body.academicYearId,
            body.rows.length,
            outcome.validRows.length,
            JSON.stringify(outcome.validRows),
            JSON.stringify(outcome.errors),
          ],
        )
        const preview = inserted.rows[0]
        if (!preview) throw new ApiFailure('SERVICE_UNAVAILABLE')

        await writeAudit(conn, context, {
          action: 'students.import',
          targetType: 'student_import_preview',
          targetId: preview.id,
          summary: 'Checked an uploaded student sheet and stored the rows that passed.',
          safeChanges: {
            totalRows: body.rows.length,
            validRows: outcome.validRows.length,
            errorCount: outcome.errors.length,
          },
        })

        return {
          id: preview.id,
          version: Number(preview.version),
          expiresAt: preview.expires_at.toISOString(),
          totalRows: body.rows.length,
          validRows: outcome.validRows.length,
          // One entry per row that passed, so the screen can say which number
          // the sheet keeps and which one is assigned when the sheet commits.
          rows: outcome.validRows.map((row) => ({
            rowNumber: row.rowNumber,
            firstName: row.firstName,
            ...(row.lastName === undefined ? {} : { lastName: row.lastName }),
            ...(row.admissionNumber === undefined ? {} : { admissionNumber: row.admissionNumber }),
          })),
          errors: outcome.errors.map((error) => ({ ...error })),
        }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/import/commit`,
    permission: 'students.import',
    body: CommitStudentImportRequest,
    response: BulkCommitResult,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'students.import')
        await lockSchool(conn, context.schoolId)

        const preview = await lockPreview(conn.client, context, body.previewId)
        assertVersion(body.expectedVersion, Number(preview.version))
        const rows: readonly StoredImportRow[] = preview.rows
        await revalidate(conn.client, context.schoolId, preview.academic_year_id, rows)

        // A kept number is one the school already uses, so the counter has to
        // clear it before anything is allocated: otherwise a generated number
        // would collide with a kept one and the whole commit would roll back.
        await syncAdmissionSequence(
          conn,
          context.schoolId,
          preview.academic_year_id,
          rows.map((row) => row.admissionNumber).filter((value): value is string => value !== undefined),
        )
        // Row order decides the counter, so a sheet reads in the same order it
        // was written. A row that carried its own number keeps it.
        for (const row of rows) {
          const admissionNumber =
            row.admissionNumber ??
            (await allocateAdmissionNumber(conn, context.schoolId, preview.academic_year_id, {
              synced: true,
            }))
          await insertStudent(
            conn.client,
            context.schoolId,
            preview.academic_year_id,
            row,
            admissionNumber,
          )
        }
        await bumpVersion(conn, 'student_import_previews', {
          schoolId: context.schoolId,
          id: preview.id,
          expectedVersion: body.expectedVersion,
          set: { status: 'committed' },
        })

        await writeAudit(conn, context, {
          action: 'students.import',
          targetType: 'student_import_preview',
          targetId: preview.id,
          summary: 'Admitted a checked sheet of students with their class and one contact each.',
          safeChanges: { created: rows.length },
        })
        return { created: rows.length }
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: `${BASE}/promote/preview`,
    permission: 'students.promote',
    query: StudentsPromotePreviewQuery,
    response: PromotionPreview,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'students.promote')
        // A read never admits that a section of another school exists.
        await sectionInYear(
          conn.client,
          context.schoolId,
          query.fromAcademicYearId,
          query.fromSectionId,
          'RESOURCE_NOT_FOUND',
        )
        const target = await sectionInYear(
          conn.client,
          context.schoolId,
          query.toAcademicYearId,
          query.toSectionId,
          'RESOURCE_NOT_FOUND',
        )

        // The cohort is read through the ordinary student read plan, so this
        // list shows exactly the students the caller could open one by one.
        const plan = await readPlan(conn, context, 'students.read_basic', 'student')
        const table = studentTable()
        const rows = await conn.db
          .select({
            id: students.id,
            schoolId: students.schoolId,
            version: students.version,
            firstName: students.firstName,
            lastName: students.lastName,
            admissionNumber: students.admissionNumber,
            status: students.status,
            anonymisedAt: students.anonymisedAt,
            // Whether there is a photograph, never where its bytes live.
            hasPhoto: sql<boolean>`(${students.photoStorageKey} IS NOT NULL)`,
            photoUpdatedAt: students.photoUpdatedAt,
          })
          .from(students)
          .where(
            and(
              planPredicate(plan, table),
              // Asked as EXISTS rather than a join: a student holding two open
              // rows in the same class must still appear exactly once.
              sql`EXISTS (SELECT 1 FROM ${enrollments}
                   WHERE ${enrollments.schoolId} = ${students.schoolId}
                     AND ${enrollments.studentId} = ${students.id}
                     AND ${enrollments.academicYearId} = ${query.fromAcademicYearId}
                     AND ${enrollments.sectionId} = ${query.fromSectionId}
                     AND ${enrollments.leftOn} IS NULL)`,
            ),
          )
          .orderBy(students.admissionNumber)
          // PromotionPreview carries no page or total, so the roster is capped
          // at what one promote request can act on (100 promoted plus 100
          // detained). A class larger than that cannot be moved in one call
          // anyway; this is the documented deviation from the coverage sheet.
          .limit(ROSTER_LIMIT)

        return {
          students: rows.map((row) => ({
            id: row.id,
            schoolId: row.schoolId,
            version: Number(row.version),
            firstName: row.firstName,
            ...(row.lastName ? { lastName: row.lastName } : {}),
            admissionNumber: row.admissionNumber,
            status: row.status as 'active' | 'left' | 'alumni' | 'suspended',
            anonymised: row.anonymisedAt !== null,
            hasPhoto: row.hasPhoto === true,
            ...(photoMoment(row.photoUpdatedAt) === undefined
              ? {}
              : { photoUpdatedAt: photoMoment(row.photoUpdatedAt) as string }),
          })),
          targetSection: { id: target.id, name: `${target.gradeName} ${target.name}` },
        }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/promote`,
    permission: 'students.promote',
    body: PromoteStudentsRequest,
    response: PromotionResult,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'students.promote')
        await lockSchool(conn, context.schoolId)

        const from = await sectionInYear(
          conn.client,
          context.schoolId,
          body.fromAcademicYearId,
          body.fromSectionId,
        )
        await sectionInYear(conn.client, context.schoolId, body.toAcademicYearId, body.toSectionId)

        const everyone = [...body.studentIds, ...body.detainedStudentIds]
        await assertAllEnrolled(
          conn.client,
          context.schoolId,
          body.fromAcademicYearId,
          body.fromSectionId,
          everyone,
        )
        await assertNotAlreadyInYear(conn.client, context.schoolId, body.toAcademicYearId, everyone)

        const repeatSectionId =
          body.detainedStudentIds.length === 0
            ? null
            : await detainedSection(
                conn.client,
                context.schoolId,
                body.toAcademicYearId,
                from.gradeId,
                from.name,
              )

        await closeEnrollments(
          conn.client,
          context.schoolId,
          body.fromAcademicYearId,
          body.fromSectionId,
          body.studentIds,
          'promoted',
        )
        await openEnrollments(
          conn.client,
          context.schoolId,
          body.toAcademicYearId,
          body.toSectionId,
          body.studentIds,
        )
        if (repeatSectionId) {
          await closeEnrollments(
            conn.client,
            context.schoolId,
            body.fromAcademicYearId,
            body.fromSectionId,
            body.detainedStudentIds,
            'detained',
          )
          await openEnrollments(
            conn.client,
            context.schoolId,
            body.toAcademicYearId,
            repeatSectionId,
            body.detainedStudentIds,
          )
        }

        await writeAudit(conn, context, {
          action: 'students.promote',
          targetType: 'section',
          targetId: body.fromSectionId,
          summary: 'Moved a class into the next academic year and kept the detained students in the same grade.',
          // The operator's reason is deliberately not copied into the audit
          // row: it is free text and often names a child, and audit summaries
          // must stay free of personal detail. Counts are what this row proves.
          safeChanges: {
            promoted: body.studentIds.length,
            detained: body.detainedStudentIds.length,
          },
        })
        return { promoted: body.studentIds.length, detained: body.detainedStudentIds.length }
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/export`,
    permission: 'students.export',
    body: ExportStudentsRequest,
    response: StudentExportJob,
    successStatus: 202,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'students.export')

        // The export permission has its own scope, so the set is counted in
        // SQL through that plan. A single record the caller may not export
        // refuses the whole job, and the answer never says which one.
        const plan = await readPlan(conn, context, 'students.export', 'student')
        const table = studentTable()
        const counted = await conn.db
          .select({ total: sql<number>`count(*)::int` })
          .from(students)
          .where(and(planPredicate(plan, table), inArray(students.id, [...body.studentIds])))
        if ((counted[0]?.total ?? 0) !== body.studentIds.length) {
          throw new ApiFailure('RESOURCE_NOT_FOUND')
        }

        const job = await conn.client.query<{ id: string }>(
          `INSERT INTO export_jobs
             (school_id, requested_by_membership_id, kind, status, access_version,
              permission, criteria, row_count, expires_at)
           VALUES ($1, $2, 'students', 'queued', $3, 'students.export', $4::jsonb, $5,
                   now() + interval '1 day')
           RETURNING id`,
          [
            context.schoolId,
            context.membershipId,
            context.accessVersion,
            JSON.stringify({ studentIds: body.studentIds }),
            body.studentIds.length,
          ],
        )
        const row = job.rows[0]
        if (!row) throw new ApiFailure('SERVICE_UNAVAILABLE')

        await writeAudit(conn, context, {
          action: 'students.export',
          targetType: 'export_job',
          targetId: row.id,
          summary: 'Requested an export of a chosen set of students.',
          safeChanges: { rowCount: body.studentIds.length },
        })
        // A small export is produced here, so the answer already names a file
        // to download. A big one stays queued for the daily route. Either way
        // this request wrote exactly one audit row, the one above.
        return createAndMaybeProduce(deps, conn, context, {
          id: row.id,
          estimatedRows: body.studentIds.length,
        })
      }),
  })
}
