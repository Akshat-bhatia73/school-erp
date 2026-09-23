import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/index.ts'
import { registerExamSetupRoutes } from './setup.ts'
import { registerExamMarksRoutes } from './marks.ts'
import { registerExamPublishRoutes } from './publish.ts'
import { registerExamResultsRoutes } from './results.ts'
import { registerExamExportRoutes } from './exports.ts'

/**
 * The exams module (Task 21). The exam dates come first, then the marks
 * sheets and their corrections, then publishing, then a pupil's results, then
 * the files.
 */
export function registerExamRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerExamSetupRoutes(app, deps)
  registerExamMarksRoutes(app, deps)
  registerExamPublishRoutes(app, deps)
  registerExamResultsRoutes(app, deps)
  registerExamExportRoutes(app, deps)
}
