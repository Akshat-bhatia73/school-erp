import * as XLSX from 'xlsx'

export const IMPORT_HEADERS = [
  'Admission Number', 'First Name', 'Last Name', 'Date of Birth', 'Gender', 'Class', 'Section', 'Roll Number',
  'Father Name', 'Mother Name', 'Guardian Phone', 'Guardian Email', 'City', 'State', 'Pincode', 'Category', 'Admission Type',
]

export const COLUMN_HELP: Array<{ name: string; required: boolean; help: string }> = [
  { name: 'Admission Number', required: false, help: 'Leave blank and we will generate one. Must be new if you fill it.' },
  { name: 'First Name', required: true, help: 'The student’s given name.' },
  { name: 'Last Name', required: false, help: 'Surname, if the family uses one.' },
  { name: 'Date of Birth', required: true, help: 'Use DD-MM-YYYY or an Excel date cell.' },
  { name: 'Gender', required: true, help: 'Male, Female or Other.' },
  { name: 'Class', required: true, help: 'Must already exist, e.g. "Class 6" or "6".' },
  { name: 'Section', required: true, help: 'Must already exist for that class, e.g. "A".' },
  { name: 'Roll Number', required: false, help: 'A number. Leave blank to set it later.' },
  { name: 'Father Name / Mother Name', required: false, help: 'Used to create the parent record.' },
  { name: 'Guardian Phone', required: true, help: '10 digits, starting 6 to 9. This is the parent login.' },
  { name: 'Guardian Email', required: false, help: 'Used for fee receipts, if you have it.' },
  { name: 'City / State / Pincode', required: false, help: 'Home address. PIN code is 6 digits.' },
  { name: 'Category', required: false, help: 'General, OBC, SC, ST, EWS or Other.' },
  { name: 'Admission Type', required: false, help: 'Regular, RTE, Staff Ward or Scholarship.' },
]

const EXAMPLE_ROWS = [
  ['SVM/2026/101', 'Aarav', 'Sharma', '14-05-2015', 'Male', 'Class 6', 'A', 1, 'Rakesh Sharma', 'Neha Sharma', '9876543210', 'rakesh.sharma@example.com', 'Jaipur', 'Rajasthan', '302001', 'General', 'Regular'],
  ['', 'Diya', 'Verma', '02-11-2015', 'Female', 'Class 6', 'B', 2, 'Anil Verma', 'Pooja Verma', '9812345678', '', 'Jaipur', 'Rajasthan', '302012', 'OBC', 'RTE'],
]

/** Build and download the blank .xlsx template */
export function downloadTemplate() {
  const wb = XLSX.utils.book_new()
  const ws = XLSX.utils.aoa_to_sheet([IMPORT_HEADERS, ...EXAMPLE_ROWS])
  ws['!cols'] = IMPORT_HEADERS.map((h) => ({ wch: Math.max(12, h.length + 2) }))
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

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Ishita', 'Vivaan', 'Ananya', 'Reyansh', 'Myra', 'Arjun', 'Saanvi', 'Aditya', 'Kiara']
const LAST = ['Sharma', 'Verma', 'Gupta', 'Nair', 'Iyer', 'Singh', 'Patel', 'Joshi', 'Reddy', 'Mehta', 'Bose', 'Kaur']

/** 12 in-memory rows (9 good, 3 broken) so the screen can be demoed without a file */
export function sampleRows(className: string, sectionName: string): Record<string, unknown>[] {
  return FIRST.map((first, i) => {
    const row: Record<string, unknown> = {
      'Admission Number': '',
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
      'Admission Type': i % 5 === 0 ? 'RTE' : 'Regular',
    }
    if (i === 3) row['Guardian Phone'] = '12345' // bad phone
    if (i === 7) row['Date of Birth'] = '' // missing date of birth
    if (i === 10) row['Class'] = 'Class 99' // class that does not exist
    return row
  })
}
