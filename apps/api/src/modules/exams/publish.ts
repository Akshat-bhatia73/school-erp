import type { FastifyInstance } from 'fastify'
import { ExamPublishRequest, ExamSectionStatus } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import {
  ApiFailure,
  assertUuidParam,
  lockSchool,
  protectedRoute,
  writeAudit,
  type ModuleDependencies,
} from '../shared/index.ts'
import { decideExam, examPlans, examState, readExam, schoolToday } from './common.ts'
import { sectionStatuses } from './reads.ts'

/**
 * Publishing one exam's results for one section. A publication is an event:
 * publishing again after a correction appends a row, and a parent sees each
 * mark as it stood at the newest one. Only a locked, complete section is
 * published, and only when something changed since it last was.
 */
export function registerExamPublishRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/exams/:examId/sections/:sectionId/publish',
    permission: 'exams.publish',
    body: ExamPublishRequest,
    response: ExamSectionStatus,
    successStatus: 201,
    handler: async ({ context, param }) => {
      const examId = assertUuidParam(param('examId'))
      const sectionId = assertUuidParam(param('sectionId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await lockSchool(conn, context.schoolId)
        await decideExam(conn, context, 'exams.publish', examId)
        const exam = await readExam(conn, context.schoolId, examId)
        const papers = await conn.client.query(
          'SELECT 1 FROM exam_papers WHERE school_id = $1 AND exam_id = $2 AND section_id = $3 LIMIT 1',
          [context.schoolId, examId, sectionId],
        )
        if (papers.rows.length === 0) throw new ApiFailure('RESOURCE_NOT_FOUND')

        const today = await schoolToday(conn, context.schoolId)
        if (examState(exam, today) !== 'locked') {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_publish_before_deadline')
        }
        const plans = await examPlans(conn, context, 'exams.publish')
        const [status] = await sectionStatuses(conn, context, { exam, plans, today, sectionId })
        if (!status) throw new ApiFailure('RESOURCE_NOT_FOUND')
        if (!status.complete) throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_section_incomplete')
        if (status.publication !== null && !status.publication.changedSince) {
          throw new ApiFailure('INVALID_REQUEST', undefined, 'exam_nothing_to_publish')
        }

        await conn.client.query(
          `INSERT INTO exam_publications (school_id, exam_id, academic_year_id, section_id, published_by_membership_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [context.schoolId, examId, exam.academic_year_id, sectionId, context.membershipId],
        )
        await writeAudit(conn, context, {
          action: 'exams.publish',
          targetType: 'section',
          targetId: sectionId,
          summary: 'Published exam results for a section.',
          safeChanges: {
            examId,
            sectionId,
            academicYearId: exam.academic_year_id,
            pupils: status.pupils,
            republish: status.publication !== null,
          },
        })

        const [after] = await sectionStatuses(conn, context, { exam, plans, today, sectionId })
        if (!after) throw new ApiFailure('RESOURCE_NOT_FOUND')
        return after
      })
    },
  })
}
