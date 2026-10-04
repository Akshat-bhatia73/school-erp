import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/index.ts'
import { registerHomeworkItemRoutes } from './items.ts'
import { registerHomeworkFileRoutes } from './files.ts'
import { registerHomeworkCheckRoutes } from './checks.ts'
import { registerHomeworkReportRoutes } from './report.ts'

export { readHomeworkReport } from './report.ts'
export { listHomework, readHomeworkDetail, readCheckSheet, readHomeworkDue, readHomeworkToCheck } from './reads.ts'

/**
 * The homework module (Task 25). Items first (the list, one item, set, edit
 * and remove), then their files, then the check-off sheet, then the report.
 */
export function registerHomeworkRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerHomeworkItemRoutes(app, deps)
  registerHomeworkFileRoutes(app, deps)
  registerHomeworkCheckRoutes(app, deps)
  registerHomeworkReportRoutes(app, deps)
}
