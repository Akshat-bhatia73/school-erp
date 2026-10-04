import type { AuthzConnection } from '@erp/authz'
import { HomeworkReportExportRequest } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { readHomeworkReport } from '../../modules/homework/report.ts'
import { decideSchoolAction } from '../../modules/shared/index.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbookSheets, formatExportDate, XLSX_CONTENT_TYPE } from '../xlsx.ts'

/** The whole request is the criteria: the range and the filters. */
const Criteria = HomeworkReportExportRequest

/** The word the report screen uses for an item with no subject. */
const GENERAL = 'General'

/**
 * The office's homework report as a spreadsheet: one sheet of items per
 * section and subject with the check-offs over their rosters, and one of the
 * pupils with three or more Not done in the range. Both come from the very
 * reader the report screen uses, under the requester's own plans, so a file
 * holds a row only when the requester's screen would. The export key is
 * decided again for the requester first: the job row is not evidence that
 * they still hold it.
 */
async function produce(conn: AuthzConnection, context: RequestContext, criteria: unknown): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const request = parsed.data
  if (!(await decideSchoolAction(conn, context, 'homework.export')).allowed) throw new ApiFailure('ACCESS_DENIED')
  const report = await readHomeworkReport(conn, context, request)

  const range = `${formatExportDate(request.from)} to ${formatExportDate(request.to)}`
  const bytes = await buildWorkbookSheets([
    {
      sheetName: 'Homework set',
      columns: [
        { header: 'Class', key: 'grade', width: 16 },
        { header: 'Section', key: 'section', width: 12 },
        { header: 'Subject', key: 'subject', width: 24 },
        { header: 'Items', key: 'items', width: 8 },
        { header: 'Done', key: 'done', width: 8 },
        { header: 'Partly done', key: 'partlyDone', width: 12 },
        { header: 'Not done', key: 'notDone', width: 10 },
        { header: 'Not checked', key: 'notChecked', width: 12 },
        { header: 'Due between', key: 'range', width: 28 },
      ],
      rows: report.sets.map((row) => ({
        grade: row.grade.name,
        section: row.section.name,
        subject: row.subject?.name ?? GENERAL,
        items: row.items,
        done: row.done,
        partlyDone: row.partlyDone,
        notDone: row.notDone,
        notChecked: row.notChecked,
        range,
      })),
    },
    {
      sheetName: `Not done ${report.threshold} or more`,
      columns: [
        { header: 'Class', key: 'grade', width: 16 },
        { header: 'Section', key: 'section', width: 12 },
        { header: 'Roll', key: 'roll', width: 7 },
        { header: 'Admission number', key: 'admissionNumber', width: 20 },
        { header: 'Pupil', key: 'name', width: 30 },
        { header: 'Not done', key: 'notDone', width: 10 },
        { header: 'Checked', key: 'checked', width: 10 },
        { header: 'Due between', key: 'range', width: 28 },
      ],
      rows: report.repeatedNotDone.map((row) => ({
        grade: row.grade.name,
        section: row.section.name,
        roll: row.student.rollNumber ?? '',
        admissionNumber: row.student.admissionNumber,
        name: row.student.name,
        notDone: row.notDone,
        checked: row.checked,
        range,
      })),
    },
  ])
  return {
    bytes,
    contentType: XLSX_CONTENT_TYPE,
    fileName: exportFileName(['homework-report', request.from, request.to, fileNameDate(context.now)], 'xlsx'),
    rowCount: report.sets.length + report.repeatedNotDone.length,
  }
}

registerProducer({ kind: 'homework_report', produce })
