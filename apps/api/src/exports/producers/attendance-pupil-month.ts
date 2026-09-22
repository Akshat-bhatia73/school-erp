import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { FilesUuid, type AttendanceMark, type AttendanceMonthDay } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { readStudentMonth } from '../../modules/attendance/reads.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { openDocument } from '../pdf/document.ts'
import { PDF_CONTENT_TYPE, formatPdfDate } from '../pdf/kit.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { monthInWords } from './attendance-register.ts'

/** The job row says which pupil and which month; the rest is read again now. */
const Criteria = z.object({
  studentId: FilesUuid,
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
})

/** A mark in the words a parent reads, not the value the table stores. */
const MARK_WORDS: Readonly<Record<AttendanceMark, string>> = {
  present: 'Present',
  absent: 'Absent',
  late: 'Late',
  leave: 'Leave',
  half_day: 'Half day',
}

/**
 * What one line of the day list says. A marked day says the mark; a day off
 * says which kind of day off it was; a school day nobody marked says so,
 * because that is what a low percentage is usually made of.
 */
function dayWords(day: AttendanceMonthDay): string {
  if (day.mark !== undefined) return MARK_WORDS[day.mark]
  if (day.kind === 'sunday') return 'Sunday'
  if (day.kind === 'holiday') return day.holidayName ?? 'Holiday'
  if (day.kind === 'outside_year') return 'Outside the year'
  if (!day.enrolled) return 'Not on the roster'
  if (day.future) return ''
  return 'Not marked'
}

/** One pupil's month as a document, for a file or a parent's own records. */
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
  const month = await readStudentMonth(conn, context, request.studentId, request.month)

  const className = [month.grade?.name, month.section?.name]
    .filter((part) => part !== undefined && part !== '')
    .join(' ')
  const monthName = monthInWords(request.month)

  const document = await openDocument(conn, context, { title: 'Attendance' })
  document.personHeader({
    name: month.student.name,
    subtitle: `Admission number ${month.student.admissionNumber}`,
    tags: [...(className === '' ? [] : [className]), monthName],
  })
  document.panel('This month', {
    kind: 'facts',
    facts: [
      { label: 'Percentage', value: month.summary.percentage === null ? '—' : `${month.summary.percentage}%` },
      { label: 'Present', value: String(month.summary.present) },
      { label: 'Absent', value: String(month.summary.absent) },
      { label: 'Late', value: String(month.summary.late) },
      { label: 'Leave', value: String(month.summary.leave) },
      { label: 'Half day', value: String(month.summary.halfDay) },
      { label: 'School days', value: String(month.summary.schoolDays) },
      { label: 'Not marked', value: String(month.summary.unmarked) },
    ],
  })
  document.panel('Days', {
    kind: 'table',
    columns: [
      { header: 'Date', width: 0.34, emphasis: 'primary' },
      { header: 'Day', width: 0.44 },
      { header: 'Corrected', width: 0.22 },
    ],
    rows: month.days.map((day) => [
      formatPdfDate(day.date),
      dayWords(day),
      day.corrected === true ? 'Corrected' : '',
    ]),
  })

  return {
    bytes: await document.finish(),
    contentType: PDF_CONTENT_TYPE,
    fileName: exportFileName(
      ['attendance', month.student.admissionNumber, request.month, fileNameDate(context.now)],
      'pdf',
    ),
    rowCount: 1,
  }
}

registerProducer({ kind: 'attendance_pupil_month', produce })
