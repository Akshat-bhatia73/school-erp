import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { AttendanceRegisterExportRequest, FilesUuid, type AttendanceMark } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { readSectionMonth } from '../../modules/attendance/reads.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE } from '../pdf/kit.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, XLSX_CONTENT_TYPE, type ExportColumn } from '../xlsx.ts'

/** The job row says which section and which month; the rest is read again now. */
const Criteria = z.object({
  sectionId: FilesUuid,
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  format: AttendanceRegisterExportRequest.shape.format,
})

/** The one letter a grid cell holds, short enough to fit a day column. */
export const MARK_LETTER: Readonly<Record<AttendanceMark, string>> = {
  present: 'P',
  absent: 'A',
  late: 'L',
  leave: 'LV',
  half_day: 'H',
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/** "2026-09" as people say it: "September 2026". */
export function monthInWords(month: string): string {
  const year = month.slice(0, 4)
  const index = Number(month.slice(5, 7)) - 1
  const name = MONTH_NAMES[index]
  return name === undefined ? month : `${name} ${year}`
}

/** The day number a column is headed by, from its date. */
export function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)))
}

/**
 * What a grid cell says for one person on one day. A day nobody was on the
 * register for is blank, a school day nobody marked is a dash so a reader can
 * tell it apart from a day off, and a Sunday or a holiday says which it was.
 */
export function gridCell(
  day: { readonly kind: string },
  cell: { readonly enrolled?: boolean; readonly onRegister?: boolean; readonly mark?: AttendanceMark } | undefined,
): string {
  const on = cell?.enrolled ?? cell?.onRegister ?? false
  if (!on) return ''
  if (cell?.mark !== undefined) return MARK_LETTER[cell.mark]
  if (day.kind === 'sunday') return 'S'
  if (day.kind === 'holiday') return 'H'
  if (day.kind === 'school_day') return '-'
  return ''
}

/**
 * A section's month, as a spreadsheet grid or as a summary document. Every
 * figure comes from the same reader the screen uses, so a percentage in a
 * file and a percentage on a screen are the same number.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const request = parsed.data
  // The reader applies this caller's own attendance plan, so a pupil they may
  // not read is not there when the file is made, whoever asked for the job.
  const register = await readSectionMonth(conn, context, request.sectionId, request.month)

  const className = `${register.grade.name} ${register.section.name}`.trim()
  const fileName = exportFileName(
    ['attendance', register.grade.name, register.section.name, request.month, fileNameDate(context.now)],
    request.format,
  )

  if (request.format === 'xlsx') {
    const columns: ExportColumn[] = [
      { header: 'Roll', key: 'roll', width: 7 },
      { header: 'Admission number', key: 'admissionNumber', width: 20 },
      { header: 'Pupil', key: 'name', width: 30 },
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
        roll: row.student.rollNumber ?? '',
        admissionNumber: row.student.admissionNumber,
        name: row.student.name,
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
        sheetName: `Attendance ${className} ${request.month}`,
        columns,
        rows,
      }),
      contentType: XLSX_CONTENT_TYPE,
      fileName,
      rowCount: register.rows.length,
    }
  }

  const document = await openDocument(conn, context, { title: 'Attendance register', landscape: true })
  document.personHeader({
    name: className,
    subtitle: `Attendance ${monthInWords(request.month)}`,
    tags: [register.academicYear.name],
  })
  document.panel('Pupils', {
    kind: 'table',
    columns: [
      { header: 'Roll', width: 0.07 },
      { header: 'Pupil', width: 0.29, emphasis: 'primary' },
      { header: 'Present', width: 0.1 },
      { header: 'Absent', width: 0.1 },
      { header: 'Late', width: 0.08 },
      { header: 'Leave', width: 0.08 },
      { header: 'Half day', width: 0.09 },
      { header: 'School days', width: 0.09 },
      { header: 'Percentage', width: 0.1, emphasis: 'primary' },
    ],
    rows: register.rows.map((row) => [
      row.student.rollNumber === undefined ? '' : String(row.student.rollNumber),
      row.student.name,
      String(row.summary.present),
      String(row.summary.absent),
      String(row.summary.late),
      String(row.summary.leave),
      String(row.summary.halfDay),
      String(row.summary.schoolDays),
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

registerProducer({ kind: 'attendance_register', produce })
