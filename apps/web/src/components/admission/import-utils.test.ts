import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { COLUMN_HELP, IMPORT_HEADERS, mapSheetRows, readSpreadsheet, sampleRows, templateWorkbook } from './import-utils'

const NEW_COLUMNS = ['Student Aadhaar', 'Guardian Aadhaar', 'Guardian PAN', 'Guardian Office Address']

const base = {
  'First Name': 'Aarav',
  'Date of Birth': '14-05-2015',
  Gender: 'Male',
  Class: 'Class 6',
  Section: 'A',
  'Guardian Phone': '9876543210',
}

/** A picked file holding these rows, the way the upload control hands it over. */
function sheetFile(rows: unknown[][]): File {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Students')
  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([bytes], 'students.xlsx')
}

describe('import template', () => {
  it('has the four identity columns, optional, in the header row and the help', () => {
    for (const column of NEW_COLUMNS) expect(IMPORT_HEADERS).toContain(column)
    const header = XLSX.utils.sheet_to_json<unknown[]>(templateWorkbook().Sheets['Students']!, { header: 1 })[0]
    expect(header).toEqual(IMPORT_HEADERS)
    for (const column of NEW_COLUMNS) {
      expect(COLUMN_HELP.find((entry) => entry.name === column)).toMatchObject({ required: false })
    }
  })

  it('has example rows the import itself accepts', async () => {
    const wb = templateWorkbook()
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const { rows, problems } = mapSheetRows(await readSpreadsheet(new File([bytes], 'template.xlsx')))
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({
      studentAadhaar: '234567890124',
      guardianAadhaar: '345678901238',
      guardianPan: 'ABCDE1234F',
      guardianOfficeAddress: 'Tonk Road, Jaipur',
    })
    expect(rows[1]?.studentAadhaar).toBeUndefined()
  })
})

describe('import sheet mapping of identity numbers', () => {
  it('maps the four columns, grouping and case forgiven', () => {
    const { rows, problems } = mapSheetRows([
      {
        ...base,
        'Student Aadhaar': '2345 6789 0124',
        'Guardian Aadhaar': '3456-7890-1238',
        'Guardian PAN': 'abcde1234f',
        'guardian office address': 'Tonk Road, Jaipur',
      },
    ])
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({
      studentAadhaar: '234567890124',
      guardianAadhaar: '345678901238',
      guardianPan: 'ABCDE1234F',
      guardianOfficeAddress: 'Tonk Road, Jaipur',
    })
  })

  it('leaves blank identity cells out of the request', () => {
    const { rows } = mapSheetRows([{ ...base, 'Student Aadhaar': '', 'Guardian PAN': '  ' }])
    expect(rows[0]?.studentAadhaar).toBeUndefined()
    expect(rows[0]?.guardianPan).toBeUndefined()
    // Undefined keys are dropped when the request is written, so nothing blank is sent.
    expect(JSON.stringify(rows[0])).not.toMatch(/studentAadhaar|guardianPan/)
  })

  it('reports a bad number on its row and column in plain English, and does not send the row', () => {
    const { rows, problems } = mapSheetRows([
      { ...base },
      { ...base, 'Student Aadhaar': '12345' },
      { ...base, 'Guardian Aadhaar': '234567890123' },
      { ...base, 'Guardian PAN': 'ABCDE12345' },
    ])
    expect(rows.map((row) => row.rowNumber)).toEqual([1])
    expect(problems).toEqual([
      { row: 2, field: 'studentAadhaar', message: 'Enter the 12 digit Aadhaar number' },
      { row: 3, field: 'guardianAadhaar', message: 'Check the Aadhaar number, those 12 digits are not a valid number' },
      { row: 4, field: 'guardianPan', message: 'Enter the 10 character PAN, like AAAAA9999A' },
    ])
  })

  it('reads an Aadhaar typed into a number cell as its twelve digits, not 2.34568E+11', async () => {
    const file = sheetFile([
      ['First Name', 'Date of Birth', 'Gender', 'Class', 'Section', 'Guardian Phone', 'Student Aadhaar'],
      ['Aarav', '14-05-2015', 'Male', 'Class 6', 'A', 9876543210, 234567890124],
    ])
    const { rows, problems } = mapSheetRows(await readSpreadsheet(file))
    expect(problems).toEqual([])
    expect(rows[0]).toMatchObject({ studentAadhaar: '234567890124', guardianPhone: '9876543210' })
  })

  it('sample data carries numbers on some rows and one broken Aadhaar', () => {
    const { rows, problems } = mapSheetRows(sampleRows('Class 6', 'A'))
    expect(rows.some((row) => row.studentAadhaar !== undefined)).toBe(true)
    expect(rows.some((row) => row.guardianPan !== undefined)).toBe(true)
    expect(problems.some((problem) => problem.field === 'studentAadhaar')).toBe(true)
  })
})
