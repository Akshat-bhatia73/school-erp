import { StudentInput, type AdmissionType, type BloodGroup, type Gender, type GuardianRelation, type SocialCategory, type StudentInput as StudentInputType } from '@erp/shared'
import type { Errors } from './fields'

export interface GuardianDraft {
  relation: GuardianRelation
  firstName: string
  lastName: string
  phone: string
  email: string
  occupation: string
  /** Reuse the student's home address (entered in step 3) for this guardian */
  sameAddress: boolean
}

export interface AdmitDraft {
  firstName: string
  lastName: string
  dateOfBirth: string
  gender: Gender | ''
  bloodGroup: BloodGroup
  category: SocialCategory
  religion: string
  motherTongue: string
  aadhaarLast4: string
  photoUrl: string
  guardians: GuardianDraft[]
  primaryIndex: number
  gradeId: string
  sectionId: string
  rollNumber: string
  admissionNumber: string
  admissionDate: string
  admissionType: AdmissionType
  previousSchool: string
  usesTransport: boolean
  medicalNotes: string
  address: { line1: string; line2: string; city: string; state: string; pincode: string }
}

export const todayIso = () => new Date().toISOString().slice(0, 10)

export function emptyGuardian(relation: GuardianRelation = 'father'): GuardianDraft {
  return { relation, firstName: '', lastName: '', phone: '', email: '', occupation: '', sameAddress: true }
}

export function emptyDraft(): AdmitDraft {
  return {
    firstName: '', lastName: '', dateOfBirth: '', gender: '', bloodGroup: 'unknown', category: 'general',
    religion: '', motherTongue: '', aadhaarLast4: '', photoUrl: '',
    guardians: [emptyGuardian('father')], primaryIndex: 0,
    gradeId: '', sectionId: '', rollNumber: '', admissionNumber: '', admissionDate: todayIso(),
    admissionType: 'regular', previousSchool: '', usesTransport: false, medicalNotes: '',
    address: { line1: '', line2: '', city: '', state: '', pincode: '' },
  }
}

const clean = (s: string) => (s.trim() ? s.trim() : undefined)

/** Shape the draft into the API input the mock expects */
export function toStudentInput(d: AdmitDraft): StudentInputType {
  return {
    firstName: d.firstName.trim(),
    lastName: clean(d.lastName),
    dateOfBirth: d.dateOfBirth,
    gender: (d.gender || 'male') as Gender,
    bloodGroup: d.bloodGroup,
    category: d.category,
    religion: clean(d.religion),
    motherTongue: clean(d.motherTongue),
    nationality: 'Indian',
    aadhaarLast4: clean(d.aadhaarLast4),
    photoUrl: clean(d.photoUrl),
    admissionNumber: d.admissionNumber.trim(),
    admissionDate: d.admissionDate,
    admissionType: d.admissionType,
    previousSchool: clean(d.previousSchool),
    status: 'active',
    medicalNotes: clean(d.medicalNotes),
    usesTransport: d.usesTransport,
    address: {
      line1: d.address.line1.trim(),
      line2: clean(d.address.line2),
      city: d.address.city.trim(),
      state: d.address.state.trim(),
      pincode: d.address.pincode.trim(),
    },
    sectionId: d.sectionId,
    rollNumber: d.rollNumber ? Number(d.rollNumber) : undefined,
    guardians: d.guardians.map((g, i) => ({
      relation: g.relation,
      isPrimary: i === d.primaryIndex,
      guardian: {
        firstName: g.firstName.trim(),
        lastName: clean(g.lastName),
        phone: g.phone.trim(),
        email: clean(g.email),
        occupation: clean(g.occupation),
        address: g.sameAddress && d.address.line1.trim() && /^\d{6}$/.test(d.address.pincode.trim())
          ? { line1: d.address.line1.trim(), line2: clean(d.address.line2), city: d.address.city.trim(), state: d.address.state.trim(), pincode: d.address.pincode.trim() }
          : undefined,
      },
    })),
  } as StudentInputType
}

const STEP_KEYS: Record<number, Array<keyof StudentInputType>> = {
  0: ['firstName', 'lastName', 'dateOfBirth', 'gender', 'bloodGroup', 'category', 'aadhaarLast4', 'photoUrl'],
  1: ['guardians'],
  2: ['sectionId', 'rollNumber', 'admissionNumber', 'admissionDate', 'admissionType', 'address'],
}

/** Validate one step with the matching subset of the StudentInput schema. Returns field -> message. */
export function validateStep(step: number, d: AdmitDraft): Errors {
  const keys = STEP_KEYS[step]
  if (!keys) return {}
  const shape = Object.fromEntries(keys.map((k) => [k, true])) as Record<string, true>
  const schema = StudentInput.pick(shape as never)
  const input = toStudentInput(d) as Record<string, unknown>
  const subset = Object.fromEntries(keys.map((k) => [k, input[k as string]]))
  const parsed = schema.safeParse(subset)
  const errors: Errors = {}
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.')
      if (!errors[path]) errors[path] = issue.message
    }
  }
  if (step === 0 && !d.gender) errors.gender = 'Pick a gender'
  if (step === 2 && !d.sectionId) errors.sectionId = 'Pick a class and section'
  return errors
}

/** "SVM/2026/014" */
export function suggestAdmissionNumber(shortName: string, seq: number) {
  return `${shortName.toUpperCase()}/${new Date().getFullYear()}/${String(seq).padStart(3, '0')}`
}
