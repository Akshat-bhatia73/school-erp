import { inArray, sql, type SQL } from 'drizzle-orm'
import { planPredicate, type AuthzConnection } from '@erp/authz'
import {
  DEFAULT_STUDENT_EXPORT_COLUMNS,
  STUDENT_EXPORT_COLUMNS,
  StudentExportColumns,
  type StudentExportColumn,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { students } from '@erp/db/schema'
import { z } from 'zod'
import { open, readPlan } from '../../modules/shared/index.ts'
import { enrollmentVisibility, studentTable } from '../../modules/students/reads.ts'
import { columnPredicates, guarded, inListOrder, permissionOf } from '../columns.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile, ProducerIo } from '../types.ts'
import { buildWorkbook, formatExportDate, XLSX_CONTENT_TYPE, type ExportCell } from '../xlsx.ts'

/**
 * What the POST route stored: the students the caller asked for and, when
 * they chose, the columns. A job with no columns is the six roster columns.
 */
const Criteria = z.object({
  studentIds: z.array(z.string().uuid()).max(20_000),
  columns: StudentExportColumns.optional(),
})

/** One linked guardian by relation: the primary first, then the oldest link. */
function guardianOf(relation: 'father' | 'mother' | null, field: 'name' | 'phone'): SQL {
  const value =
    field === 'name'
      ? sql`g.first_name || ' ' || coalesce(g.last_name, '')`
      : sql`g.phone`
  // The main contact is the primary guardian, whatever the relation.
  const which = relation === null ? sql`sg.is_primary` : sql`sg.relation = ${relation}`
  return sql`(SELECT ${value}
                FROM student_guardians sg
                JOIN guardians g ON g.school_id = sg.school_id AND g.id = sg.guardian_id
               WHERE sg.school_id = students.school_id AND sg.student_id = students.id AND ${which}
               ORDER BY sg.is_primary DESC, sg.created_at ASC, g.id ASC
               LIMIT 1)`
}

const trimmed = (value: unknown): ExportCell => (typeof value === 'string' ? value.trim() : '')
const text = (value: unknown): ExportCell => (value === null || value === undefined ? '' : String(value))
const capitalised = (value: unknown): ExportCell =>
  typeof value === 'string' && value !== '' ? `${value[0]?.toUpperCase()}${value.slice(1)}` : ''

interface ColumnDefinition {
  readonly width: number
  readonly value: SQL
  readonly format: (value: unknown) => ExportCell
}

/**
 * Every column the file can carry. The six default ones keep the widths and
 * values the file always had, so a job with no columns is the old file. The
 * whole Aadhaar number is selected sealed and opened below, only for the rows
 * whose cell the export identity key left filled.
 */
const DEFINITIONS: Record<StudentExportColumn, ColumnDefinition> = {
  admissionNumber: { width: 20, value: sql`students.admission_number`, format: text },
  name: { width: 32, value: sql`students.first_name || ' ' || coalesce(students.last_name, '')`, format: trimmed },
  grade: { width: 14, value: sql`gr.name`, format: text },
  section: { width: 12, value: sql`sec.name`, format: text },
  rollNumber: {
    width: 14,
    value: sql`current_enrollment.roll_number`,
    format: (value) => (value === null || value === undefined ? '' : Number(value)),
  },
  status: { width: 14, value: sql`students.status`, format: text },
  gender: { width: 12, value: sql`students.gender`, format: capitalised },
  dateOfBirth: { width: 16, value: sql`students.date_of_birth::text`, format: (value) => formatExportDate(text(value) as string) },
  category: { width: 14, value: sql`students.category`, format: text },
  admissionDate: { width: 16, value: sql`students.admission_date::text`, format: (value) => formatExportDate(text(value) as string) },
  address: { width: 40, value: sql`COALESCE(students.address #>> '{}', students.address::text)`, format: text },
  fatherName: { width: 26, value: guardianOf('father', 'name'), format: trimmed },
  fatherPhone: { width: 16, value: guardianOf('father', 'phone'), format: text },
  motherName: { width: 26, value: guardianOf('mother', 'name'), format: trimmed },
  motherPhone: { width: 16, value: guardianOf('mother', 'phone'), format: text },
  guardianName: { width: 26, value: guardianOf(null, 'name'), format: trimmed },
  guardianPhone: { width: 16, value: guardianOf(null, 'phone'), format: text },
  bloodGroup: { width: 12, value: sql`students.blood_group`, format: text },
  pen: { width: 16, value: sql`students.pen`, format: text },
  srn: { width: 20, value: sql`students.srn`, format: text },
  apaarLast4: { width: 14, value: sql`students.apaar_last4`, format: text },
  aadhaarLast4: { width: 14, value: sql`students.aadhaar_last4`, format: text },
  aadhaar: { width: 18, value: sql`students.aadhaar_ciphertext`, format: text },
}

/**
 * A list of students as a spreadsheet. With no columns chosen it is the six
 * roster columns and nothing else. A chosen column that needs a key beyond
 * the export key (the sensitive block, the medical block, the guardian
 * contact) is decided per row in SQL through that key's own plan, so a row the
 * caller could not open on the detail screen has an empty cell there.
 *
 * The rows are read again under the export plan rather than taken from the
 * job: a student who left the caller's scope after the job was asked for is
 * simply not in the file.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
  io?: ProducerIo,
): Promise<ExportFile> {
  const parsed = Criteria.parse(criteria)
  const columns = inListOrder(parsed.columns ?? DEFAULT_STUDENT_EXPORT_COLUMNS, STUDENT_EXPORT_COLUMNS)
  const predicate = planPredicate(
    await readPlan(conn, context, 'students.export', 'student'),
    studentTable(),
  )
  // The class on a student is enrolment data, decided by the enrolment key,
  // exactly as the roster decides it: a caller who may not read a given
  // enrolment gets a row with no class rather than a row that leaks one.
  const enrollments = await enrollmentVisibility(conn, context)
  const predicates = await columnPredicates(conn, context, columns, STUDENT_EXPORT_COLUMNS, 'student')

  const selected = sql.join(
    columns.map((key, index) => {
      const permission = permissionOf(STUDENT_EXPORT_COLUMNS, key)
      return sql`${guarded(DEFINITIONS[key].value, permission, predicates)} AS ${sql.identifier(`c${index}`)}`
    }),
    sql`, `,
  )

  const result = await conn.db.execute<Record<string, unknown>>(
    sql`SELECT ${selected}
          FROM students
          LEFT JOIN LATERAL (
            SELECT enrollments.roll_number, enrollments.section_id
              FROM enrollments
             WHERE enrollments.school_id = students.school_id
               AND enrollments.student_id = students.id
               AND (${enrollments})
             -- Same choice as the roster: the open enrolment, else the last one.
             ORDER BY (enrollments.left_on IS NULL) DESC, enrollments.joined_on DESC, enrollments.id
             LIMIT 1
          ) current_enrollment ON TRUE
          LEFT JOIN sections sec ON sec.school_id = students.school_id
            AND sec.id = current_enrollment.section_id
          LEFT JOIN grades gr ON gr.school_id = students.school_id AND gr.id = sec.grade_id
         WHERE ${predicate} AND ${inArray(students.id, [...parsed.studentIds])}
         ORDER BY students.admission_number ASC, students.id ASC`,
  )

  const rows = result.rows.map((row) => {
    const out: Record<string, ExportCell> = {}
    columns.forEach((key, index) => {
      const value = row[`c${index}`]
      if (key === 'aadhaar') {
        // Opened here and only here, for a row that passed the export
        // identity key in SQL; every other row selected NULL.
        if (typeof value !== 'string' || value === '') {
          out[key] = ''
          return
        }
        if (!io) throw new Error('the student export needs the data encryption key')
        out[key] = open(value, io.encryptionKey)
        return
      }
      out[key] = DEFINITIONS[key].format(value)
    })
    return out
  })

  return {
    bytes: await buildWorkbook({
      sheetName: 'Students',
      columns: columns.map((key) => ({
        header: STUDENT_EXPORT_COLUMNS[key].label,
        key,
        width: DEFINITIONS[key].width,
      })),
      rows,
    }),
    contentType: XLSX_CONTENT_TYPE,
    fileName: `Students ${formatExportDate(new Date())}.xlsx`,
    rowCount: rows.length,
  }
}

registerProducer({ kind: 'students', produce })
