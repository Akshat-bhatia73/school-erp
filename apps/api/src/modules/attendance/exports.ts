import type { FastifyInstance } from 'fastify'
import {
  AttendanceExportJob,
  AttendancePupilMonthExportRequest,
  AttendanceRegisterExportRequest,
  StaffAttendanceRegisterExportRequest,
} from '@erp/contracts'
import { withTenantTransaction } from '@erp/db'
import { insertExportJob } from '../../exports/jobs.ts'
import { createAndMaybeProduce } from '../../exports/run.ts'
import {
  ApiFailure,
  assertUuidParam,
  decideResource,
  protectedRoute,
  type ModuleDependencies,
} from '../shared/index.ts'
import { decideAttendance, readSectionMonth } from './reads.ts'
import { readStaffMonth } from './staff.ts'

/**
 * The three attendance files: a section's month, one pupil's month and the
 * staff register. A route only decides that this caller may ask for the file
 * and counts roughly how many rows it would hold; the producer reads every
 * row again under the same person's own plans when it makes the bytes.
 */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** A path that is not a month is a path to nothing, exactly like a bad id. */
function assertMonthParam(value: string): string {
  if (!MONTH.test(value)) throw new ApiFailure('RESOURCE_NOT_FOUND')
  return value
}

export function registerAttendanceExportRoutes(app: FastifyInstance, deps: ModuleDependencies): void {
  // A section's month as a spreadsheet or a document.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/attendance/sections/:sectionId/months/:month/export',
    permission: 'attendance.export',
    body: AttendanceRegisterExportRequest,
    response: AttendanceExportJob,
    successStatus: 202,
    handler: async ({ context, body, param }) => {
      const sectionId = assertUuidParam(param('sectionId'))
      const month = assertMonthParam(param('month'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        // A section this caller may not export answers exactly like one that
        // is not there, so holding the permission never reveals what exists.
        await decideAttendance(conn, context, 'attendance.export', sectionId)

        // The same reader the producer will use counts the pupils, and it is
        // also what refuses a month outside the section's own year.
        const counted = await readSectionMonth(conn, context, sectionId, month)
        const rows = counted.rows.length

        const jobId = await insertExportJob(conn, context, {
          kind: 'attendance_register',
          permission: 'attendance.export',
          criteria: { sectionId, month, format: body.format },
          summary: "Requested a section's monthly attendance register as a file.",
          safeChanges: { sectionId, month, format: body.format, rows },
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: rows })
      })
    },
  })

  // One pupil's month as a document. Printing a month is reading it in
  // another format, so it carries the read permission rather than the export
  // one: a parent prints their own child's month and nobody else's.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/attendance/students/:studentId/months/:month/export',
    permission: 'attendance.read',
    body: AttendancePupilMonthExportRequest,
    response: AttendanceExportJob,
    successStatus: 202,
    handler: async ({ context, param }) => {
      const studentId = assertUuidParam(param('studentId'))
      const month = assertMonthParam(param('month'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const decision = await decideResource(conn, context, 'attendance.read', 'attendance', studentId)
        if (!decision.allowed) {
          throw new ApiFailure(decision.code === 'MFA_REQUIRED' ? 'MFA_REQUIRED' : 'RESOURCE_NOT_FOUND')
        }

        const jobId = await insertExportJob(conn, context, {
          kind: 'attendance_pupil_month',
          permission: 'attendance.read',
          criteria: { studentId, month },
          summary: "Requested a pupil's monthly attendance as a document.",
          safeChanges: { studentId, month },
        })
        // One record is always small, so the file is made in this request.
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: 1 })
      })
    },
  })

  // The staff register for a month.
  protectedRoute(app, deps, {
    method: 'POST',
    path: '/api/schools/:schoolId/staff-attendance/months/:month/export',
    permission: 'staff_attendance.export',
    body: StaffAttendanceRegisterExportRequest,
    response: AttendanceExportJob,
    successStatus: 202,
    handler: async ({ context, body, param }) => {
      const month = assertMonthParam(param('month'))
      return withTenantTransaction(deps.pools.runtime, context, async (conn) => {
        const counted = await readStaffMonth(conn, context, month)
        const rows = counted.rows.length

        const jobId = await insertExportJob(conn, context, {
          kind: 'staff_attendance_register',
          permission: 'staff_attendance.export',
          criteria: { month, format: body.format },
          summary: 'Requested the staff attendance register as a file.',
          safeChanges: { month, format: body.format, rows },
        })
        return createAndMaybeProduce(deps, conn, context, { id: jobId, estimatedRows: rows })
      })
    },
  })
}
