import type { FastifyInstance } from 'fastify'
import { AttendanceSectionMonthResponse, AttendanceStudentMonthResponse } from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { ApiFailure, assertUuidParam, protectedRoute, type ModuleDependencies } from '../shared/index.ts'
import { decideAttendance, readSectionMonth, readStudentMonth } from './reads.ts'

/**
 * A month of the register, read two ways: one pupil down the page, or a whole
 * section as a grid. Both come from the same figures as the day itself, so a
 * percentage on a report card and a percentage on a screen are the same
 * number.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** A path that is not a month is a path to nothing, exactly like a bad id. */
function assertMonthParam(value: string): string {
  if (!MONTH.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return value
}

export function registerAttendanceMonthRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/attendance/students/:studentId/months/:month',
    permission: 'attendance.read',
    response: AttendanceStudentMonthResponse,
    auditRead: {
      targetType: 'student',
      param: 'studentId',
      summary: "Read a pupil's monthly attendance.",
      detail: (result) => ({ month: result.month }),
    },
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      const month = assertMonthParam(param('month'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideAttendance(conn, context, 'attendance.read', studentId)
        return readStudentMonth(conn, context, studentId, month)
      })
    },
  })

  protectedRoute(app, deps, {
    method: 'GET',
    path: '/api/schools/:schoolId/attendance/sections/:sectionId/months/:month',
    permission: 'attendance.read',
    response: AttendanceSectionMonthResponse,
    handler: async ({ context, param }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const month = assertMonthParam(param('month'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        await decideAttendance(conn, context, 'attendance.read', sectionId)
        return readSectionMonth(conn, context, sectionId, month)
      })
    },
  })
}
