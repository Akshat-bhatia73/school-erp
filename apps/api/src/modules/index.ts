import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from './shared/route.ts'
import { registerSetupRoutes } from './setup/routes.ts'
import { registerStudentRoutes } from './students/routes.ts'
import { registerConsentRoutes } from './students/consents.ts'
import { registerStudentLifecycleRoutes } from './students/lifecycle.ts'
import { registerStudentPhotoRoutes } from './students/photo.ts'
import { registerSubjectAccessRoutes } from './students/subject-access.ts'
import { registerStudentProfileExportRoute } from './students/export-profile.ts'
import { registerStaffLifecycleRoutes } from './staff/lifecycle.ts'
import { registerStaffPhotoRoutes } from './staff/photo.ts'
import { registerStaffProfileExportRoute } from './staff/export-profile.ts'
import { registerStudentBulkRoutes } from './students-bulk/routes.ts'
import { registerStaffRoutes } from './staff/routes.ts'
import { registerTimetableRoutes } from './timetable/routes.ts'
import { registerDashboardRoutes } from './dashboard/routes.ts'
import { registerSearchRoutes } from './search/routes.ts'
import { registerAuditRoutes } from './audit/routes.ts'
import { registerFileRoutes } from './files/routes.ts'

export type { ModuleDependencies }

/**
 * The Task 5 school APIs. Setup comes first because every other module reads
 * the records it owns; the rest follow the order of the module plan.
 */
export function registerModuleRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerSetupRoutes(app, deps)
  registerStudentRoutes(app, deps)
  registerConsentRoutes(app, deps)
  registerStudentLifecycleRoutes(app, deps)
  registerStudentPhotoRoutes(app, deps)
  registerSubjectAccessRoutes(app, deps)
  registerStudentProfileExportRoute(app, deps)
  registerStudentBulkRoutes(app, deps)
  registerStaffRoutes(app, deps)
  registerStaffLifecycleRoutes(app, deps)
  registerStaffPhotoRoutes(app, deps)
  registerStaffProfileExportRoute(app, deps)
  registerTimetableRoutes(app, deps)
  registerDashboardRoutes(app, deps)
  registerSearchRoutes(app, deps)
  registerAuditRoutes(app, deps)
  registerFileRoutes(app, deps)
}
