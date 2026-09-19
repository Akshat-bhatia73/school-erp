import type { FastifyInstance } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import {
  AuthorizedCount,
  DepartmentSuggestionList,
  EmptySuccess,
  StaffCreateRequest,
  StaffDetailByAudience,
  StaffDirectoryPage,
  StaffEmploymentCreated,
  StaffExportJob,
  StaffExportRequest,
  StaffListRequest,
  StaffSearchRequest,
  StaffSearchResults,
  StaffUpdateEmploymentRequest,
  SectionTeachingAssignmentList,
  TeachingAssignmentList,
  TeachingAssignmentRequest,
  UpdateStaffPayRequest,
  UpdateStaffPrivateRequest,
} from '@erp/contracts'
import { staff } from '@erp/db/schema'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure } from '../../http/errors.ts'
import { protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import { toDirectory } from './projection.ts'
import {
  assignmentsForSection,
  assignmentsForStaff,
  countStaff,
  listDepartments,
  listStaff,
  loadStaffRow,
  recordId,
  requireRecord,
  searchStaff,
  staffDetail,
  staffScope,
} from './reads.ts'
import {
  createExportJob,
  createStaff,
  deleteAssignment,
  reloadStaff,
  updateEmployment,
  updatePay,
  updatePrivate,
  upsertAssignment,
} from './writes.ts'

const BASE = '/api/schools/:schoolId/staff'

/**
 * The staff module. Every route opens exactly one tenant transaction and every
 * record and projection inside it is decided by the shared evaluator, so the
 * directory, the detail blocks and the assignment lists can never disagree
 * about what this caller may see.
 */
export function registerStaffRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: BASE,
    permission: 'staff.read_directory',
    query: StaffListRequest,
    response: StaffDirectoryPage,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => listStaff(conn, context, query)),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: `${BASE}/count`,
    permission: 'staff.read_directory',
    response: AuthorizedCount,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => ({
        count: await countStaff(conn, context),
      })),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: `${BASE}/search`,
    permission: 'staff.read_directory',
    query: StaffSearchRequest,
    response: StaffSearchResults,
    handler: async ({ context, query }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => searchStaff(conn, context, query.q)),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: `${BASE}/departments`,
    permission: 'staff.read_directory',
    response: DepartmentSuggestionList,
    handler: async ({ context }) =>
      withTenantTransaction(deps.pools.runtime, context, (conn) => listDepartments(conn, context)),
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: `${BASE}/:staffId`,
    // OPERATION_COVERAGE names staff.read_employment as the gate here, but the
    // same document lists the four projection keys as separate checks, so the
    // gate is the weakest of them and each block is decided on its own below.
    // A directory-only reader gets a name and a designation and nothing else.
    permission: 'staff.read_directory',
    response: StaffDetailByAudience,
    auditRead: {
      targetType: 'staff',
      param: 'staffId',
      summary: 'Opened the staff record.',
      detail: (result) => ({
        blocks: [
          ...('employment' in result ? ['employment'] : []),
          ...('private' in result ? ['private'] : []),
          ...('pay' in result ? ['pay'] : []),
        ],
      }),
    },
    handler: async ({ context, param }) => {
      const staffId = recordId(param('staffId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const row = await loadStaffRow(conn, context, staffId)
        return staffDetail(conn, context, row)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: `${BASE}/:staffId/assignments`,
    permission: 'staff.read_employment',
    response: TeachingAssignmentList,
    handler: async ({ context, param }) => {
      const staffId = recordId(param('staffId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // Employment on that person is the key to their assignments, so a
        // teacher sees their own and an office reader sees anyone's.
        await requireRecord(conn, context, 'staff.read_employment', 'staff', staffId)
        return assignmentsForStaff(conn, context.schoolId, staffId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/sections/:sectionId/assignments',
    permission: 'sections.read',
    response: SectionTeachingAssignmentList,
    handler: async ({ context, param }) => {
      const sectionId = recordId(param('sectionId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await requireRecord(conn, context, 'sections.read', 'section', sectionId)
        return assignmentsForSection(conn, context.schoolId, sectionId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: `${BASE}/:staffId/assignments`,
    permission: 'staff.manage_assignments',
    body: TeachingAssignmentRequest,
    response: TeachingAssignmentList,
    handler: async ({ context, body, param }) => {
      const staffId = recordId(param('staffId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // staff.manage_assignments is a school wide key over teaching
        // assignments, so the aggregate gate is the whole decision; the write
        // then proves every reference belongs to this school.
        await upsertAssignment(conn, context, staffId, body)
        return assignmentsForStaff(conn, context.schoolId, staffId)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'DELETE',
    path: `${BASE}/:staffId/assignments/:assignmentId`,
    permission: 'staff.manage_assignments',
    response: EmptySuccess,
    successStatus: 204,
    handler: async ({ context, param }) => {
      const staffId = recordId(param('staffId'))
      const assignmentId = recordId(param('assignmentId'))
      await withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await deleteAssignment(conn, context, staffId, assignmentId)
      })
      return null
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: BASE,
    permission: 'staff.create',
    body: StaffCreateRequest,
    response: StaffEmploymentCreated,
    successStatus: 201,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const row = await createStaff(conn, context, body)
        // The assigned code travels with the row it was assigned to.
        return { ...toDirectory(row), employeeCode: row.employeeCode }
      }),
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: `${BASE}/:staffId/employment`,
    permission: 'staff.update_employment',
    body: StaffUpdateEmploymentRequest,
    response: StaffDetailByAudience,
    handler: async ({ context, body, param }) => {
      const staffId = recordId(param('staffId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await requireRecord(conn, context, 'staff.update_employment', 'staff', staffId)
        await updateEmployment(conn, context, staffId, body)
        return staffDetail(conn, context, await reloadStaff(conn, context.schoolId, staffId))
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: `${BASE}/:staffId/private`,
    permission: 'staff.update_private',
    body: UpdateStaffPrivateRequest,
    response: StaffDetailByAudience,
    handler: async ({ context, body, param }) => {
      const staffId = recordId(param('staffId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // The self scope lives here: a teacher may edit their own record only.
        await requireRecord(conn, context, 'staff.update_private', 'staff', staffId)
        await updatePrivate(conn, context, staffId, body)
        return staffDetail(conn, context, await reloadStaff(conn, context.schoolId, staffId))
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'PUT',
    path: `${BASE}/:staffId/pay`,
    permission: 'staff.update_pay',
    body: UpdateStaffPayRequest,
    response: StaffDetailByAudience,
    handler: async ({ context, body, param }) => {
      const staffId = recordId(param('staffId'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await requireRecord(conn, context, 'staff.update_pay', 'staff', staffId)
        await updatePay(conn, context, staffId, body)
        return staffDetail(conn, context, await reloadStaff(conn, context.schoolId, staffId))
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'POST',
    path: `${BASE}/export`,
    permission: 'staff.export',
    body: StaffExportRequest,
    response: StaffExportJob,
    successStatus: 202,
    handler: async ({ context, body }) =>
      withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // Every id must sit inside the export predicate. One that does not
        // rejects the whole request, and nothing is written.
        const staffIds = body.staffIds.map((id) => recordId(id))
        const where = and(
          await staffScope(conn, context, 'staff.export'),
          eq(staff.schoolId, context.schoolId),
          inArray(staff.id, staffIds),
        )
        const rows = await conn.db.select({ id: staff.id }).from(staff).where(where)
        const allowed = new Set(rows.map((row) => row.id))
        if (staffIds.some((id) => !allowed.has(id))) throw new ApiFailure('RESOURCE_NOT_FOUND')
        return createExportJob(conn, context, staffIds)
      }),
  })
}

