import { z } from 'zod'
import type { AuthzConnection } from '@erp/authz'
import { EXAM_PATTERN, FilesUuid, gradeFor, scoreParts, type MarkValue } from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { ApiFailure } from '../../http/errors.ts'
import { decideExam, readExamSettings } from '../../modules/exams/common.ts'
import { readSheet } from '../../modules/exams/reads.ts'
import { exportFileName, fileNameDate } from '../naming.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, XLSX_CONTENT_TYPE, type ExportColumn } from '../xlsx.ts'

/** The job row says which paper; everything else is read again now. */
const Criteria = z.object({ paperId: FilesUuid })

/** What a cell says: the mark, or the status in words. */
export function markCell(value: MarkValue | undefined): string | number {
  if (value === undefined) return ''
  if (typeof value === 'number') return value
  if (value === 'absent') return 'Absent'
  if (value === 'medical') return 'Medical'
  return 'Exempt'
}

/**
 * One paper's marks as a spreadsheet: the roster in roll order, a column per
 * component with its maximum, the total as a percentage and the grade from
 * the school's bands. The figures come from the same reader and the same
 * scoring rule as the marks sheet on screen.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const parsed = Criteria.safeParse(criteria)
  if (!parsed.success) throw new ApiFailure('INVALID_REQUEST')
  const { paperId } = parsed.data
  // The paper is decided again under the export key: an assignment that has
  // ended since the job was asked for means no file.
  await decideExam(conn, context, 'exams.export', paperId)
  // The reader applies this caller's own exams plans, so a pupil or a mark
  // they may not read is not there when the file is made.
  const sheet = await readSheet(conn, context, paperId)
  const settings = await readExamSettings(conn, context.schoolId)
  const paper = sheet.paper

  const columns: ExportColumn[] = [
    { header: 'Roll', key: 'roll', width: 7 },
    { header: 'Pupil', key: 'name', width: 30 },
    { header: 'Admission number', key: 'admissionNumber', width: 20 },
    ...sheet.components.map((component) => ({
      header: `${component.label} (${component.maxMarks})`,
      key: `c_${component.key}`,
      width: Math.max(12, component.label.length + 6),
    })),
    { header: 'Total (%)', key: 'percentage', width: 11 },
    { header: 'Grade', key: 'grade', width: 8 },
  ]
  const rows = sheet.rows.map((row) => {
    const values = new Map(row.cells.map((cell) => [cell.component, cell.value]))
    const cells: Record<string, string | number> = {}
    for (const component of sheet.components) cells[`c_${component.key}`] = markCell(values.get(component.key))
    const score = scoreParts(
      sheet.components.map((component) => ({ component: component.key, value: values.get(component.key) ?? null })),
    )
    return {
      roll: row.student.rollNumber ?? '',
      name: row.student.name,
      admissionNumber: row.student.admissionNumber,
      ...cells,
      percentage: score.percentage ?? '',
      grade: gradeFor(settings.gradeBands, score.percentage) ?? '',
    }
  })

  const examLabel = EXAM_PATTERN[paper.exam.kind].label
  return {
    bytes: await buildWorkbook({
      sheetName: `${paper.grade.name} ${paper.section.name} ${paper.subject.name}`,
      columns,
      rows,
    }),
    contentType: XLSX_CONTENT_TYPE,
    fileName: exportFileName(
      ['marks', examLabel, paper.grade.name, paper.section.name, paper.subject.name, fileNameDate(context.now)],
      'xlsx',
    ),
    rowCount: rows.length,
  }
}

registerProducer({ kind: 'exam_marks_register', produce })
