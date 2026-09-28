import { and, asc, inArray, sql, type SQL } from 'drizzle-orm'
import type { AuthzConnection } from '@erp/authz'
import {
  DEFAULT_STAFF_EXPORT_COLUMNS,
  STAFF_EXPORT_COLUMNS,
  StaffExportColumns,
  type StaffExportColumn,
} from '@erp/contracts'
import type { RequestContext } from '@erp/contracts/server'
import { staff } from '@erp/db/schema'
import { z } from 'zod'
import { open } from '../../modules/shared/crypto.ts'
import { staffScope } from '../../modules/staff/reads.ts'
import { columnPredicates, guarded, inListOrder, permissionOf } from '../columns.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile, ProducerIo } from '../types.ts'
import { buildWorkbook, formatExportDate, XLSX_CONTENT_TYPE, type ExportCell } from '../xlsx.ts'

/**
 * What the POST route stored: the staff records the caller asked for and,
 * when they chose, the columns. A job with no columns is the five directory
 * columns.
 */
const Criteria = z.object({
  staffIds: z.array(z.string().uuid()).max(20_000),
  columns: StaffExportColumns.optional(),
})

const trimmed = (value: unknown): ExportCell => (typeof value === 'string' ? value.trim() : '')
const text = (value: unknown): ExportCell => (value === null || value === undefined ? '' : String(value))
/** A stored code like part_time, as a person reads it: "Part time". */
const words = (value: unknown): ExportCell => {
  if (typeof value !== 'string' || value === '') return ''
  const spaced = value.replace(/_/g, ' ')
  return `${spaced[0]?.toUpperCase()}${spaced.slice(1)}`
}
const date = (value: unknown): ExportCell => formatExportDate(typeof value === 'string' ? value : null)

interface ColumnDefinition {
  readonly width: number
  readonly value: SQL
  readonly format: (value: unknown) => ExportCell
}

/**
 * Every column the file can carry. The five default ones keep the widths and
 * values the file always had, so a job with no columns is the old file. The
 * whole Aadhaar number is selected sealed and opened below, only for the rows
 * whose cell the export identity key left filled.
 */
const DEFINITIONS: Record<StaffExportColumn, ColumnDefinition> = {
  employeeCode: { width: 18, value: sql`${staff.employeeCode}`, format: text },
  name: { width: 32, value: sql`${staff.firstName} || ' ' || coalesce(${staff.lastName}, '')`, format: trimmed },
  designation: { width: 26, value: sql`${staff.designation}`, format: text },
  department: { width: 22, value: sql`${staff.department}`, format: text },
  status: { width: 14, value: sql`${staff.status}`, format: text },
  staffType: { width: 16, value: sql`${staff.staffType}`, format: words },
  employmentType: { width: 18, value: sql`${staff.employmentType}`, format: words },
  joiningDate: { width: 16, value: sql`${staff.joiningDate}::text`, format: date },
  qualification: { width: 26, value: sql`${staff.qualification}`, format: text },
  gender: { width: 12, value: sql`${staff.gender}`, format: words },
  dateOfBirth: { width: 16, value: sql`${staff.dateOfBirth}::text`, format: date },
  phone: { width: 16, value: sql`${staff.phone}`, format: text },
  email: { width: 28, value: sql`${staff.email}`, format: text },
  address: { width: 40, value: sql`COALESCE(${staff.address} #>> '{}', ${staff.address}::text)`, format: text },
  aadhaarLast4: { width: 14, value: sql`${staff.aadhaarLast4}`, format: text },
  aadhaar: { width: 18, value: sql`${staff.aadhaarCiphertext}`, format: text },
}

/**
 * A list of staff as a spreadsheet. With no columns chosen it is the five
 * directory columns and nothing else. A chosen column that needs a key beyond
 * the export key (employment or private fields) is decided per row in SQL
 * through that key's own plan, so a row the caller could not open on the
 * detail screen has an empty cell there. Pay is never a column.
 *
 * The rows come back through the export plan at production time, so somebody
 * who left the caller's scope since the job was asked for is not in the file.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
  io?: ProducerIo,
): Promise<ExportFile> {
  const parsed = Criteria.parse(criteria)
  const columns = inListOrder(parsed.columns ?? DEFAULT_STAFF_EXPORT_COLUMNS, STAFF_EXPORT_COLUMNS)
  const where = and(
    await staffScope(conn, context, 'staff.export'),
    inArray(staff.id, [...parsed.staffIds]),
  )
  const predicates = await columnPredicates(conn, context, columns, STAFF_EXPORT_COLUMNS, 'staff')
  const selection: Record<string, SQL> = {}
  columns.forEach((key, index) => {
    selection[`c${index}`] = guarded(DEFINITIONS[key].value, permissionOf(STAFF_EXPORT_COLUMNS, key), predicates)
  })
  const found = await conn.db
    .select(selection)
    .from(staff)
    .where(where)
    .orderBy(asc(staff.employeeCode), asc(staff.id))

  const rows = found.map((row: Record<string, unknown>) => {
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
        if (!io) throw new Error('the staff export needs the data encryption key')
        out[key] = open(value, io.encryptionKey)
        return
      }
      out[key] = DEFINITIONS[key].format(value)
    })
    return out
  })

  return {
    bytes: await buildWorkbook({
      sheetName: 'Staff',
      columns: columns.map((key) => ({
        header: STAFF_EXPORT_COLUMNS[key].label,
        key,
        width: DEFINITIONS[key].width,
      })),
      rows,
    }),
    contentType: XLSX_CONTENT_TYPE,
    fileName: `Staff ${formatExportDate(new Date())}.xlsx`,
    rowCount: rows.length,
  }
}

registerProducer({ kind: 'staff', produce })
