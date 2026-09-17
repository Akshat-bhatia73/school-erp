import type { FastifyInstance } from 'fastify'
import { and, eq, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import {
  GradeSubjectList,
  SetupGradeSubjectListQuery,
  SetupGradeSubjectsRequest,
  SetupSubjectUpdateRequest,
  Subject,
  SubjectInput,
  SubjectList,
} from '@erp/contracts'
import { AuthorizationError, planPredicate } from '@erp/authz'
import { gradeSubjects, grades, subjects } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { protectedRoute, type ModuleDependencies } from '../shared/route.ts'
import { authorizeSchoolAction, readPlan } from '../shared/authorize.ts'
import { lockSchool, writeAudit } from '../shared/audit.ts'
import { bumpVersion } from '../shared/version.ts'
import { ApiFailure, requireFound } from '../shared/errors.ts'
import {
  refuseWhenReferenced,
  requireQueryUuid,
  requireReference,
  requireUuid,
  scopedTable,
} from './common.ts'

type SubjectResponse = z.infer<typeof Subject>

const columns = {
  id: subjects.id,
  schoolId: subjects.schoolId,
  name: subjects.name,
  code: subjects.code,
  type: subjects.type,
  version: subjects.version,
}

const TYPES = ['scholastic', 'co_scholastic', 'language', 'elective'] as const

function toSubject(row: {
  id: string
  schoolId: string
  name: string
  code: string
  type: string
  version: number
}): SubjectResponse {
  const type = TYPES.find((value) => value === row.type)
  if (!type) throw new ApiFailure('SERVICE_UNAVAILABLE')
  return { ...row, type }
}

/** A subject cannot go while a class, timetable or substitution names it. */
const SUBJECT_REFERENCES = [
  { table: 'grade_subjects', column: 'subject_id' },
  { table: 'teaching_assignments', column: 'subject_id' },
  { table: 'timetable_entries', column: 'subject_id' },
  { table: 'substitutions', column: 'subject_id' },
] as const

export function registerSubjectRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/subjects',
    permission: 'subjects.read',
    response: SubjectList,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const plan = await readPlan(conn, context, 'subjects.read', 'subject')
        const rows = await conn.db
          .select(columns)
          .from(subjects)
          .where(planPredicate(plan, scopedTable('subject')))
          .orderBy(subjects.name)
        return rows.map(toSubject)
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/grade-subjects',
    permission: 'subjects.read',
    query: SetupGradeSubjectListQuery,
    response: GradeSubjectList,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A mapping names two records, so both sides are scoped: the caller
        // must be allowed to read the subject AND the class. Scoping only the
        // subject would let a teacher enumerate another class's curriculum by
        // naming its id, which the grade list itself would refuse.
        const subjectPlan = await readPlan(conn, context, 'subjects.read', 'subject')
        // A caller who may read no class at all can see no mapping either;
        // that is an empty list, not a refusal, because the gate permission of
        // this list is subjects.read.
        const gradePlan = await readPlan(conn, context, 'grades.read', 'grade').catch((error: unknown) => {
          if (error instanceof AuthorizationError) return null
          throw error
        })
        if (!gradePlan) return []
        const filters: SQL[] = [
          planPredicate(subjectPlan, scopedTable('subject')),
          planPredicate(gradePlan, scopedTable('grade')),
          eq(gradeSubjects.academicYearId, requireQueryUuid(query.academicYearId)),
          eq(gradeSubjects.schoolId, subjects.schoolId),
          eq(gradeSubjects.schoolId, grades.schoolId),
        ]
        if (query.gradeId) filters.push(eq(gradeSubjects.gradeId, requireQueryUuid(query.gradeId)))
        const rows = await conn.db
          .select({
            gradeId: gradeSubjects.gradeId,
            academicYearId: gradeSubjects.academicYearId,
            subjectId: subjects.id,
            subjectName: subjects.name,
          })
          .from(gradeSubjects)
          .innerJoin(subjects, eq(subjects.id, gradeSubjects.subjectId))
          .innerJoin(grades, eq(grades.id, gradeSubjects.gradeId))
          .where(and(...filters))
          .orderBy(subjects.name)
        return rows.map((row) => ({
          gradeId: row.gradeId,
          academicYearId: row.academicYearId,
          subject: { id: row.subjectId, name: row.subjectName },
        }))
      }),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/subjects',
    permission: 'subjects.manage',
    body: SubjectInput,
    response: Subject,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'subjects.manage')
        const duplicate = await conn.client.query('SELECT 1 FROM subjects WHERE school_id = $1 AND code = $2', [
          context.schoolId,
          body.code,
        ])
        if (duplicate.rowCount !== null && duplicate.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO subjects(school_id, name, code, type) VALUES ($1, $2, $3, $4) RETURNING id`,
          [context.schoolId, body.name, body.code, body.type],
        )
        const id = requireFound(inserted.rows[0]).id
        await writeAudit(conn, context, {
          action: 'subjects.manage',
          targetType: 'subject',
          targetId: id,
          summary: 'Created a subject.',
        })
        const rows = await conn.db.select(columns).from(subjects).where(eq(subjects.id, id)).limit(1)
        return toSubject(requireFound(rows[0]))
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/subjects/:subjectId',
    permission: 'subjects.manage',
    body: SetupSubjectUpdateRequest,
    response: Subject,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('subjectId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'subjects.manage')
        const clash = await conn.client.query(
          'SELECT 1 FROM subjects WHERE school_id = $1 AND code = $2 AND id <> $3',
          [context.schoolId, body.code, id],
        )
        if (clash.rowCount !== null && clash.rowCount > 0) throw new ApiFailure('INVALID_REQUEST')

        await bumpVersion(conn, 'subjects', {
          schoolId: context.schoolId,
          id,
          expectedVersion: body.expectedVersion,
          set: { name: body.name, code: body.code, type: body.type },
        })
        await writeAudit(conn, context, {
          action: 'subjects.manage',
          targetType: 'subject',
          targetId: id,
          summary: 'Updated a subject.',
        })
        const rows = await conn.db.select(columns).from(subjects).where(eq(subjects.id, id)).limit(1)
        return toSubject(requireFound(rows[0]))
      }),
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: '/api/schools/:schoolId/subjects/:subjectId',
    permission: 'subjects.manage',
    response: z.null(),
    successStatus: 204,
    handler: async ({ context, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const id = requireUuid(param('subjectId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'subjects.manage')
        const existing = await conn.client.query('SELECT 1 FROM subjects WHERE school_id = $1 AND id = $2', [
          context.schoolId,
          id,
        ])
        if (existing.rowCount === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')
        await refuseWhenReferenced(conn, context.schoolId, SUBJECT_REFERENCES, id)

        await conn.client.query('DELETE FROM subjects WHERE school_id = $1 AND id = $2', [context.schoolId, id])
        await writeAudit(conn, context, {
          action: 'subjects.manage',
          targetType: 'subject',
          targetId: id,
          summary: 'Removed a subject nothing referred to.',
        })
        return null
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/grades/:gradeId/subjects',
    permission: 'subjects.manage',
    body: SetupGradeSubjectsRequest,
    response: GradeSubjectList,
    handler: async ({ context, body, param }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const gradeId = requireUuid(param('gradeId'))
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'subjects.manage')
        await requireReference(conn, 'grades', context.schoolId, gradeId)
        await requireReference(conn, 'academic_years', context.schoolId, body.academicYearId)
        // Every subject is checked before anything is written, so one unknown
        // id leaves the class exactly as it was.
        for (const subjectId of body.subjectIds) {
          await requireReference(conn, 'subjects', context.schoolId, subjectId)
        }

        await conn.client.query(
          'DELETE FROM grade_subjects WHERE school_id = $1 AND grade_id = $2 AND academic_year_id = $3',
          [context.schoolId, gradeId, body.academicYearId],
        )
        for (const subjectId of body.subjectIds) {
          await conn.client.query(
            `INSERT INTO grade_subjects(school_id, grade_id, academic_year_id, subject_id)
             VALUES ($1, $2, $3, $4)`,
            [context.schoolId, gradeId, body.academicYearId, subjectId],
          )
        }
        await writeAudit(conn, context, {
          action: 'subjects.manage',
          targetType: 'grade',
          targetId: gradeId,
          summary: 'Replaced the subjects a class studies this year.',
          safeChanges: { subjectCount: body.subjectIds.length },
        })

        const rows = await conn.db
          .select({ id: subjects.id, name: subjects.name })
          .from(gradeSubjects)
          .innerJoin(subjects, eq(subjects.id, gradeSubjects.subjectId))
          .where(
            and(
              eq(gradeSubjects.schoolId, context.schoolId),
              eq(gradeSubjects.gradeId, gradeId),
              eq(gradeSubjects.academicYearId, body.academicYearId),
            ),
          )
          .orderBy(subjects.name)
        return rows.map((row) => ({
          gradeId,
          academicYearId: body.academicYearId,
          subject: { id: row.id, name: row.name },
        }))
      }),
  })
}
