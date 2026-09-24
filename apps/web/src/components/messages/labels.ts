/**
 * Words, colours and small calculations the message screens share. Everything here is pure, so
 * it is tested on its own.
 */
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_ATTACHMENT_TYPES,
  MESSAGE_ATTACHMENTS_MAX,
  MESSAGE_KIND_LABELS,
  PLACEHOLDERS_BY_KIND,
  type MessageAudienceInput,
  type MessageAudienceView,
  type MessageRecipients,
  type MessagePlaceholder,
  type AudiencePreview,
  type EmailStatus,
  type MessageKind,
  type MessageStatus,
  type RecipientOutcome,
} from '@erp/contracts'
import type { TagColor } from '@/components/shared/tag'

export const KIND_COLOR: Readonly<Record<MessageKind, TagColor>> = {
  notice: 'blue',
  absence: 'orange',
  result: 'purple',
  report_card: 'indigo',
  fee_reminder: 'yellow',
  fee_overdue: 'red',
  birthday_pupil: 'pink',
  birthday_staff: 'pink',
}

export const STATUS_LABEL: Readonly<Record<MessageStatus, string>> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  sent: 'Sent',
  withdrawn: 'Withdrawn',
  cancelled: 'Not sent',
}

export const STATUS_COLOR: Readonly<Record<MessageStatus, TagColor>> = {
  draft: 'grey',
  scheduled: 'cyan',
  sent: 'green',
  withdrawn: 'red',
  cancelled: 'yellow',
}

export const OUTCOME_LABEL: Readonly<Record<RecipientOutcome, string>> = {
  delivered: 'Delivered',
  no_consent: 'Not agreed',
  not_receiving: 'Not receiving',
  no_contact: 'No contact',
}

export const EMAIL_LABEL: Readonly<Record<EmailStatus, string>> = {
  none: 'No email',
  pending: 'Waiting',
  sent: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const AUDIENCE_KIND_LABEL = {
  school: 'Whole school',
  staff: 'All staff',
  grade: 'A class',
  grade_range: 'A range of classes',
  section: 'A section',
  pupil: 'One pupil',
  staff_member: 'One staff member',
} as const

/** The "Send to" choice for an audience made of pupils. */
export const RECIPIENTS_LABEL: Readonly<Record<MessageRecipients, string>> = {
  families: 'Families',
  students: 'Pupils',
  both: 'Pupils and families',
}

/** Every audience made of pupils has a "Send to" choice; the staff audiences have none. */
export function hasRecipients(kind: AudienceChoice['kind'] | MessageAudienceView['kind']): boolean {
  return kind === 'school' || kind === 'grade' || kind === 'grade_range' || kind === 'section' || kind === 'pupil'
}

/**
 * The audience as a sent message shows it: "Class 9 A, pupils and families". The server already
 * writes the recipients into one pupil's label ("Aarav Sharma and family"), so that one is left as
 * it is.
 */
export function audienceLine(audience: Pick<MessageAudienceView, 'kind' | 'label' | 'recipients'>): string {
  if (!audience.recipients || audience.kind === 'pupil') return audience.label
  return `${audience.label}, ${RECIPIENTS_LABEL[audience.recipients].toLowerCase()}`
}

/** A delivery row's relation. A pupil's own row is "Pupil" even if the server left it out. */
export function recipientRelation(row: { kind: 'guardian' | 'staff' | 'student'; relation?: string }): string | undefined {
  return row.relation ?? (row.kind === 'student' ? 'Pupil' : undefined)
}

export function kindLabel(kind: MessageKind): string {
  return MESSAGE_KIND_LABELS[kind]
}

/** "1 family", "58 families". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The line under the audience picker. Staff are people, everyone else is a family or a pupil, and
 * the people who get nothing are named last so the sender sees them. A pupil reads a message only
 * in the app, so the pupils are counted apart from the families' app and email numbers.
 */
export function previewSentence(preview: Pick<AudiencePreview, 'audience' | 'recipients' | 'pupils' | 'pupilsInApp' | 'inApp' | 'email' | 'noConsent' | 'notReceiving' | 'noContact'>): string {
  const staff = preview.audience.kind === 'staff' || preview.audience.kind === 'staff_member'
  if (staff) return familySentence(`Goes to ${plural(preview.recipients, 'person', 'people')}:`, preview.inApp, preview.email, preview)
  const families = preview.recipients - preview.pupils
  if (preview.pupils === 0) return familySentence(`Goes to ${plural(families, 'family', 'families')}:`, preview.inApp, preview.email, preview)

  const pupilsWithout = preview.pupils - preview.pupilsInApp
  const reach = `${plural(preview.pupilsInApp, 'pupil has', 'pupils have')} a login and will see it in the app.`
  if (families === 0) {
    const parts = [`Goes to ${plural(preview.pupils, 'pupil', 'pupils')}: ${reach}`]
    if (pupilsWithout > 0) parts.push(`${plural(pupilsWithout, 'pupil has', 'pupils have')} no login yet.`)
    return parts.join(' ')
  }
  const parts = [`Goes to ${plural(families, 'family', 'families')} and ${plural(preview.pupils, 'pupil', 'pupils')}: ${reach}`]
  if (pupilsWithout > 0) parts.push(`${plural(pupilsWithout, 'pupil has', 'pupils have')} no login yet.`)
  parts.push(familySentence('The families:', preview.inApp - preview.pupilsInApp, preview.email, {
    ...preview,
    noContact: preview.noContact - pupilsWithout,
  }))
  return parts.join(' ')
}

function familySentence(lead: string, inApp: number, email: number, counts: Pick<AudiencePreview, 'noConsent' | 'notReceiving' | 'noContact'>): string {
  const parts = [`${lead} ${inApp} in the app, ${email} by email.`]
  if (counts.noConsent > 0) {
    parts.push(`${counts.noConsent} ${counts.noConsent === 1 ? 'has' : 'have'} not agreed to messages and will get nothing.`)
  }
  if (counts.notReceiving > 0) {
    parts.push(`${counts.notReceiving} ${counts.notReceiving === 1 ? 'is' : 'are'} marked as not receiving messages.`)
  }
  if (counts.noContact > 0) {
    parts.push(`${counts.noContact} ${counts.noContact === 1 ? 'has' : 'have'} no app login and no email address.`)
  }
  return parts.join(' ')
}

// ---------------------------------------------------------------------------
// The school's local time. Every school on the product is in India, and the school context does
// not carry a timezone, so a scheduled time is read and written as Indian Standard Time, which
// has no daylight saving.

const IST_OFFSET_MINUTES = 330

/** `2026-09-24T09:30` typed into a date and time input, as an ISO instant. Null when it is not a time. */
export function localInputToIso(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number]
  const utc = Date.UTC(y, mo - 1, d, h, mi) - IST_OFFSET_MINUTES * 60_000
  const date = new Date(utc)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** The other way: an ISO instant as the value a date and time input shows in the school's time. */
export function isoToLocalInput(iso: string): string {
  const date = new Date(new Date(iso).getTime() + IST_OFFSET_MINUTES * 60_000)
  return date.toISOString().slice(0, 16)
}

/** "24 Sep 2026, 9:30 am" in the school's time. */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** "2 MB", "340 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Why a picked file cannot be attached, or null when it can. The server checks again by its bytes. */
export function attachmentProblem(file: { type: string; size: number }, alreadyAttached: number): string | null {
  if (alreadyAttached >= MESSAGE_ATTACHMENTS_MAX) return 'A message can carry at most three files.'
  if (!(MESSAGE_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return 'Only PDF, JPEG or PNG files can be attached.'
  if (file.size > MESSAGE_ATTACHMENT_MAX_BYTES) return 'A file can be at most 2 MB.'
  return null
}

/** What the audience picker holds while a person is choosing. */
export interface AudienceChoice {
  kind: 'school' | 'staff' | 'grade' | 'grade_range' | 'section' | 'pupil' | null
  gradeId: string
  /** The first and last class of a range. */
  fromGradeId: string
  toGradeId: string
  sectionId: string
  studentId: string
  recipients: MessageRecipients
}

/**
 * The audience to send, or null while the choice is not finished (a class picked with no class,
 * a range with one end missing). The recipients go with every audience made of pupils.
 */
export function audienceInputOf(choice: AudienceChoice): MessageAudienceInput | null {
  const recipients = { recipients: choice.recipients }
  switch (choice.kind) {
    case 'staff':
      return { kind: 'staff' }
    case 'school':
      return { kind: 'school', ...recipients }
    case 'grade':
      return choice.gradeId ? { kind: 'grade', gradeId: choice.gradeId, ...recipients } : null
    case 'grade_range':
      return choice.fromGradeId && choice.toGradeId
        ? { kind: 'grade_range', fromGradeId: choice.fromGradeId, toGradeId: choice.toGradeId, ...recipients }
        : null
    case 'section':
      return choice.sectionId ? { kind: 'section', sectionId: choice.sectionId, ...recipients } : null
    case 'pupil':
      return choice.studentId ? { kind: 'pupil', studentId: choice.studentId, ...recipients } : null
    default:
      return null
  }
}

/**
 * Whether the range runs forwards in the school's class order (the order the audiences response
 * lists the classes in). The server refuses a range whose first class comes after its last.
 */
export function rangeInOrder(grades: ReadonlyArray<{ id: string }>, fromGradeId: string, toGradeId: string): boolean {
  const from = grades.findIndex((grade) => grade.id === fromGradeId)
  const to = grades.findIndex((grade) => grade.id === toGradeId)
  return from !== -1 && to !== -1 && from <= to
}

/** The placeholders a notice to this audience may use: the pupil's only for one pupil's family. */
export function noticePlaceholders(kind: AudienceChoice['kind']): readonly MessagePlaceholder[] {
  return kind === 'pupil' ? PLACEHOLDERS_BY_KIND.notice : ['school']
}
