import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { StaffAttendanceRegisterExportRequest } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { readStaffMonth } from '../../modules/attendance/staff.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE } from '../pdf/kit.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, XLSX_CONTENT_TYPE, type ExportColumn } from '../xlsx.ts'
import { dayNumber, gridCell, monthInWords } from './attendance-register.ts'

/** The job row says which month; the register itself is read again now. */
const Criteria = z.object({
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  format: StaffAttendanceRegisterExportRequest.shape.format,
})

/**
 * The staff register for a month, drawn the same way as the pupil one: a grid
 * in a spreadsheet, the totals in a document.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const request = parsed.data
  // The reader applies this caller's own staff attendance plan, so a person
  // they may not read is not there when the file is made.
  const register = await readStaffMonth(conn, context, request.month)

  const fileName = exportFileName(
    ['staff', 'attendance', request.month, fileNameDate(context.now)],
    request.format,
  )

  if (request.format === 'xlsx') {
    const columns: ExportColumn[] = [
      { header: 'Code', key: 'code', width: 12 },
      { header: 'Name', key: 'name', width: 30 },
      { header: 'Designation', key: 'designation', width: 22 },
      ...register.days.map((day) => ({ header: dayNumber(day.date), key: `d${day.date}`, width: 5 })),
      { header: 'Present', key: 'present', width: 10 },
      { header: 'Absent', key: 'absent', width: 10 },
      { header: 'Late', key: 'late', width: 8 },
      { header: 'Leave', key: 'leave', width: 8 },
      { header: 'Half day', key: 'halfDay', width: 10 },
      { header: 'School days', key: 'schoolDays', width: 13 },
      { header: 'Percentage', key: 'percentage', width: 12 },
    ]
    const rows = register.rows.map((row) => {
      const byDay = new Map(row.marks.map((mark) => [mark.date, mark]))
      const days: Record<string, string> = {}
      for (const day of register.days) days[`d${day.date}`] = gridCell(day, byDay.get(day.date))
      return {
        code: row.staff.employeeCode,
        name: row.staff.name,
        designation: row.staff.designation ?? '',
        ...days,
        present: row.summary.present,
        absent: row.summary.absent,
        late: row.summary.late,
        leave: row.summary.leave,
        halfDay: row.summary.halfDay,
        schoolDays: row.summary.schoolDays,
        percentage: row.summary.percentage ?? '',
      }
    })
    return {
      bytes: await buildWorkbook({
        sheetName: `Staff attendance ${request.month}`,
        columns,
        rows,
      }),
      contentType: XLSX_CONTENT_TYPE,
      fileName,
      rowCount: register.rows.length,
    }
  }

  const document = await openDocument(conn, context, { title: 'Staff attendance', landscape: true })
  document.personHeader({
    name: 'Staff attendance',
    subtitle: `Attendance ${monthInWords(request.month)}`,
    tags: [register.academicYear.name],
  })
  document.panel('Staff', {
    kind: 'table',
    columns: [
      { header: 'Code', width: 0.1 },
      { header: 'Name', width: 0.22, emphasis: 'primary' },
      { header: 'Designation', width: 0.14 },
      { header: 'Present', width: 0.09 },
      { header: 'Absent', width: 0.09 },
      { header: 'Late', width: 0.07 },
      { header: 'Leave', width: 0.07 },
      { header: 'Half day', width: 0.08 },
      { header: 'Percentage', width: 0.14, emphasis: 'primary' },
    ],
    rows: register.rows.map((row) => [
      row.staff.employeeCode,
      row.staff.name,
      row.staff.designation ?? '',
      String(row.summary.present),
      String(row.summary.absent),
      String(row.summary.late),
      String(row.summary.leave),
      String(row.summary.halfDay),
      row.summary.percentage === null ? '' : `${row.summary.percentage}%`,
    ]),
  })
  // A column per day would not fit a page, so the document carries the month's
  // totals and says where the day by day grid can be had instead.
  document.note('This document holds the month’s totals. For the day by day grid, ask for the register as a spreadsheet.')

  return {
    bytes: await document.finish(),
    contentType: PDF_CONTENT_TYPE,
    fileName,
    rowCount: register.rows.length,
  }
}

registerProducer({ kind: 'staff_attendance_register', produce })
