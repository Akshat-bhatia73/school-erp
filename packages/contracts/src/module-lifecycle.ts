/** Task 12 contracts: guardian consent, APAAR reveal, anonymisation and audit notes. */
import { z } from 'zod'
import { AllowedActions } from './responses.ts'
import { DisplayName, Id, Reason, Timestamp, Version } from './common.ts'

/** The purposes a school may ask a guardian to consent to. */
export const CONSENT_PURPOSES = [
  'education_records',
  'health_information',
  'photographs',
  'communication',
  'third_party_services',
] as const

export const ConsentPurpose = z.enum(CONSENT_PURPOSES)
export const ConsentStatus = z.enum(['given', 'withdrawn'])
export const ConsentMethod = z.enum(['in_person', 'signed_form', 'portal'])

/**
 * One consent event. Every row is an event; the current state of a purpose is
 * the newest row for that guardian and purpose, which is all a list returns.
 */
export const ConsentRecord = z.strictObject({
  id: Id,
  studentId: Id,
  guardianId: Id,
  guardianDisplayName: DisplayName,
  purpose: ConsentPurpose,
  status: ConsentStatus,
  method: ConsentMethod,
  evidenceReference: z.string().max(200).optional(),
  recordedAt: Timestamp,
  recordedBy: z.enum(['office', 'guardian']),
})

export const ConsentList = z.strictObject({
  items: z.array(ConsentRecord).max(100),
  allowedActions: AllowedActions,
})

export const RecordConsentRequest = z.strictObject({
  guardianId: Id,
  purpose: ConsentPurpose,
  status: ConsentStatus,
  method: ConsentMethod,
  evidenceReference: z.string().trim().max(200).optional(),
})

/**
 * Consent captured during admission, before the guardians have ids: the index
 * points into the request's own `guardians` array and the API refuses a value
 * outside its range.
 */
export const AdmitConsent = z.strictObject({
  guardianIndex: z.number().int().nonnegative(),
  purpose: ConsentPurpose,
  method: ConsentMethod,
  evidenceReference: z.string().trim().max(200).optional(),
})

/** The full APAAR id, returned only by the audited reveal route. */
export const StudentApaarReveal = z.strictObject({
  apaarId: z.string().min(4).max(100),
})

/** Anonymisation and guardian unlink are version-checked writes with a stated reason. */
export const AnonymiseRequest = z.strictObject({ expectedVersion: Version, reason: Reason })

/** `expectedVersion` is the student's version, because the link belongs to the student. */
export const UnlinkGuardianRequest = z.strictObject({ expectedVersion: Version, reason: Reason })

/** Redaction removes the note text; the audit event itself always stays. */
export const RedactAuditNoteRequest = z.strictObject({ reason: Reason })

/**
 * The retention schedule, in one place, so the API, the sweep and the screens
 * quote the same numbers. Anonymisation is still a decision by the school:
 * these are the earliest moments it may be taken, not an automatic deletion.
 */
export const RETENTION = {
  studentSensitiveYears: 3,
  staffPrivateYears: 8,
  credentialGraceDays: 30,
  invitationDays: 90,
  outboxDays: 90,
  importPreviewHours: 24,
} as const

export type ConsentPurpose = z.infer<typeof ConsentPurpose>
export type ConsentStatus = z.infer<typeof ConsentStatus>
export type ConsentMethod = z.infer<typeof ConsentMethod>
export type ConsentRecord = z.infer<typeof ConsentRecord>
export type ConsentList = z.infer<typeof ConsentList>
export type RecordConsentRequest = z.infer<typeof RecordConsentRequest>
export type AdmitConsent = z.infer<typeof AdmitConsent>
export type StudentApaarReveal = z.infer<typeof StudentApaarReveal>
export type AnonymiseRequest = z.infer<typeof AnonymiseRequest>
export type UnlinkGuardianRequest = z.infer<typeof UnlinkGuardianRequest>
export type RedactAuditNoteRequest = z.infer<typeof RedactAuditNoteRequest>
