import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiRequestError } from '@/lib/http'
import {
  CHECK_FIELDS,
  FORM_ERROR,
  fieldErrors,
  focusFirstInvalid,
  friendlyIssues,
  serverFieldErrors,
  validate,
} from '@/lib/validation'

const labels = {
  firstName: 'first name',
  classId: { label: 'class', kind: 'select' as const },
  phone: 'phone number',
  email: 'email address',
  dateOfBirth: 'date of birth',
  fee: { label: 'fee amount', kind: 'number' as const },
  subjectIds: { label: 'subject', kind: 'list' as const },
  'guardians.*.phone': 'guardian phone number',
}

function errorsOf(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value)
  if (result.success) throw new Error('expected the check to fail')
  return fieldErrors(result.error, labels)
}

describe('fieldErrors', () => {
  it('asks for a missing field by name, and says choose for anything picked from a list', () => {
    const schema = z.object({ firstName: z.string(), classId: z.string(), dateOfBirth: z.string() })
    expect(errorsOf(schema, {})).toEqual({
      firstName: 'Enter the first name',
      classId: 'Choose a class',
      dateOfBirth: 'Choose a date of birth',
    })
  })

  it('treats an empty string as a missing field, not a length problem', () => {
    expect(errorsOf(z.object({ firstName: z.string().min(1) }), { firstName: '' })).toEqual({
      firstName: 'Enter the first name',
    })
  })

  it('names the limit when a value is too short or too long', () => {
    expect(errorsOf(z.object({ firstName: z.string().min(3) }), { firstName: 'ab' })).toEqual({
      firstName: 'Enter at least 3 characters for the first name',
    })
    expect(errorsOf(z.object({ firstName: z.string().max(5) }), { firstName: 'abcdef' })).toEqual({
      firstName: 'Use at most 5 characters for the first name',
    })
  })

  it('reads a number range as a range', () => {
    expect(errorsOf(z.object({ fee: z.number().min(100) }), { fee: 20 })).toEqual({
      fee: 'Enter 100 or more for the fee amount',
    })
    expect(errorsOf(z.object({ fee: z.number().max(10) }), { fee: 20 })).toEqual({
      fee: 'Enter 10 or less for the fee amount',
    })
  })

  it('counts the options a list needs', () => {
    expect(errorsOf(z.object({ subjectIds: z.array(z.string()).min(1) }), { subjectIds: [] })).toEqual({
      subjectIds: 'Choose at least one subject',
    })
    expect(errorsOf(z.object({ subjectIds: z.array(z.string()).max(2) }), { subjectIds: ['a', 'b', 'c'] })).toEqual({
      subjectIds: 'Choose at most 2 options for the subject',
    })
  })

  it('turns a format problem into the sentence for that kind of field', () => {
    expect(errorsOf(z.object({ phone: z.string().regex(/^\+91\d{10}$/) }), { phone: '12345' })).toEqual({
      phone: 'Enter a 10 digit phone number',
    })
    expect(errorsOf(z.object({ email: z.email() }), { email: 'nope' })).toEqual({
      email: 'Enter a valid email address',
    })
    expect(errorsOf(z.object({ dateOfBirth: z.iso.date() }), { dateOfBirth: '31-12-2020' })).toEqual({
      dateOfBirth: 'Choose a valid date',
    })
  })

  it('asks for a choice when the value is not one of the options', () => {
    expect(errorsOf(z.object({ classId: z.enum(['a', 'b']) }), { classId: 'z' })).toEqual({
      classId: 'Choose a class',
    })
  })

  it('falls back to checking the field when the problem has no better wording', () => {
    const schema = z.object({ firstName: z.string().refine(() => false) })
    expect(errorsOf(schema, { firstName: 'Asha' })).toEqual({ firstName: 'Check the first name' })
  })

  it('keeps a message the schema author wrote in plain English', () => {
    const schema = z.object({ firstName: z.string().min(3, 'Enter the full first name, not an initial') })
    expect(errorsOf(schema, { firstName: 'A' })).toEqual({ firstName: 'Enter the full first name, not an initial' })
  })

  it('covers a row of a list with one wildcard label', () => {
    const schema = z.object({ guardians: z.array(z.object({ phone: z.string().min(1) })) })
    expect(errorsOf(schema, { guardians: [{ phone: '' }] })).toEqual({
      'guardians.0.phone': 'Enter the guardian phone number',
    })
  })

  it('files a rule that belongs to no field on the form itself', () => {
    const schema = z.object({ from: z.string(), to: z.string() }).refine((v) => v.from <= v.to, 'The end date must come after the start date')
    expect(errorsOf(schema, { from: '2026-05-01', to: '2026-04-01' })).toEqual({
      [FORM_ERROR]: 'The end date must come after the start date',
    })
  })

  it('says something useful even for a field nobody labelled', () => {
    expect(errorsOf(z.object({ mystery: z.string() }), {})).toEqual({ mystery: 'Enter the details' })
  })
})

describe('friendlyIssues', () => {
  it('keeps the first problem per field, in the order they were found', () => {
    const schema = z.object({ firstName: z.string().min(2).max(3), classId: z.string() })
    const result = schema.safeParse({ firstName: '' })
    expect(result.success).toBe(false)
    if (result.success) return
    expect(friendlyIssues(result.error, labels)).toEqual([
      { field: 'firstName', message: 'Enter at least 2 characters for the first name' },
      { field: 'classId', message: 'Choose a class' },
    ])
  })
})

describe('validate', () => {
  it('gives back the parsed value when everything is right', () => {
    const result = validate(z.object({ firstName: z.string() }), { firstName: 'Asha' }, labels)
    expect(result).toEqual({ ok: true, data: { firstName: 'Asha' } })
  })
})

describe('serverFieldErrors', () => {
  it('lands a refused request on the form and never shows a code', () => {
    const error = new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'raw' })
    expect(serverFieldErrors(error)).toEqual({ [FORM_ERROR]: 'Some details were not right. Check them and try again.' })
  })

  it('names the field when the caller knows which one was refused', () => {
    const error = new ApiRequestError({ code: 'INVALID_REQUEST', status: 400, message: 'raw' })
    expect(serverFieldErrors(error, labels, 'phone')).toEqual({ phone: 'Check the phone number' })
  })

  it('keeps the plain sentence for any other failure', () => {
    const error = new ApiRequestError({ code: 'VERSION_CONFLICT', status: 409, message: 'raw' })
    expect(serverFieldErrors(error)[FORM_ERROR]).toContain('Someone else changed this')
  })
})

describe('focusFirstInvalid', () => {
  it('puts the cursor in the first field the person has to fix', () => {
    const form = document.createElement('div')
    form.innerHTML = '<input id="one" /><input id="two" aria-invalid="true" /><input id="three" aria-invalid="true" />'
    document.body.append(form)
    focusFirstInvalid(form)
    expect(document.activeElement?.id).toBe('two')
    form.remove()
  })

  it('does nothing when every field is right', () => {
    const form = document.createElement('div')
    form.innerHTML = '<input id="only" />'
    document.body.append(form)
    expect(() => focusFirstInvalid(form)).not.toThrow()
    form.remove()
  })
})

describe('CHECK_FIELDS', () => {
  it('is what a toast says instead of repeating one message', () => {
    expect(CHECK_FIELDS).toBe('Check the highlighted fields')
  })
})
