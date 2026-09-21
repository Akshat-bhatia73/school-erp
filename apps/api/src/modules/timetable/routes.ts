import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/route.ts'
import { registerBellScheduleRoutes } from './bell.ts'
import { registerGridRoutes } from './grid.ts'
import { registerTimetableExportRoute } from './export.ts'
import { registerSubstitutionRoutes } from './substitutions.ts'

/**
 * The timetable module: the bell schedule a day is built from, the weekly grid
 * itself, the day-by-day cover arrangements when a teacher is away, and the
 * same week as a file to take away.
 */
export function registerTimetableRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerBellScheduleRoutes(app, deps)
  registerGridRoutes(app, deps)
  registerSubstitutionRoutes(app, deps)
  registerTimetableExportRoute(app, deps)
}
