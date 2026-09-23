import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/index.ts'
import { registerReportCardSettingsRoutes } from './settings.ts'
import { registerReportCardEntryRoutes } from './entries.ts'
import { registerReportCardPublishRoutes } from './publish.ts'
import { registerReportCardReadRoutes } from './reads.ts'
import { registerReportCardExportRoutes } from './exports.ts'

/**
 * The report cards module (Task 21). The school's settings come first, then
 * the class teacher's entries, then preparing and publishing a section's
 * cards, then reading them, then the files.
 */
export function registerReportCardRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerReportCardSettingsRoutes(app, deps)
  registerReportCardEntryRoutes(app, deps)
  registerReportCardPublishRoutes(app, deps)
  registerReportCardReadRoutes(app, deps)
  registerReportCardExportRoutes(app, deps)
}
