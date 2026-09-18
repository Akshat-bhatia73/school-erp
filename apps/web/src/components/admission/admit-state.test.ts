/**
 * The admission draft only matters if it becomes a request the contract accepts, and the contract
 * no longer takes an admission number: the server assigns it.
 */
import { describe, expect, it } from 'vitest'
import { StudentsAdmitRequest, type ConsentPurpose } from '@erp/contracts'
import { consentEntries, emptyDraft, emptyGuardian, errorsForStep, toAdmitRequest, validateDraft } from './admit-state'
import { mapSheetRows, sampleRows } from './import-utils'

function filledDraft() {
  return {
    ...emptyDraft(),
    firstName: 'Aarav',
    lastName: 'Sharma',
    dateOfBirth: '2015-05-14',
    gender: 'male' as const,
    admissionDate: '2026-04-01',
    sectionId: 'section-1',
    guardians: [{ ...emptyGuardian('father'), firstName: 'Rakesh', phone: '9876543210' }],
  }
}

describe('admission draft', () => {
  it('never sends an admission number, because the server assigns it', () => {
    expect(toAdmitRequest(filledDraft())).not.toHaveProperty('admissionNumber')
    expect(StudentsAdmitRequest.safeParse({ ...toAdmitRequest(filledDraft()), admissionNumber: 'SVM/2026-27/101' }).success).toBe(false)
  })

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
    // The class step moved one along when the consent step was added between guardians and class.
    expect(Object.keys(errorsForStep(3, errors))).toContain('sectionId')
  })

  it('sends no consents when nothing was ticked, because an untouched box is not an answer', () => {
    expect(toAdmitRequest(filledDraft())).not.toHaveProperty('consents')
    expect(consentEntries(filledDraft())).toEqual([])
  })

  it('emits one row per guardian and purpose, pointing at the guardian by index', () => {
    const draft = {
      ...filledDraft(),
      guardians: [
        { ...emptyGuardian('father'), firstName: 'Rakesh', phone: '9876543210' },
        {
          ...emptyGuardian('mother'), firstName: 'Meera', phone: '9876543211',
          consentPurposes: ['photographs', 'communication'] as ConsentPurpose[],
          consentMethod: 'signed_form' as const,
          consentEvidence: 'Form 12',
        },
      ],
    }
    const request = toAdmitRequest(draft)
    const parsed = StudentsAdmitRequest.safeParse(request)

    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.consents).toEqual([
      { guardianIndex: 1, purpose: 'photographs', method: 'signed_form', evidenceReference: 'Form 12' },
      { guardianIndex: 1, purpose: 'communication', method: 'signed_form', evidenceReference: 'Form 12' },
    ])
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
    // A sheet with no Admission Number column is fine: the server numbers those rows.
    expect(rows[0]?.admissionNumber).toBeUndefined()
    expect(problems.map((problem) => problem.row)).toEqual([2, 2])
  })
})

describe('sample rows', () => {
  it('leaves most admission numbers blank and keeps the supplied ones unique', () => {
    const rows = sampleRows('Class 6', 'A')
    expect(rows).toHaveLength(12)
    const supplied = rows.map((row) => String(row['Admission Number'])).filter((value) => value !== '')
    expect(supplied.length).toBeGreaterThan(0)
    expect(supplied.length).toBeLessThan(rows.length)
    expect(new Set(supplied).size).toBe(supplied.length)
  })
})
