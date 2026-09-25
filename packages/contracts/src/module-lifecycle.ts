/** Task 12 contracts: guardian consent, APAAR reveal, anonymisation and audit notes. */
import { z } from 'zod'
import {
  AllowedActions, DocumentSummary, EnrollmentSummary, GuardianPrivate,
  StudentBasic, StudentMedical, StudentSensitive,
} from './responses.ts'
import { DisplayName, Id, Phone, Reason, Timestamp, Version } from './common.ts'
import { FeeStatement } from './module-fees.ts'
import { AttendanceYearRecord } from './module-attendance.ts'
import { ExamResultsResponse } from './module-exams.ts'
import { ReportCardView } from './module-report-cards.ts'
import { SubjectMessage } from './module-communication.ts'

/** The purposes a school may ask a guardian to consent to. */
export const CONSENT_PURPOSES = [
  'education_records',
  'health_information',
  'photographs',
  'communication',
  'third_party_services',
  // A pupil uses the assistant only after a guardian agrees (Task 24).
  'ai_assistant',
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

/** The whole Aadhaar number, returned only by the audited reveal route. */
export const StudentAadhaarReveal = z.strictObject({
  aadhaar: z.string().regex(/^\d{12}$/),
})

/**
 * A guardian's own identity numbers, whole, from the audited reveal route.
 * A number the record does not carry is left out rather than sent as empty.
 */
export const GuardianIdentityReveal = z.strictObject({
  pan: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/).optional(),
  aadhaar: z.string().regex(/^\d{12}$/).optional(),
})

/** Anonymisation and guardian unlink are version-checked writes with a stated reason. */
export const AnonymiseRequest = z.strictObject({ expectedVersion: Version, reason: Reason })

/** `expectedVersion` is the student's version, because the link belongs to the student. */
export const UnlinkGuardianRequest = z.strictObject({ expectedVersion: Version, reason: Reason })

/** Redaction removes the note text; the audit event itself always stays. */
export const RedactAuditNoteRequest = z.strictObject({ reason: Reason })

/**
 * The sensitive block of a subject access export. It is the ordinary sensitive
 * block with the full APAAR id and the full Aadhaar number in place of their
 * masks: answering a subject access request means handing the person what we
 * actually hold about them.
 */
export const SubjectSensitive = StudentSensitive.omit({
  apaarMasked: true,
  aadhaarLast4: true,
}).extend({
  apaarId: z.string().min(4).max(100).optional(),
  aadhaar: z.string().regex(/^\d{12}$/).optional(),
})

/**
 * One earlier read or refusal of this student's record, from the audit trail.
 * Present only when the caller may read the audit log.
 */
export const SubjectAccessEvent = z.strictObject({
  at: Timestamp,
  action: z.string().min(1).max(100),
  actorDisplayName: DisplayName,
  outcome: z.enum(['allowed', 'denied']),
})

/**
 * One of the pupil's own conversations with the assistant (Task 24), in plain
 * words: what the pupil asked and what the assistant answered. The records the
 * answers drew on are in the export's own blocks, so tool results are left out.
 */
export const SubjectAssistantConversation = z.strictObject({
  id: Id,
  title: z.string().min(1).max(120),
  createdAt: Timestamp,
  messages: z.array(z.strictObject({
    role: z.enum(['user', 'assistant']),
    text: z.string().min(1).max(40000),
    createdAt: Timestamp,
  })).max(400),
})

/**
 * Everything the system holds about one student, in one audited document.
 * A block is present only when the caller holds the read permission for it on
 * this student, so the export says exactly what they could already read one
 * screen at a time. An anonymised student exports the register fields only.
 */
/**
 * A guardian as a subject access answer names them. Every linked guardian
 * belongs in their child's record, so the telephone number is optional here:
 * a blank or unusable number leaves the field out, never the person. The
 * private fields are still only sent when the caller may read them.
 */
export const SubjectGuardian = GuardianPrivate.extend({
  phone: Phone.optional(),
  relation: z.enum(['father', 'mother', 'guardian', 'grandparent', 'sibling', 'other']),
})

export const SubjectAccessExport = z.strictObject({
  generatedAt: Timestamp,
  schoolId: Id,
  student: StudentBasic,
  sensitive: SubjectSensitive.optional(),
  medical: StudentMedical.optional(),
  guardians: z.array(SubjectGuardian).max(20),
  enrollments: z.array(EnrollmentSummary).max(50),
  documents: z.array(DocumentSummary).max(100),
  consents: z.array(ConsentRecord).max(100),
  /** One statement per academic year that holds fee data; needs `fees.read` on this pupil. */
  fees: z.array(FeeStatement).max(30).optional(),
  /** One record per academic year with a mark; needs `attendance.read` on this pupil. */
  attendance: z.array(AttendanceYearRecord).max(30).optional(),
  /**
   * One answer per academic year the pupil has a mark in, exactly as the
   * results screen gives it to this caller: published marks only for a
   * parent. Needs `exams.read` on this pupil.
   */
  exams: z.array(ExamResultsResponse).max(30).optional(),
  /** Every published report card version, newest first; needs `report_cards.read` on this pupil. */
  reportCards: z.array(ReportCardView).max(120).optional(),
  /**
   * Messages about this pupil (absence, results, fees, birthdays and notices
   * to the pupil's family), newest first, as far as the caller may read them;
   * needs `communication.read`.
   */
  messages: z.array(SubjectMessage).max(500).optional(),
  accessHistory: z.array(SubjectAccessEvent).max(200).optional(),
  /**
   * The pupil's own conversations with the assistant, kept 30 days. Present
   * when the pupil has, or had, a login of their own.
   */
  assistantConversations: z.array(SubjectAssistantConversation).max(500).optional(),
})

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
  /** A message and its delivery record, after it went out; see sweep_messages () in migration 0018. */
  messageYears: 2,
  /** A draft nobody has touched. */
  messageDraftDays: 365,
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
export type StudentAadhaarReveal = z.infer<typeof StudentAadhaarReveal>
export type GuardianIdentityReveal = z.infer<typeof GuardianIdentityReveal>
export type AnonymiseRequest = z.infer<typeof AnonymiseRequest>
export type UnlinkGuardianRequest = z.infer<typeof UnlinkGuardianRequest>
export type SubjectSensitive = z.infer<typeof SubjectSensitive>
export type SubjectAccessEvent = z.infer<typeof SubjectAccessEvent>
export type SubjectGuardian = z.infer<typeof SubjectGuardian>
export type SubjectAccessExport = z.infer<typeof SubjectAccessExport>
export type SubjectAssistantConversation = z.infer<typeof SubjectAssistantConversation>
export type RedactAuditNoteRequest = z.infer<typeof RedactAuditNoteRequest>
