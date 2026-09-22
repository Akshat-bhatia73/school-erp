import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/index.ts'
import { registerAttendanceRosterRoutes } from './roster.ts'
import { registerAttendanceMonthRoutes } from './months.ts'
import { registerStaffAttendanceRoutes } from './staff.ts'
import { registerAttendanceExportRoutes } from './exports.ts'

/**
 * The attendance module (Task 20). The day list and the roster come first,
 * then a pupil's month and a section's month worked out from the same
 * figures, then the staff register, then the files.
 */
export function registerAttendanceRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerAttendanceRosterRoutes(app, deps)
  registerAttendanceMonthRoutes(app, deps)
  registerStaffAttendanceRoutes(app, deps)
  registerAttendanceExportRoutes(app, deps)
}
