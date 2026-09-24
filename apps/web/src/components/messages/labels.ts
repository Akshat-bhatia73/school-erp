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
  school: 'Whole school families',
  staff: 'All staff',
  grade: 'A class',
  section: 'A section',
  pupil: "One pupil's family",
  staff_member: 'One staff member',
} as const

export function kindLabel(kind: MessageKind): string {
  return MESSAGE_KIND_LABELS[kind]
}

/** "1 family", "58 families". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The line under the audience picker. Staff are people, everyone else is a family, and the
 * people who get nothing are named last so the sender sees them.
 */
export function previewSentence(preview: Pick<AudiencePreview, 'audience' | 'recipients' | 'inApp' | 'email' | 'noConsent' | 'notReceiving' | 'noContact'>): string {
  const staff = preview.audience.kind === 'staff' || preview.audience.kind === 'staff_member'
  const who = staff ? plural(preview.recipients, 'person', 'people') : plural(preview.recipients, 'family', 'families')
  const parts = [`Goes to ${who}: ${preview.inApp} in the app, ${preview.email} by email.`]
  if (preview.noConsent > 0) {
    parts.push(`${preview.noConsent} ${preview.noConsent === 1 ? 'has' : 'have'} not agreed to messages and will get nothing.`)
  }
  if (preview.notReceiving > 0) {
    parts.push(`${preview.notReceiving} ${preview.notReceiving === 1 ? 'is' : 'are'} marked as not receiving messages.`)
  }
  if (preview.noContact > 0) {
    parts.push(`${preview.noContact} ${preview.noContact === 1 ? 'has' : 'have'} no app login and no email address.`)
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
  kind: 'school' | 'staff' | 'grade' | 'section' | 'pupil' | null
  gradeId: string
  sectionId: string
  studentId: string
}

/** The audience to send, or null while the choice is not finished (a class picked with no class). */
export function audienceInputOf(choice: AudienceChoice): MessageAudienceInput | null {
  switch (choice.kind) {
    case 'school':
    case 'staff':
      return { kind: choice.kind }
    case 'grade':
      return choice.gradeId ? { kind: 'grade', gradeId: choice.gradeId } : null
    case 'section':
      return choice.sectionId ? { kind: 'section', sectionId: choice.sectionId } : null
    case 'pupil':
      return choice.studentId ? { kind: 'pupil', studentId: choice.studentId } : null
    default:
      return null
  }
}

/** The placeholders a notice to this audience may use: the pupil's only for one pupil's family. */
export function noticePlaceholders(kind: AudienceChoice['kind']): readonly MessagePlaceholder[] {
  return kind === 'pupil' ? PLACEHOLDERS_BY_KIND.notice : ['school']
}
