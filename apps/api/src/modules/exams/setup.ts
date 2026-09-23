import type { FastifyInstance } from 'fastify'
import {
  ExamCreateRequest,
  ExamListRequest,
  ExamListResponse,
  ExamOverview,
  ExamSchedule,
  ExamUpdateRequest,
} from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  assertUuidParam,
  authorizeSchoolAction,
  bumpVersion,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { decideExam, readExam, type ExamConnection } from './common.ts'
import { readExamList, readOverview, readSchedule, readYear, type YearRow } from './reads.ts'

/**
 * The exam dates of a year. The pattern itself (which exams, which
 * components, what each is out of) is fixed in @erp/contracts; the office sets
 * only when each exam happens and when its re-check window closes. Saving an
 * exam brings its papers up to date with the sections of the year and the
 * subjects of their class.
 */

/** Every date of an exam must fall inside its academic year. */
function assertDatesInYear(year: YearRow, dates: { startsOn: string; recheckDeadline: string }): void {
  if (dates.startsOn < year.start_date || dates.recheckDeadline > year.end_date) {
    throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_dates_outside_year')
  }
}

/**
 * The papers of an exam, brought up to date: one per section of the exam's
 * year and subject its class has that year. A paper whose subject has since
 * left the class is removed, unless a mark was already written on it, which
 * keeps it as part of the record. The dev seed calls this too.
 *
 * A subject whose type is co_scholastic (physical education, art) gets no
 * paper: on the CBSE card it is graded A, B or C through the four fixed
 * co-scholastic areas by the class teacher, never out of 80.
 */
export async function syncPapers(
  conn: Pick<ExamConnection, 'client'>,
  schoolId: string,
  exam: { readonly id: string; readonly academic_year_id: string },
): Promise<{ added: number; removed: number }> {
  const added = await conn.client.query(
    `INSERT INTO exam_papers (school_id, exam_id, academic_year_id, section_id, subject_id)
     SELECT s.school_id, $2, s.academic_year_id, s.id, gs.subject_id
       FROM sections s
       JOIN grade_subjects gs ON gs.school_id = s.school_id AND gs.grade_id = s.grade_id
        AND gs.academic_year_id = s.academic_year_id
       JOIN subjects sub ON sub.school_id = gs.school_id AND sub.id = gs.subject_id
      WHERE s.school_id = $1 AND s.academic_year_id = $3 AND sub.type <> 'co_scholastic'
     ON CONFLICT (school_id, exam_id, section_id, subject_id) DO NOTHING`,
    [schoolId, exam.id, exam.academic_year_id],
  )
  const removed = await conn.client.query(
    `DELETE FROM exam_papers p
      USING sections s
      WHERE p.school_id = $1 AND p.exam_id = $2
        AND s.school_id = p.school_id AND s.id = p.section_id
        AND NOT EXISTS (SELECT 1 FROM grade_subjects gs
                         JOIN subjects sub ON sub.school_id = gs.school_id AND sub.id = gs.subject_id
                         WHERE gs.school_id = p.school_id AND gs.grade_id = s.grade_id
                           AND gs.academic_year_id = p.academic_year_id AND gs.subject_id = p.subject_id
                           AND sub.type <> 'co_scholastic')
        AND NOT EXISTS (SELECT 1 FROM exam_marks m WHERE m.school_id = p.school_id AND m.paper_id = p.id)`,
    [schoolId, exam.id],
  )
  return { added: added.rowCount ?? 0, removed: removed.rowCount ?? 0 }
}

export function registerExamSetupRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/exams',
    permission: 'exams.read',
    query: ExamListRequest,
    response: ExamListResponse,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) =>
        readExamList(conn, context, query.academicYearId),
      ),
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/exams',
    permission: 'exams.manage',
    body: ExamCreateRequest,
    response: ExamSchedule,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await authorizeSchoolAction(conn, context, 'exams.manage')
        const year = await readYear(conn, context.schoolId, body.academicYearId)
        assertDatesInYear(year, body)
        const existing = await conn.client.query(
          'SELECT 1 FROM exams WHERE school_id = $1 AND academic_year_id = $2 AND kind = $3',
          [context.schoolId, year.id, body.kind],
        )
        // One exam of each kind a year: the pattern has four, no more.
        if (existing.rows.length > 0) throw new ApiFailure('INVALID_REQUEST')

        const inserted = await conn.client.query<{ id: string }>(
          `INSERT INTO exams (school_id, academic_year_id, kind, starts_on, ends_on, recheck_deadline)
           VALUES ($1, $2, $3, $4::date, $5::date, $6::date) RETURNING id`,
          [context.schoolId, year.id, body.kind, body.startsOn, body.endsOn, body.recheckDeadline],
        )
        const examId = inserted.rows[0]?.id
        if (!examId) throw new ApiFailure('SERVICE_UNAVAILABLE')
        const papers = await syncPapers(conn, context.schoolId, { id: examId, academic_year_id: year.id })

        await writeAudit(conn, context, {
          action: 'exams.manage',
          targetType: 'exam',
          targetId: examId,
          summary: 'Set the dates of an exam.',
          safeChanges: { examId, academicYearId: year.id, kind: body.kind, papers: papers.added },
        })
        return readSchedule(conn, context, examId)
      }),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/exams/:examId',
    permission: 'exams.read',
    response: ExamOverview,
    handler: async ({ context, param }) => {
      const examId = assertUuidParam(param('examId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideExam(conn, context, 'exams.read', examId)
        return readOverview(conn, context, examId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: '/api/schools/:schoolId/exams/:examId',
    permission: 'exams.manage',
    body: ExamUpdateRequest,
    response: ExamSchedule,
    handler: async ({ context, body, param }) => {
      const examId = assertUuidParam(param('examId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideExam(conn, context, 'exams.manage', examId)
        const exam = await readExam(conn, context.schoolId, examId)
        const published = await conn.client.query(
          'SELECT 1 FROM exam_publications WHERE school_id = $1 AND exam_id = $2 LIMIT 1',
          [context.schoolId, examId],
        )
        // Once results are out, the dates they were marked against stay.
        if (published.rows.length > 0) throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_already_published')
        const year = await readYear(conn, context.schoolId, exam.academic_year_id)
        assertDatesInYear(year, body)

        const version = await bumpVersion(conn, 'exams', {
          schoolId: context.schoolId,
          id: examId,
          expectedVersion: body.expectedVersion,
          set: { starts_on: body.startsOn, ends_on: body.endsOn, recheck_deadline: body.recheckDeadline },
        })
        const papers = await syncPapers(conn, context.schoolId, exam)

        await writeAudit(conn, context, {
          action: 'exams.manage',
          targetType: 'exam',
          targetId: examId,
          summary: 'Changed the dates of an exam.',
          safeChanges: {
            examId,
            academicYearId: exam.academic_year_id,
            kind: exam.kind,
            version,
            papersAdded: papers.added,
            papersRemoved: papers.removed,
          },
        })
        return readSchedule(conn, context, examId)
      })
    },
  })
}
