import * as XLSX from 'xlsx'
import { StudentsBulkImportRow } from '@erp/contracts'

export const IMPORT_HEADERS = [
  'Admission Number', 'First Name', 'Last Name', 'Date of Birth', 'Gender', 'Class', 'Section', 'Roll Number',
  'Father Name', 'Mother Name', 'Guardian Phone', 'Guardian Email', 'City', 'State', 'Pincode', 'Category', 'Admission Type',
]

export const COLUMN_HELP: Array<{ name: string; required: boolean; help: string }> = [
  { name: 'Admission Number', required: true, help: 'The school’s own number. It must be filled in and must not already be in use.' },
  { name: 'First Name', required: true, help: 'The student’s given name.' },
  { name: 'Last Name', required: false, help: 'Surname, if the family uses one.' },
  { name: 'Date of Birth', required: true, help: 'Use DD-MM-YYYY or an Excel date cell.' },
  { name: 'Gender', required: true, help: 'Male, Female or Other.' },
  { name: 'Class', required: true, help: 'Must already exist, e.g. "Class 6" or "6".' },
  { name: 'Section', required: true, help: 'Must already exist for that class, e.g. "A".' },
  { name: 'Roll Number', required: false, help: 'A number. Leave blank to set it later.' },
  { name: 'Father Name / Mother Name', required: false, help: 'Used to create the parent record.' },
  { name: 'Guardian Phone', required: true, help: '10 digits, starting 6 to 9.' },
  { name: 'Guardian Email', required: false, help: 'Used for fee receipts, if you have it.' },
  { name: 'City / State / Pincode', required: false, help: 'Home address. PIN code is 6 digits.' },
  { name: 'Category', required: false, help: 'General, OBC, SC, ST or EWS.' },
  { name: 'Admission Type', required: false, help: 'New, Transfer or Readmission.' },
]

const EXAMPLE_ROWS = [
  ['SVM/2026/101', 'Aarav', 'Sharma', '14-05-2015', 'Male', 'Class 6', 'A', 1, 'Rakesh Sharma', 'Neha Sharma', '9876543210', 'rakesh.sharma@example.com', 'Jaipur', 'Rajasthan', '302001', 'General', 'New'],
  ['SVM/2026/102', 'Diya', 'Verma', '02-11-2015', 'Female', 'Class 6', 'B', 2, 'Anil Verma', 'Pooja Verma', '9812345678', '', 'Jaipur', 'Rajasthan', '302012', 'OBC', 'Transfer'],
]

/** Build and download the blank .xlsx template */
export function downloadTemplate() {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([IMPORT_HEADERS, ...EXAMPLE_ROWS])
  ws['!cols'] = IMPORT_HEADERS.map((header) => ({ wch: Math.max(12, header.length + 2) }))
  XLSX.utils.book_append_sheet(wb, ws, 'Students')
  XLSX.writeFile(wb, 'student-import-template.xlsx')
}

/** Read a picked .xlsx/.csv file into plain rows keyed by the header names */
export async function readSpreadsheet(file: File): Promise<Record<string, unknown>[]> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf)
  const first = wb.SheetNames[0]
  if (!first) return []
  const sheet = wb.Sheets[first]
  if (!sheet) return []
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false })
}

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim())
const optional = (value: unknown): string | undefined => (text(value) === '' ? undefined : text(value))

/** 14-05-2015, 14/05/2015 and 2015-05-14 all become 2015-05-14. Anything else is left alone. */
function toIsoDate(value: unknown): string {
  const raw = text(value)
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(raw)
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`
  const ymd = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(raw)
  if (ymd) return `${ymd[1]}-${ymd[2]!.padStart(2, '0')}-${ymd[3]!.padStart(2, '0')}`
  return raw
}

function toNumber(value: unknown): number | undefined {
  const raw = text(value)
  if (raw === '') return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

export interface SheetProblem {
  row: number
  field: string
  message: string
}

export interface MappedSheet {
  /** Rows shaped the way the import contract wants them. The server decides if they are usable. */
  rows: StudentsBulkImportRow[]
  /** Rows this app could not even put in the request: the person must fix the file. */
  problems: SheetProblem[]
}

/**
 * Turn the spreadsheet into import rows. A row the contract cannot describe at all is reported as
 * a problem in the file rather than sent; nothing here decides that a row is valid — only the
 * server does that, after resolving the class, the section and the admission number.
 */
export function mapSheetRows(sheetRows: Record<string, unknown>[]): MappedSheet {
  const rows: StudentsBulkImportRow[] = []
  const problems: SheetProblem[] = []

  sheetRows.forEach((sheetRow, index) => {
    const rowNumber = index + 1
    const candidate = {
      rowNumber,
      admissionNumber: optional(sheetRow['Admission Number']),
      firstName: text(sheetRow['First Name']),
      lastName: optional(sheetRow['Last Name']),
      dateOfBirth: toIsoDate(sheetRow['Date of Birth']),
      gender: text(sheetRow['Gender']).toLowerCase(),
      grade: text(sheetRow['Class']),
      section: text(sheetRow['Section']),
      rollNumber: toNumber(sheetRow['Roll Number']),
      fatherName: optional(sheetRow['Father Name']),
      motherName: optional(sheetRow['Mother Name']),
      guardianPhone: text(sheetRow['Guardian Phone']).replace(/\D/g, ''),
      guardianEmail: optional(sheetRow['Guardian Email']),
      city: optional(sheetRow['City']),
      state: optional(sheetRow['State']),
      pincode: optional(sheetRow['Pincode']),
      category: optional(text(sheetRow['Category']).toLowerCase()),
      admissionType: optional(text(sheetRow['Admission Type']).toLowerCase()),
    }

    const parsed = StudentsBulkImportRow.safeParse(candidate)
    if (parsed.success) {
      rows.push(parsed.data)
      return
    }
    for (const issue of parsed.error.issues) {
      problems.push({ row: rowNumber, field: issue.path.map(String).join('.') || 'row', message: issue.message })
    }
  })

  return { rows, problems }
}

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Ishita', 'Vivaan', 'Ananya', 'Reyansh', 'Myra', 'Arjun', 'Saanvi', 'Aditya', 'Kiara']
const LAST = ['Sharma', 'Verma', 'Gupta', 'Nair', 'Iyer', 'Singh', 'Patel', 'Joshi', 'Reddy', 'Mehta', 'Bose', 'Kaur']

/** 12 in-memory rows so the screen can be tried without a file. Some rows are deliberately broken. */
export function sampleRows(className: string, sectionName: string): Record<string, unknown>[] {
  // Admission numbers must be new, so the sample stamps each run with the clock.
  const stamp = String(Date.now()).slice(-6)
  return FIRST.map((first, i) => {
    const row: Record<string, unknown> = {
      'Admission Number': `SMP/${stamp}/${String(i + 1).padStart(2, '0')}`,
      'First Name': first,
      'Last Name': LAST[i] ?? 'Kumar',
      'Date of Birth': `${String((i % 27) + 1).padStart(2, '0')}-0${(i % 9) + 1}-2015`,
      'Gender': i % 2 === 0 ? 'Male' : 'Female',
      'Class': className,
      'Section': sectionName,
      'Roll Number': i + 1,
      'Father Name': `Rajesh ${LAST[i] ?? 'Kumar'}`,
      'Mother Name': `Sunita ${LAST[i] ?? 'Kumar'}`,
      'Guardian Phone': `98${String(76543000 + i * 137).padStart(8, '0')}`,
      'Guardian Email': `${first.toLowerCase()}.parent@example.com`,
      'City': 'Jaipur',
      'State': 'Rajasthan',
      'Pincode': '302001',
      'Category': ['General', 'OBC', 'SC', 'EWS'][i % 4],
      'Admission Type': i % 5 === 0 ? 'Transfer' : 'New',
    }
    if (i === 3) row['Guardian Phone'] = '12345'
    if (i === 7) row['Date of Birth'] = ''
    if (i === 10) row['Class'] = 'Class 99'
    return row
  })
}
