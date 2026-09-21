import ExcelJS from 'exceljs'

/**
 * One column of an export sheet. The width is in characters, the unit the
 * spreadsheet itself uses, so a column is wide enough to read without anyone
 * dragging it.
 */
export interface ExportColumn {
  readonly header: string
  readonly key: string
  readonly width: number
}

/** A cell value. Everything a person reads is text; counts stay numbers. */
export type ExportCell = string | number | null | undefined

export interface WorkbookInput {
  readonly sheetName: string
  readonly columns: readonly ExportColumn[]
  readonly rows: readonly Readonly<Record<string, ExportCell>>[]
}

const HEADER_FILL = 'FFF4F4F5'
const BORDER_COLOUR = 'FFE4E4E7'

/**
 * A date as people write it in India, from the ISO string the API keeps. The
 * result is display text, not a date cell: a spreadsheet that reformats dates
 * by locale would otherwise turn the same file into a different document on a
 * different computer.
 */
export function formatExportDate(value: string | Date | null | undefined): string {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${String(date.getUTCDate()).padStart(2, '0')} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`
}

/**
 * Build one sheet. Every value a person typed is written as a string, so a
 * value beginning with =, +, - or @ stays the characters somebody entered and
 * never becomes a formula the spreadsheet evaluates when the file is opened.
 */
export async function buildWorkbook(input: WorkbookInput): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  workbook.created = new Date()
  const sheet = workbook.addWorksheet(input.sheetName.slice(0, 31), {
    // The header stays in view while a long list is scrolled.
    views: [{ state: 'frozen', ySplit: 1 }],
  })
  sheet.columns = input.columns.map((column) => ({
    header: column.header,
    key: column.key,
    width: column.width,
  }))

  // The header row filters, so a reader can narrow a long list where they
  // opened it instead of exporting again with different criteria.
  if (input.columns.length > 0) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: input.columns.length } }
  }

  const header = sheet.getRow(1)
  header.font = { bold: true }
  header.height = 20
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } }
    cell.border = { bottom: { style: 'thin', color: { argb: BORDER_COLOUR } } }
    cell.alignment = { vertical: 'middle' }
  })

  for (const row of input.rows) {
    const added = sheet.addRow({})
    input.columns.forEach((column, index) => {
      const value = row[column.key]
      const cell = added.getCell(index + 1)
      if (value === null || value === undefined) {
        cell.value = ''
        return
      }
      // A number stays a number so totals still work; everything else is
      // written as text, which is what keeps a leading = harmless.
      cell.value = typeof value === 'number' ? value : String(value)
      if (typeof value !== 'number') cell.numFmt = '@'
    })
    added.alignment = { vertical: 'middle' }
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return new Uint8Array(buffer as ArrayBuffer)
}

/** The type the download route puts on a spreadsheet. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
