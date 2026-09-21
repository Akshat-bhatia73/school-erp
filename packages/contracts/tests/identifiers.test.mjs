import test from 'node:test'
import assert from 'node:assert/strict'
import * as c from '../src/index.ts'

// Published Verhoeff-valid examples; the last digit is the check digit.
const validAadhaar = ['234567890124', '999941057058']

test('Aadhaar takes twelve digits, with or without the spaces people type', () => {
  for (const number of validAadhaar) {
    assert.equal(c.AadhaarNumber.parse(number), number)
    const spaced = `${number.slice(0, 4)} ${number.slice(4, 8)} ${number.slice(8)}`
    assert.equal(c.AadhaarNumber.parse(spaced), number)
  }
})

test('Aadhaar refuses the wrong length and a failed check digit, in plain English', () => {
  for (const bad of ['1234', '23456789012', '2345678901234', 'abcd12345678']) {
    const result = c.AadhaarNumber.safeParse(bad)
    assert.equal(result.success, false, bad)
    assert.equal(result.error.issues[0].message, 'Enter the 12 digit Aadhaar number')
  }
  const wrongCheckDigit = c.AadhaarNumber.safeParse('234567890123')
  assert.equal(wrongCheckDigit.success, false)
  assert.equal(
    wrongCheckDigit.error.issues[0].message,
    'Check the Aadhaar number, those 12 digits are not a valid number',
  )
})

test('PAN is ten characters and comes back in capitals', () => {
  assert.equal(c.PanNumber.parse('abcde1234f'), 'ABCDE1234F')
  assert.equal(c.PanNumber.parse(' ABCDE1234F '), 'ABCDE1234F')
  for (const bad of ['ABCD1234F', 'ABCDE1234', 'ABCDE12345', '1BCDE1234F']) {
    const result = c.PanNumber.safeParse(bad)
    assert.equal(result.success, false, bad)
    assert.equal(result.error.issues[0].message, 'Enter the 10 character PAN, like AAAAA9999A')
  }
})

test('only the last digits of either number are ever shown', () => {
  assert.equal(c.aadhaarLast4('2345 6789 0124'), '0124')
  assert.equal(c.panLast4('abcde1234f'), '234F')
  assert.equal(c.GuardianPrivate.shape.panLast4.safeParse('234F').success, true)
  assert.equal(c.GuardianPrivate.shape.panLast4.safeParse('ABCDE1234F').success, false)
  assert.equal(c.StudentSensitive.shape.aadhaarLast4.safeParse('0124').success, true)
  assert.equal(c.StudentSensitive.shape.aadhaarLast4.safeParse('234567890124').success, false)
})

test('a promotion may leave students out but not name nobody', () => {
  const base = {
    fromAcademicYearId: 'year-1', toAcademicYearId: 'year-2',
    fromSectionId: 'section-1', toSectionId: 'section-2', reason: 'End of year',
  }
  assert.equal(c.PromoteStudentsRequest.safeParse({ ...base, studentIds: ['a'], detainedStudentIds: [] }).success, true)
  assert.equal(c.PromoteStudentsRequest.safeParse({ ...base, studentIds: [], detainedStudentIds: ['b'] }).success, true)
  assert.equal(c.PromoteStudentsRequest.safeParse({ ...base, studentIds: [], detainedStudentIds: [] }).success, false)
  assert.equal(c.PromoteStudentsRequest.safeParse({ ...base, studentIds: ['a'], detainedStudentIds: ['a'] }).success, false)
})

test('a guardian request takes the whole number and a response never does', () => {
  const update = c.StudentsUpdateGuardianRequest.parse({
    expectedVersion: 1, pan: 'abcde1234f', aadhaar: '2345 6789 0124', officeAddress: null,
  })
  assert.equal(update.pan, 'ABCDE1234F')
  assert.equal(update.aadhaar, '234567890124')
  assert.equal(update.officeAddress, null)
  for (const field of ['pan', 'aadhaar', 'panCiphertext']) {
    assert.equal(
      c.GuardianPrivate.safeParse({ id: 'g-1', displayName: 'Meera', phone: '+919876543210', [field]: 'x' }).success,
      false,
      field,
    )
  }
})
