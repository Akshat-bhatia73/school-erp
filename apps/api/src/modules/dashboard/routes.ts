import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AuthorizationError, loadRelationshipFactsFor, type AuthzConnection } from '@erp/authz'
import { DashboardResponse, EnrollmentSummary } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { protectedRoute, readPlan, type ModuleDependencies } from '../shared/index.ts'
import { audienceFor } from './audience.ts'
import {
  countActiveStaff,
  countActiveStudents,
  currentEnrollmentsFor,
  listAssignedSections,
  listOwnChildren,
  listOwnTimetable,
} from './queries.ts'

type Dashboard = z.infer<typeof DashboardResponse>

async function officeDashboard(conn: AuthzConnection, context: RequestContext): Promise<Dashboard> {
  const studentPlan = await readPlan(conn, context, 'students.read_basic', 'student')
  const staffPlan = await readPlan(conn, context, 'staff.read_directory', 'staff')
  return {
    audience: 'office',
    activeStudents: await countActiveStudents(conn, studentPlan),
    staffCount: await countActiveStaff(conn, staffPlan),
  }
}

async function teacherDashboard(conn: AuthzConnection, context: RequestContext): Promise<Dashboard> {
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  // A teacher with no staff record teaches nothing, so both lists are empty
  // rather than a school-wide fallback.
  if (facts.selfStaffId === null) return { audience: 'teacher', assignedSections: [], ownTimetable: [] }
  const sectionPlan = await readPlan(conn, context, 'sections.read', 'section')
  const timetablePlan = await readPlan(conn, context, 'timetable.read', 'timetable')
  return {
    audience: 'teacher',
    assignedSections: await listAssignedSections(conn, sectionPlan, facts.selfStaffId, context.now),
    ownTimetable: await listOwnTimetable(conn, timetablePlan, facts.selfStaffId),
  }
}

async function parentDashboard(conn: AuthzConnection, context: RequestContext): Promise<Dashboard> {
  const facts = await loadRelationshipFactsFor(conn, context.schoolId, context.membershipId, context.now)
  const studentPlan = await readPlan(conn, context, 'students.read_basic', 'student')
  const children = await listOwnChildren(conn, studentPlan, facts.ownChildStudentIds)
  let enrollments = new Map<string, z.infer<typeof EnrollmentSummary>>()
  try {
    const enrollmentPlan = await readPlan(conn, context, 'students.read_enrollments', 'enrollment')
    enrollments = await currentEnrollmentsFor(conn, enrollmentPlan, children.map((child) => child.id))
  } catch (error) {
    // A parent who may not read enrollments still gets the children list; the
    // class summary is simply left out instead of failing the whole screen.
    // Only a denial is swallowed: a mis-wired permission or resource type
    // raises RESOURCE_NOT_FOUND here and must fail loudly rather than quietly
    // dropping the class summary for every parent.
    if (!(error instanceof AuthorizationError) || error.code !== 'ACCESS_DENIED') throw error
  }
  return {
    audience: 'parent',
    children: children.map((child) => {
      const enrollment = enrollments.get(child.id)
      return enrollment ? { ...child, enrollment } : child
    }),
  }
}

/**
 * One dashboard route. The audience is fixed from the caller's own roles, and
 * every figure on it comes from a predicate-scoped query, so a teacher sees
 * their classes and a parent sees their children without either of them
 * reaching a school-wide count.
 */
export function registerDashboardRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/dashboard',
    permission: 'dashboard.read',
    response: DashboardResponse,
    handler: async ({ context }) => {
      const audience = audienceFor(context.roleKeys)
      if (audience === null) throw new ApiFailure('ACCESS_DENIED')
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        switch (audience) {
          case 'office':
            return officeDashboard(conn, context)
          case 'teacher':
            return teacherDashboard(conn, context)
          case 'parent':
            return parentDashboard(conn, context)
          case 'accountant':
            return { audience: 'accountant', message: 'Financial modules are not enabled yet' }
        }
      })
    },
  })
}
