/** The admission draft only matters if it becomes a request the contract accepts. */
import { describe, expect, it } from 'vitest'
import { StudentsAdmitRequest } from '@erp/contracts'
import { emptyDraft, emptyGuardian, errorsForStep, toAdmitRequest, validateDraft } from './admit-state'
import { mapSheetRows, sampleRows } from './import-utils'

function filledDraft() {
  return {
    ...emptyDraft(),
    firstName: 'Aarav',
    lastName: 'Sharma',
    dateOfBirth: '2015-05-14',
    gender: 'male' as const,
    admissionNumber: 'SVM/2026/101',
    admissionDate: '2026-04-01',
    sectionId: 'section-1',
    guardians: [{ ...emptyGuardian('father'), firstName: 'Rakesh', phone: '9876543210' }],
  }
}

describe('admission draft', () => {
  it('becomes a request the contract accepts, with the ten digit phone in E.164', () => {
    const request = toAdmitRequest(filledDraft())
    const parsed = StudentsAdmitRequest.safeParse(request)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.guardians[0]).toMatchObject({
      guardian: { firstName: 'Rakesh', phone: '+919876543210' },
      relation: 'father',
      isPrimary: true,
    })
  })

  it('puts each problem on the step that can fix it', () => {
    const draft = { ...filledDraft(), firstName: '', sectionId: '' }
    const errors = validateDraft(draft)
    expect(Object.keys(errorsForStep(0, errors))).toContain('firstName')
    expect(Object.keys(errorsForStep(2, errors))).toContain('sectionId')
  })
})

describe('import sheet mapping', () => {
  it('sends the rows the contract can describe and reports the rest as problems', () => {
    const { rows, problems } = mapSheetRows([
      { 'First Name': 'Aarav', 'Date of Birth': '14-05-2015', Gender: 'Male', Class: 'Class 6', Section: 'A', 'Guardian Phone': '9876543210' },
      { 'First Name': 'Broken', 'Date of Birth': '', Gender: 'Male', Class: 'Class 6', Section: 'A', 'Guardian Phone': '12345' },
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rowNumber: 1, dateOfBirth: '2015-05-14', gender: 'male', guardianPhone: '9876543210' })
    expect(problems.map((problem) => problem.row)).toEqual([2, 2])
  })
})

describe('sample rows', () => {
  it('gives every row an admission number, because the server requires one', () => {
    const rows = sampleRows('Class 6', 'A')
    expect(rows).toHaveLength(12)
    for (const row of rows) expect(String(row['Admission Number'])).not.toBe('')
    expect(new Set(rows.map((row) => row['Admission Number'])).size).toBe(12)
  })
})
