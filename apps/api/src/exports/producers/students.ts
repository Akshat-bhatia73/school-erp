import { inArray, sql } from 'drizzle-orm'
import { planPredicate, type AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import { students } from '@erp/db/schema'
import { z } from 'zod'
import { readPlan } from '../../modules/shared/index.ts'
import { enrollmentVisibility, studentTable } from '../../modules/students/reads.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, formatExportDate, XLSX_CONTENT_TYPE } from '../xlsx.ts'

/** What the POST route stored: the students the caller asked for. */
const Criteria = z.object({ studentIds: z.array(z.string().uuid()).max(20_000) })

interface Row extends Record<string, unknown> {
  admission_number: string
  first_name: string
  last_name: string | null
  grade_name: string | null
  section_name: string | null
  roll_number: number | null
  status: string
}

const COLUMNS = [
  { header: 'Admission number', key: 'admissionNumber', width: 20 },
  { header: 'Name', key: 'name', width: 32 },
  { header: 'Class', key: 'grade', width: 14 },
  { header: 'Section', key: 'section', width: 12 },
  { header: 'Roll number', key: 'roll', width: 14 },
  { header: 'Status', key: 'status', width: 14 },
] as const

/**
 * A list of students as a spreadsheet: only the basic columns the roster
 * shows. Nothing from the sensitive or medical blocks is here, so a file has
 * no Aadhaar, no address and no health note whoever produced it.
 *
 * The rows are read again under the export plan rather than taken from the
 * job: a student who left the caller's scope after the job was asked for is
 * simply not in the file.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const { studentIds } = Criteria.parse(criteria)
  const predicate = planPredicate(
    await readPlan(conn, context, 'students.export', 'student'),
    studentTable(),
  )
  // The class on a student is enrolment data, decided by the enrolment key,
  // exactly as the roster decides it: a caller who may not read a given
  // enrolment gets a row with no class rather than a row that leaks one.
  const enrollments = await enrollmentVisibility(conn, context)

  const result = await conn.db.execute<Row>(
    sql`SELECT students.admission_number, students.first_name, students.last_name,
               gr.name AS grade_name, sec.name AS section_name,
               current_enrollment.roll_number, students.status
          FROM students
          LEFT JOIN LATERAL (
            SELECT enrollments.roll_number, enrollments.section_id
              FROM enrollments
             WHERE enrollments.school_id = students.school_id
               AND enrollments.student_id = students.id
               AND enrollments.left_on IS NULL AND (${enrollments})
             ORDER BY enrollments.joined_on DESC, enrollments.id
             LIMIT 1
          ) current_enrollment ON TRUE
          LEFT JOIN sections sec ON sec.school_id = students.school_id
            AND sec.id = current_enrollment.section_id
          LEFT JOIN grades gr ON gr.school_id = students.school_id AND gr.id = sec.grade_id
         WHERE ${predicate} AND ${inArray(students.id, [...studentIds])}
         ORDER BY students.admission_number ASC, students.id ASC`,
  )

  const rows = result.rows.map((row) => ({
    admissionNumber: row.admission_number,
    name: `${row.first_name} ${row.last_name ?? ''}`.trim(),
    grade: row.grade_name ?? '',
    section: row.section_name ?? '',
    roll: row.roll_number ?? '',
    status: row.status,
  }))

  return {
    bytes: await buildWorkbook({ sheetName: 'Students', columns: COLUMNS, rows }),
    contentType: XLSX_CONTENT_TYPE,
    fileName: `Students ${formatExportDate(new Date())}.xlsx`,
    rowCount: rows.length,
  }
}

registerProducer({ kind: 'students', produce })
