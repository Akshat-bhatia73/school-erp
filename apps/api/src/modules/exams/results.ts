import type { FastifyInstance } from 'fastify'
import { ExamResultsRequest, ExamResultsResponse } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { assertUuidParam, protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import { decideExam } from './common.ts'
import { readStudentResults } from './reads.ts'

/**
 * One pupil's results for a year. Staff see live marks; a parent sees each
 * exam as it stood at its newest publication, and grades alone when the
 * school shows grades. Reading it is recorded against the pupil.
 */
export function registerExamResultsRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/exams/students/:studentId/results',
    permission: 'exams.read',
    query: ExamResultsRequest,
    response: ExamResultsResponse,
    auditRead: { targetType: 'student', param: 'studentId', summary: "Read a pupil's exam results." },
    handler: async ({ context, query, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideExam(conn, context, 'exams.read', studentId)
        return readStudentResults(conn, context, studentId, query.academicYearId)
      })
    },
  })
}
