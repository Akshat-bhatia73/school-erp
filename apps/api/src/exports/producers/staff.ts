import { and, asc, inArray } from 'drizzle-orm'
import type { AuthzConnection } from '@erp/authz'
import type { RequestContext } from '@erp/contracts/server'
import { staff } from '@erp/db/schema'
import { z } from 'zod'
import { staffScope } from '../../modules/staff/reads.ts'
import { registerProducer } from '../registry.ts'
import type { ExportFile } from '../types.ts'
import { buildWorkbook, formatExportDate, XLSX_CONTENT_TYPE } from '../xlsx.ts'

/** What the POST route stored: the staff records the caller asked for. */
const Criteria = z.object({ staffIds: z.array(z.string().uuid()).max(20_000) })

const COLUMNS = [
  { header: 'Employee code', key: 'employeeCode', width: 18 },
  { header: 'Name', key: 'name', width: 32 },
  { header: 'Role', key: 'designation', width: 26 },
  { header: 'Department', key: 'department', width: 22 },
  { header: 'Status', key: 'status', width: 14 },
] as const

/**
 * A list of staff as a spreadsheet, with the directory columns only: no phone,
 * no address, no pay and no identity number, because those are separate
 * decisions on a single record and a list export makes none of them.
 *
 * The rows come back through the export plan at production time, so somebody
 * who left the caller's scope since the job was asked for is not in the file.
 */
async function produce(
  conn: AuthzConnection,
  context: RequestContext,
  criteria: unknown,
): Promise<ExportFile> {
  const { staffIds } = Criteria.parse(criteria)
  const where = and(
    await staffScope(conn, context, 'staff.export'),
    inArray(staff.id, [...staffIds]),
  )
  const found = await conn.db
    .select({
      employeeCode: staff.employeeCode,
      firstName: staff.firstName,
      lastName: staff.lastName,
      designation: staff.designation,
      department: staff.department,
      status: staff.status,
    })
    .from(staff)
    .where(where)
    .orderBy(asc(staff.employeeCode), asc(staff.id))

  const rows = found.map((row) => ({
    employeeCode: row.employeeCode,
    name: `${row.firstName} ${row.lastName ?? ''}`.trim(),
    designation: row.designation,
    department: row.department ?? '',
    status: row.status,
  }))

  return {
    bytes: await buildWorkbook({ sheetName: 'Staff', columns: COLUMNS, rows }),
    contentType: XLSX_CONTENT_TYPE,
    fileName: `Staff ${formatExportDate(new Date())}.xlsx`,
    rowCount: rows.length,
  }
}

registerProducer({ kind: 'staff', produce })
