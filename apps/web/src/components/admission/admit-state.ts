/**
 * The admission form's own state, and the one place it becomes a StudentsAdmitRequest.
 *
 * Nothing here decides anything: the contract is the only judge of whether a draft may be sent,
 * so every check is a safeParse of the request the screen would post.
 */
import { StudentsAdmitRequest } from '@erp/contracts'
import type { AdmitStudentInput } from '@/lib/api/students'
import type { Errors } from './fields'

export type GuardianRelation = 'father' | 'mother' | 'guardian' | 'grandparent' | 'sibling' | 'other'

export interface GuardianDraft {
  /** A brand new guardian record, or one this school already holds. */
  mode: 'new' | 'existing'
  guardianId: string
  relation: GuardianRelation
  firstName: string
  lastName: string
  /** Ten digits as people write them; the request carries the +91 form. */
  phone: string
  occupation: string
  address: string
  receivesNotifications: boolean
}

export interface AdmitDraft {
  firstName: string
  lastName: string
  dateOfBirth: string
  gender: 'male' | 'female' | 'other' | ''
  category: string
  admissionNumber: string
  admissionDate: string
  admissionType: string
  address: string
  sectionId: string
  rollNumber: string
  guardians: GuardianDraft[]
  primaryIndex: number
}

export const todayIso = () => new Date().toISOString().slice(0, 10)

export function emptyGuardian(relation: GuardianRelation = 'father'): GuardianDraft {
  return { mode: 'new', guardianId: '', relation, firstName: '', lastName: '', phone: '', occupation: '', address: '', receivesNotifications: true }
}

export function emptyDraft(): AdmitDraft {
  return {
    firstName: '', lastName: '', dateOfBirth: '', gender: '', category: '',
    admissionNumber: '', admissionDate: todayIso(), admissionType: '', address: '',
    sectionId: '', rollNumber: '', guardians: [emptyGuardian('father')], primaryIndex: 0,
  }
}

const clean = (value: string) => (value.trim() === '' ? undefined : value.trim())

/** Ten digits become the E.164 number the contract expects. */
export function toE164(tenDigits: string): string {
  const digits = tenDigits.replace(/\D/g, '')
  return digits === '' ? '' : `+91${digits}`
}

/** The request body this draft stands for, ready for StudentsAdmitRequest.safeParse. */
export function toAdmitRequest(draft: AdmitDraft): AdmitStudentInput {
  return {
    firstName: draft.firstName.trim(),
    lastName: clean(draft.lastName),
    admissionNumber: draft.admissionNumber.trim(),
    dateOfBirth: draft.dateOfBirth,
    gender: (draft.gender || 'male') as 'male' | 'female' | 'other',
    category: clean(draft.category),
    admissionType: clean(draft.admissionType),
    admissionDate: draft.admissionDate,
    address: clean(draft.address),
    sectionId: draft.sectionId,
    rollNumber: draft.rollNumber.trim() === '' ? undefined : Number(draft.rollNumber),
    guardians: draft.guardians.map((guardian, index) => ({
      ...(guardian.mode === 'existing'
        ? { guardianId: guardian.guardianId.trim() }
        : {
            guardian: {
              firstName: guardian.firstName.trim(),
              lastName: clean(guardian.lastName),
              phone: toE164(guardian.phone),
              occupation: clean(guardian.occupation),
              address: clean(guardian.address),
            },
          }),
      relation: guardian.relation,
      isPrimary: index === draft.primaryIndex,
      receivesNotifications: guardian.receivesNotifications,
    })),
  } as AdmitStudentInput
}

/** Which step owns which top-level field, so an error lands on the step that can fix it. */
const STEP_FIELDS: Record<number, string[]> = {
  0: ['firstName', 'lastName', 'dateOfBirth', 'gender', 'category'],
  1: ['guardians'],
  2: ['admissionNumber', 'admissionDate', 'admissionType', 'address', 'sectionId', 'rollNumber'],
}

/** Every problem the contract found, keyed by dotted path. */
export function validateDraft(draft: AdmitDraft): Errors {
  const parsed = StudentsAdmitRequest.safeParse(toAdmitRequest(draft))
  const errors: Errors = {}
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.') || 'form'
      if (!errors[path]) errors[path] = issue.message
    }
  }
  if (!draft.gender) errors.gender = 'Pick a gender'
  if (!draft.sectionId) errors.sectionId = 'Pick a class and section'
  return errors
}

/** The step a dotted error path belongs to, or 2 for anything unrecognised. */
export function stepOfError(path: string): number {
  const head = path.split('.')[0] ?? ''
  for (const [step, fields] of Object.entries(STEP_FIELDS)) {
    if (fields.includes(head)) return Number(step)
  }
  return 2
}

/** Only the problems this step can fix. */
export function errorsForStep(step: number, errors: Errors): Errors {
  return Object.fromEntries(Object.entries(errors).filter(([path]) => stepOfError(path) === step))
}

/** "SVM/2026/014" */
export function suggestAdmissionNumber(shortName: string, seq: number) {
  return `${shortName.toUpperCase()}/${new Date().getFullYear()}/${String(seq).padStart(3, '0')}`
}
