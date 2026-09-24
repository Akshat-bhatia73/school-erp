import type { FastifyInstance } from 'fastify'
import { withTenantTransaction } from '@erp/db'
import {
  IssueStudentLoginsResult,
  StudentLoginView,
  SwitchOffStudentLoginRequest,
  SwitchOnStudentLoginRequest,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import {
  issueStudentLogin,
  issueStudentLogins,
  loadStudentLogin,
  missingStudentLogins,
  resetStudentPassword,
  switchOffStudentLogin,
  switchOnStudentLogin,
} from '../../memberships/student-logins.ts'
import {
  assertUuidParam,
  authorizeResource,
  authorizeSchoolAction,
  protectedRoute,
  type ModuleDependencies,
} from '../shared/index.ts'

const BASE = '/api/schools/:schoolId/students'

/**
 * A pupil's own login (Task 23), from the office's side: read it, issue it,
 * reset its password, switch it off and on, and issue every missing one at
 * once. Each route decides students.manage_login on the pupil, so a pupil of
 * another school or an unknown id is not found. The work itself is in
 * memberships/student-logins.ts; nothing here writes a membership.
 */
export function registerStudentLoginRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  /** The view after a change, read in its own transaction once the change committed. */
  const freshView = (context: RequestContext, studentId: string) =>
    withTenantTransaction(deps.pools.runtime, context, (conn) =>
      loadStudentLogin(conn, deps, context, studentId),
    )

  protectedRoute(app, deps, {
    method: 'GET',
    path: `${BASE}/:studentId/login`,
    permission: 'students.manage_login',
    response: StudentLoginView,
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeResource(conn, context, 'students.manage_login', 'student', studentId)
        return loadStudentLogin(conn, deps, context, studentId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/:studentId/login`,
    permission: 'students.manage_login',
    response: StudentLoginView,
    successStatus: 201,
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      await issueStudentLogin(deps, context, studentId, 'office')
      return freshView(context, studentId)
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/:studentId/login/reset-password`,
    permission: 'students.manage_login',
    response: StudentLoginView,
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      await resetStudentPassword(deps, context, studentId)
      return freshView(context, studentId)
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/:studentId/login/switch-off`,
    permission: 'students.manage_login',
    body: SwitchOffStudentLoginRequest,
    response: StudentLoginView,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      await switchOffStudentLogin(deps, context, studentId, body)
      return freshView(context, studentId)
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/:studentId/login/switch-on`,
    permission: 'students.manage_login',
    body: SwitchOnStudentLoginRequest,
    response: StudentLoginView,
    handler: async ({ context, body, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      await switchOnStudentLogin(deps, context, studentId, body)
      return freshView(context, studentId)
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/logins/issue`,
    permission: 'students.manage_login',
    response: IssueStudentLoginsResult,
    handler: async ({ context, request }) => {
      const missing = await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await authorizeSchoolAction(conn, context, 'students.manage_login')
        return missingStudentLogins(conn, context.schoolId)
      })
      const result = await issueStudentLogins(
        deps,
        context,
        missing.studentIds,
        'bulk',
        (fields, line) => request.log.warn({ requestId: request.id, ...fields }, line),
      )
      return { ...result, alreadyHadLogin: result.alreadyHadLogin + missing.alreadyHadLogin }
    },
  })
}
