/**
 * The admission form's own state, and the one place it becomes a StudentsAdmitRequest.
 *
 * Nothing here decides anything: the contract is the only judge of whether a draft may be sent,
 * so every check is a safeParse of the request the screen would post.
 */
import { CONSENT_PURPOSES, StudentsAdmitRequest } from '@erp/contracts'
import type { ConsentMethod, ConsentPurpose } from '@erp/contracts'
import type { AdmitStudentInput } from '@/lib/api/students'
import { fieldErrors, type FieldLabels } from '@/lib/validation'
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
  /** Optional, and the same shape as the home address. */
  officeAddress: string
  /** Typed in full, sent once and never held anywhere else. */
  pan: string
  aadhaar: string
  receivesNotifications: boolean
  /** The purposes this guardian agreed to, and how that agreement was taken. */
  consentPurposes: ConsentPurpose[]
  consentMethod: ConsentMethod
  consentEvidence: string
}

export interface AdmitDraft {
  firstName: string
  lastName: string
  dateOfBirth: string
  gender: 'male' | 'female' | 'other' | ''
  category: string
  admissionDate: string
  admissionType: string
  address: string
  /** The student's own Aadhaar number, optional, twelve digits. */
  aadhaar: string
  /** The government numbers, all optional: APAAR id, PEN (UDISE+) and the state's SRN. */
  apaarId: string
  pen: string
  srn: string
  sectionId: string
  rollNumber: string
  guardians: GuardianDraft[]
  primaryIndex: number
  /**
   * How consent is recorded. `form`: the one tick for the consent section of the admission form,
   * which covers every purpose for the primary guardian. `each`: the purposes ticked one by one
   * on each guardian, as before.
   */
  consentMode: 'form' | 'each'
  /** The family signed the consent section of the admission form. */
  consentSigned: boolean
  /** The form number or file reference for that signature, if there is one. */
  consentFormReference: string
}

/**
 * The photograph chosen on the form. It is kept beside the draft, never inside it: the draft is
 * plain data that becomes the request, and a picture is bytes that go up after the admission.
 */
export interface ChosenPhoto {
  /** The picture as it will be sent: already shrunk and re-encoded as JPEG. */
  prepared: Blob
  /** A data address for the preview, so there is nothing to release afterwards. */
  preview: string
  fileName: string
}

/** A pupil's photograph may be kept only when a guardian agreed to photographs. */
export function photoConsented(draft: AdmitDraft): boolean {
  return consentEntries(draft).some((entry) => entry.purpose === 'photographs')
}

/**
 * Admit the pupil, then send the photograph with the new pupil's id when the family agreed to it.
 * A photograph that fails never undoes the admission: the pupil exists and the office is told
 * the picture still needs adding.
 */
export async function admitWithPhoto<S extends { id: string; version: number }>(
  draft: AdmitDraft,
  photo: ChosenPhoto | null,
  calls: {
    create: (body: AdmitStudentInput) => Promise<S>
    uploadPhoto: (studentId: string, file: Blob, expectedVersion: number) => Promise<unknown>
  },
): Promise<{ student: S; photo: 'none' | 'saved' | 'skipped' | { failed: unknown } }> {
  const student = await calls.create(toAdmitRequest(draft))
  if (photo === null) return { student, photo: 'none' }
  if (!photoConsented(draft)) return { student, photo: 'skipped' }
  try {
    await calls.uploadPhoto(student.id, photo.prepared, student.version)
    return { student, photo: 'saved' }
  } catch (error) {
    return { student, photo: { failed: error } }
  }
}

export const todayIso = () => new Date().toISOString().slice(0, 10)

export function emptyGuardian(relation: GuardianRelation = 'father'): GuardianDraft {
  return {
    mode: 'new', guardianId: '', relation, firstName: '', lastName: '', phone: '', occupation: '', address: '',
    officeAddress: '', pan: '', aadhaar: '',
    receivesNotifications: true, consentPurposes: [], consentMethod: 'in_person', consentEvidence: '',
  }
}

export function emptyDraft(): AdmitDraft {
  return {
    firstName: '', lastName: '', dateOfBirth: '', gender: '', category: '',
    admissionDate: todayIso(), admissionType: '', address: '', aadhaar: '', apaarId: '', pen: '', srn: '',
    sectionId: '', rollNumber: '', guardians: [emptyGuardian('father')], primaryIndex: 0,
    consentMode: 'form', consentSigned: false, consentFormReference: '',
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
  const consents = consentEntries(draft)
  return {
    firstName: draft.firstName.trim(),
    lastName: clean(draft.lastName),
    dateOfBirth: draft.dateOfBirth,
    gender: (draft.gender || 'male') as 'male' | 'female' | 'other',
    category: clean(draft.category),
    admissionType: clean(draft.admissionType),
    admissionDate: draft.admissionDate,
    address: clean(draft.address),
    aadhaar: clean(draft.aadhaar),
    apaarId: clean(draft.apaarId),
    pen: clean(draft.pen),
    srn: clean(draft.srn),
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
              officeAddress: clean(guardian.officeAddress),
              pan: clean(guardian.pan),
              aadhaar: clean(guardian.aadhaar),
            },
          }),
      relation: guardian.relation,
      isPrimary: index === draft.primaryIndex,
      receivesNotifications: guardian.receivesNotifications,
    })),
    // Consent is per guardian and per purpose; the server matches guardianIndex to the array above.
    ...(consents.length > 0 ? { consents } : {}),
  } as AdmitStudentInput
}

/**
 * The consent rows this draft stands for. The signed form gives one row per purpose for the
 * primary guardian; one by one gives a row per guardian and ticked purpose. Nothing ticked is no
 * rows at all.
 */
export function consentEntries(draft: AdmitDraft) {
  if (draft.consentMode === 'form') {
    if (!draft.consentSigned) return []
    return CONSENT_PURPOSES.map((purpose) => ({
      guardianIndex: draft.primaryIndex,
      purpose,
      method: 'signed_form' as const,
      evidenceReference: clean(draft.consentFormReference),
    }))
  }
  return draft.guardians.flatMap((guardian, guardianIndex) =>
    guardian.consentPurposes.map((purpose) => ({
      guardianIndex,
      purpose,
      method: guardian.consentMethod,
      evidenceReference: clean(guardian.consentEvidence),
    })),
  )
}

/** Which step owns which top-level field, so an error lands on the step that can fix it. */
const STEP_FIELDS: Record<number, string[]> = {
  0: ['firstName', 'lastName', 'dateOfBirth', 'gender', 'category', 'aadhaar', 'apaarId', 'pen', 'srn'],
  // Consent is recorded on the guardians step, so its problems land there.
  1: ['guardians', 'consents'],
  2: ['admissionDate', 'admissionType', 'address', 'sectionId', 'rollNumber'],
}

/** The class step, where anything unrecognised is shown. */
const CLASS_STEP = 2

/** The words each field goes by on the form, so a problem reads as plain English. */
export const ADMIT_LABELS: FieldLabels = {
  firstName: 'first name',
  lastName: 'last name',
  dateOfBirth: 'date of birth',
  gender: { label: 'gender', kind: 'select' },
  category: { label: 'category', kind: 'select' },
  aadhaar: 'Aadhaar number',
  apaarId: 'APAAR id',
  pen: 'PEN',
  srn: 'SRN',
  admissionDate: 'admission date',
  admissionType: { label: 'admission type', kind: 'select' },
  address: 'address',
  sectionId: { label: 'class and section', kind: 'select' },
  rollNumber: { label: 'roll number', kind: 'number' },
  guardians: { label: 'guardian', kind: 'list' },
  'guardians.*.firstName': 'guardian first name',
  'guardians.*.lastName': 'guardian last name',
  'guardians.*.phone': 'guardian phone number',
  'guardians.*.relation': { label: 'relation', kind: 'select' },
  'guardians.*.occupation': 'guardian occupation',
  'guardians.*.address': 'guardian address',
  'guardians.*.officeAddress': 'guardian office address',
  'guardians.*.pan': 'guardian PAN',
  'guardians.*.aadhaar': 'guardian Aadhaar number',
  consents: { label: 'consent', kind: 'list' },
  'consents.*.method': { label: 'how consent was given', kind: 'select' },
  'consents.*.evidenceReference': 'consent record',
}

/** Every problem the contract found, keyed by dotted path. */
export function validateDraft(draft: AdmitDraft): Errors {
  const parsed = StudentsAdmitRequest.safeParse(toAdmitRequest(draft))
  const errors: Errors = parsed.success ? {} : fieldErrors(parsed.error, ADMIT_LABELS)
  if (!draft.gender) errors.gender = 'Choose a gender'
  if (!draft.sectionId) errors.sectionId = 'Choose a class and section'
  return errors
}

/** The step a dotted error path belongs to, or the class step for anything unrecognised. */
export function stepOfError(path: string): number {
  const head = path.split('.')[0] ?? ''
  for (const [step, fields] of Object.entries(STEP_FIELDS)) {
    if (fields.includes(head)) return Number(step)
  }
  return CLASS_STEP
}

/** Only the problems this step can fix. */
export function errorsForStep(step: number, errors: Errors): Errors {
  return Object.fromEntries(Object.entries(errors).filter(([path]) => stepOfError(path) === step))
}
