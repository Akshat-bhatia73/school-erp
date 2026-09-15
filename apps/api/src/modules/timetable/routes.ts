import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/route.ts'
import { registerBellScheduleRoutes } from './bell.ts'
import { registerGridRoutes } from './grid.ts'
import { registerSubstitutionRoutes } from './substitutions.ts'

/**
 * The timetable module: the bell schedule a day is built from, the weekly grid
 * itself, and the day-by-day cover arrangements when a teacher is away.
 */
export function registerTimetableRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerBellScheduleRoutes(app, deps)
  registerGridRoutes(app, deps)
  registerSubstitutionRoutes(app, deps)
}
