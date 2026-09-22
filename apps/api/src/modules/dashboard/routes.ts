import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { CalendarDate, DashboardAudienceKey, DashboardResponse } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import { audiencesFor, resolveAudience } from './audience.ts'
import { todayInSchool } from './calendar.ts'
import { officeDashboard } from './office.ts'
import { teacherDashboard } from './teacher.ts'
import { parentDashboard } from './parent.ts'
import { accountantDashboard } from './accountant.ts'

/**
 * The date only moves the calendar and the audience only picks which of the
 * caller's own homes is drawn; neither widens what is read.
 */
const DashboardQuery = z.strictObject({
  date: CalendarDate.optional(),
  audience: DashboardAudienceKey.optional(),
})

/**
 * One dashboard route. The audience comes from the caller's own roles: the
 * first one they earn by default, or the one they asked for when their roles
 * earn it too. Every figure on it comes from a predicate-scoped query inside
 * one tenant transaction, so a teacher sees their classes and a parent sees
 * their children without either of them reaching a school-wide count. A block
 * whose permission the caller does not hold is left out rather than sent as a
 * zero.
 */
export function registerDashboardRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/dashboard',
    permission: 'dashboard.read',
    query: DashboardQuery,
    response: DashboardResponse,
    handler: async ({ context, query }) => {
      if (audiencesFor(context.roleKeys).length === 0) throw new ApiFailure('ACCESS_DENIED')
      // An audience the roles do not earn is a bad request, refused before any read.
      const audience = resolveAudience(context.roleKeys, query.audience)
      if (audience === null) throw new ApiFailure('INVALID_REQUEST')
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const date = query.date ?? (await todayInSchool(conn, context.schoolId, context.now))
        switch (audience) {
          case 'office':
            return officeDashboard(conn, context, deps.pools.auth, date)
          case 'teacher':
            return teacherDashboard(conn, context, date)
          case 'parent':
            return parentDashboard(conn, context, date)
          case 'accountant':
            return accountantDashboard(conn, context, date)
        }
      })
    },
  })
}
