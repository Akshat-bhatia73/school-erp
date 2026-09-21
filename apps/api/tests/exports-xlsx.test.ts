import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { buildWorkbook, formatExportDate } from '../src/exports/xlsx.ts'

async function firstSheet(bytes: Uint8Array): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  assert.ok(sheet)
  return sheet
}

test('a value that looks like a formula is stored as text', async () => {
  const bytes = await buildWorkbook({
    sheetName: 'Students',
    columns: [{ header: 'Name', key: 'name', width: 24 }],
    rows: [{ name: '=1+1' }],
  })
  const sheet = await firstSheet(bytes)
  const cell = sheet.getRow(2).getCell(1)
  assert.equal(cell.type, ExcelJS.ValueType.String)
  assert.equal(cell.value, '=1+1')
  assert.equal(cell.formula, undefined)
})

test('the header is bold and stays in view', async () => {
  const bytes = await buildWorkbook({
    sheetName: 'Staff',
    columns: [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Phone', key: 'phone', width: 16 },
    ],
    rows: [{ name: 'A Teacher', phone: '9876543210' }],
  })
  const sheet = await firstSheet(bytes)
  assert.equal(sheet.getRow(1).getCell(1).value, 'Name')
  assert.equal(sheet.getRow(1).font?.bold, true)
  assert.equal(sheet.views[0]?.state, 'frozen')
  // A phone number keeps its digits instead of becoming a number.
  const phone = sheet.getRow(2).getCell(2)
  assert.equal(phone.type, ExcelJS.ValueType.String)
  assert.equal(phone.value, '9876543210')
})

test('every column of the header row filters', async () => {
  const bytes = await buildWorkbook({
    sheetName: 'Students',
    columns: [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'Class', key: 'className', width: 16 },
      { header: 'Status', key: 'status', width: 14 },
    ],
    rows: [{ name: 'A Student', className: 'Class 10 B', status: 'Active' }],
  })
  const sheet = await firstSheet(bytes)
  // The saved file names the range the way a spreadsheet writes it.
  assert.equal(sheet.autoFilter, 'A1:C1')
})

test('a date is written the way people write it in India', () => {
  assert.equal(formatExportDate('2026-04-07T00:00:00.000Z'), '07 Apr 2026')
  assert.equal(formatExportDate(null), '')
  assert.equal(formatExportDate('not a date'), '')
})
