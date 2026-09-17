import type { FastifyInstance } from 'fastify'
import type { ModuleDependencies } from '../shared/route.ts'
import { registerSchoolProfileRoutes } from './school.ts'
import { registerAcademicYearRoutes } from './years.ts'
import { registerGradeRoutes } from './grades.ts'
import { registerSectionRoutes } from './sections.ts'
import { registerSubjectRoutes } from './subjects.ts'
import { registerHolidayRoutes } from './holidays.ts'

/**
 * The records every other module reads: the school profile, its academic
 * years, classes, sections, subjects and calendar. Each route decides its own
 * permission and filters every read through an authorized plan.
 */
export function registerSetupRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  registerSchoolProfileRoutes(app, deps)
  registerAcademicYearRoutes(app, deps)
  registerGradeRoutes(app, deps)
  registerSectionRoutes(app, deps)
  registerSubjectRoutes(app, deps)
  registerHolidayRoutes(app, deps)
}
