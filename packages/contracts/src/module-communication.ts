/** Task 22 request and response contracts owned by the communication module. */
import { z } from 'zod'
import { DisplayName, Id, Reason, Timestamp, Version } from './common.ts'
import { AllowedActions, ExportJobSummary, NamedReference } from './responses.ts'

// ---------------------------------------------------------------------------
// What a message is.
//
// Decided by the product owner on 23 September 2026: announcements only, no
// replies; delivered in the app and by email (text messages wait for Task 16);
// class teachers and subject teachers both send to their own sections; the
// school sends five kinds of message by itself; attachments, scheduled sends
// and read receipts are in; languages other than English are not.

export const MessageKind = z.enum([
  'notice',
  'absence',
  'result',
  'report_card',
  'fee_reminder',
  'fee_overdue',
  'birthday_pupil',
  'birthday_staff',
])
export type MessageKind = z.infer<typeof MessageKind>
export const MESSAGE_KINDS = MessageKind.options

/** Every kind but `notice` is written and sent by the school itself. */
export const AutomaticMessageKind = MessageKind.exclude(['notice'])
export type AutomaticMessageKind = z.infer<typeof AutomaticMessageKind>
export const AUTOMATIC_MESSAGE_KINDS = AutomaticMessageKind.options

export const MESSAGE_KIND_LABELS: Readonly<Record<MessageKind, string>> = {
  notice: 'Notice',
  absence: 'Absence',
  result: 'Results',
  report_card: 'Report card',
  fee_reminder: 'Fee reminder',
  fee_overdue: 'Fee dues',
  birthday_pupil: 'Birthday',
  birthday_staff: 'Staff birthday',
}

/**
 * Who a message is for. `school` is every pupil enrolled this year, `staff`
 * every working staff member, `grade` and `section` the pupils enrolled there
 * this year, `grade_range` the pupils of every class from one class to
 * another in the school's class order (both included), `pupil` one pupil, and
 * `staff_member` one staff member (the school's birthday wishes only). For
 * every audience made of pupils, `recipients` says whether the message goes
 * to their families (the default), to the pupils themselves through their own
 * login, or to both. A teacher may send to `section` and `pupil` within their
 * own sections; the other audiences are the office's.
 */
export const MessageAudienceKind = z.enum(['school', 'staff', 'grade', 'grade_range', 'section', 'pupil', 'staff_member'])
export type MessageAudienceKind = z.infer<typeof MessageAudienceKind>

/**
 * families: the guardians, by app and email, as far as their consent allows.
 * students: the pupils themselves, in the app only, when they have a login
 * (Class 9 to 12). both: each of them.
 */
export const MessageRecipients = z.enum(['families', 'students', 'both'])
export type MessageRecipients = z.infer<typeof MessageRecipients>

/**
 * The audience a person chooses. `staff_member` is never chosen: only the
 * school uses it. `recipients` left out means families.
 */
export const MessageAudienceInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('school'), recipients: MessageRecipients.optional() }),
  z.strictObject({ kind: z.literal('staff') }),
  z.strictObject({ kind: z.literal('grade'), gradeId: Id, recipients: MessageRecipients.optional() }),
  z.strictObject({ kind: z.literal('grade_range'), fromGradeId: Id, toGradeId: Id, recipients: MessageRecipients.optional() }),
  z.strictObject({ kind: z.literal('section'), sectionId: Id, recipients: MessageRecipients.optional() }),
  z.strictObject({ kind: z.literal('pupil'), studentId: Id, recipients: MessageRecipients.optional() }),
])
export type MessageAudienceInput = z.infer<typeof MessageAudienceInput>

/**
 * The audience as a screen shows it: the ids plus a label such as "Class 5 A",
 * "Class 6 to Class 8" or "Families of Aarav Sharma". `recipients` is present
 * for every audience made of pupils. For `grade_range`, gradeId is the first
 * class and toGradeId the last.
 */
export const MessageAudienceView = z.strictObject({
  kind: MessageAudienceKind,
  label: z.string().min(1).max(200),
  recipients: MessageRecipients.optional(),
  gradeId: Id.optional(),
  toGradeId: Id.optional(),
  sectionId: Id.optional(),
  studentId: Id.optional(),
  staffId: Id.optional(),
})
export type MessageAudienceView = z.infer<typeof MessageAudienceView>

/**
 * draft: being written, seen by its author only. scheduled: waiting for its
 * time. sent: gone out, recipients recorded. withdrawn: taken back after it
 * went out, hidden from every inbox (an email already sent cannot be
 * recalled). cancelled: a scheduled message whose author could no longer send
 * it when its time came.
 */
export const MessageStatus = z.enum(['draft', 'scheduled', 'sent', 'withdrawn', 'cancelled'])
export type MessageStatus = z.infer<typeof MessageStatus>

/**
 * What happened for one recipient. delivered: in the app, by email or both.
 * no_consent: the family has not agreed to messages (the `communication`
 * consent) for any pupil through whom they are in the audience, so nothing
 * went. not_receiving: the office has marked the guardian as not receiving
 * notifications. no_contact: agreed, but no portal account and no email
 * address that can receive mail. A pupil's own row is delivered when the
 * pupil has a login that is on, and no_contact otherwise.
 */
export const RecipientOutcome = z.enum(['delivered', 'no_consent', 'not_receiving', 'no_contact'])
export type RecipientOutcome = z.infer<typeof RecipientOutcome>

/** The email's progress. pending covers a retry after a failure; failed is final. */
export const EmailStatus = z.enum(['none', 'pending', 'sent', 'failed', 'cancelled'])
export type EmailStatus = z.infer<typeof EmailStatus>

// ---------------------------------------------------------------------------
// Limits.

export const MESSAGE_TITLE_MAX = 150
export const MESSAGE_BODY_MAX = 5000
/** One attachment: PDF, JPEG or PNG, type decided by the first bytes. */
export const MESSAGE_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024
export const MESSAGE_ATTACHMENTS_MAX = 3
export const MESSAGE_ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
/** A scheduled message goes out at least this many minutes from now, and at most this many days. */
export const MESSAGE_SCHEDULE_MIN_MINUTES = 5
export const MESSAGE_SCHEDULE_MAX_DAYS = 60
/** How many times an email is tried before it is recorded as failed. */
export const MESSAGE_EMAIL_MAX_ATTEMPTS = 5

// ---------------------------------------------------------------------------
// Wording.
//
// A message's words are rendered once, when it is written, and stored on the
// message. Placeholders are words in braces. A notice to one pupil's family
// may name the pupil; a notice to a section, a grade, the school or the staff
// goes to many families at once and may name only the school. Each automatic
// kind has its own set. An unknown placeholder is refused when a template is
// saved, never left in a message.

export const MESSAGE_PLACEHOLDERS = {
  school: 'The school name',
  pupil_name: 'The pupil\'s full name',
  pupil_first_name: 'The pupil\'s first name',
  class: 'The pupil\'s class and section, such as Class 5 A',
  date: 'The day, such as 23 Sep 2026',
  exam: 'The exam, such as Half-yearly exam',
  card: 'The report card, such as Term 1 report card',
  amount: 'The amount, such as ₹12,500',
  due_date: 'The date it falls due',
  staff_name: 'The staff member\'s full name',
  staff_first_name: 'The staff member\'s first name',
} as const
export type MessagePlaceholder = keyof typeof MESSAGE_PLACEHOLDERS

const PUPIL_PLACEHOLDERS = ['school', 'pupil_name', 'pupil_first_name', 'class'] as const satisfies readonly MessagePlaceholder[]

/** The placeholders each kind may use. A notice's pupil placeholders need a `pupil` audience. */
export const PLACEHOLDERS_BY_KIND: Readonly<Record<MessageKind, readonly MessagePlaceholder[]>> = {
  notice: PUPIL_PLACEHOLDERS,
  absence: [...PUPIL_PLACEHOLDERS, 'date'],
  result: [...PUPIL_PLACEHOLDERS, 'exam'],
  report_card: [...PUPIL_PLACEHOLDERS, 'card'],
  fee_reminder: [...PUPIL_PLACEHOLDERS, 'amount', 'due_date'],
  fee_overdue: [...PUPIL_PLACEHOLDERS, 'amount'],
  birthday_pupil: PUPIL_PLACEHOLDERS,
  birthday_staff: ['school', 'staff_name', 'staff_first_name'],
}

/** The words an automatic message uses until the school saves its own. */
export const DEFAULT_MESSAGE_WORDING: Readonly<Record<AutomaticMessageKind, { readonly title: string; readonly body: string }>> = {
  absence: {
    title: '{pupil_first_name} is absent today',
    body: 'Dear parent,\n\n{pupil_name} of {class} has been marked absent today, {date}. If you did not know about this, please contact the school office.\n\n{school}',
  },
  result: {
    title: '{exam} results for {pupil_first_name}',
    body: 'Dear parent,\n\nThe {exam} results of {pupil_name}, {class}, are now published. You can see them in the app under Exams.\n\n{school}',
  },
  report_card: {
    title: '{card} for {pupil_first_name}',
    body: 'Dear parent,\n\nThe {card} of {pupil_name}, {class}, is now published. You can see it and download it in the app under Exams.\n\n{school}',
  },
  fee_reminder: {
    title: 'Fees of {amount} due on {due_date}',
    body: 'Dear parent,\n\nThis is a reminder that fees of {amount} for {pupil_name}, {class}, fall due on {due_date}. Please pay at the school office. If you have already paid, please ignore this message.\n\n{school}',
  },
  fee_overdue: {
    title: 'Fee dues of {amount} for {pupil_first_name}',
    body: 'Dear parent,\n\nFees of {amount} for {pupil_name}, {class}, are past their due date. Please pay at the school office at the earliest. If you have already paid, please ignore this message.\n\n{school}',
  },
  birthday_pupil: {
    title: 'Happy birthday, {pupil_first_name}!',
    body: 'Dear {pupil_first_name},\n\nEveryone at {school} wishes you a very happy birthday and a wonderful year ahead.\n\n{school}',
  },
  birthday_staff: {
    title: 'Happy birthday, {staff_first_name}!',
    body: 'Dear {staff_first_name},\n\nEveryone at {school} wishes you a very happy birthday. Thank you for all you do.\n\n{school}',
  },
}

const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g

/** The placeholders a text uses, in order of first appearance. */
export function placeholdersIn(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1] as string
    if (!found.includes(name)) found.push(name)
  }
  return found
}

/**
 * The placeholders a text uses that this kind may not, for this audience. An
 * empty answer means the text is fine. A notice names a pupil only when it is
 * for one pupil's family.
 */
export function unknownPlaceholders(text: string, kind: MessageKind, audience?: MessageAudienceKind): string[] {
  const allowed: readonly string[] =
    kind === 'notice' && audience !== undefined && audience !== 'pupil' ? ['school'] : PLACEHOLDERS_BY_KIND[kind]
  return placeholdersIn(text).filter((name) => !allowed.includes(name))
}

/** Fill in the placeholders. A placeholder with no value is left as written, which the save checks refuse first. */
export function renderMessageText(text: string, values: Partial<Record<MessagePlaceholder, string>>): string {
  return text.replace(PLACEHOLDER_PATTERN, (whole, name: string) => values[name as MessagePlaceholder] ?? whole)
}

// ---------------------------------------------------------------------------
// Messages.

const MessageTitle = z.string().trim().min(1).max(MESSAGE_TITLE_MAX)
const MessageBody = z.string().trim().min(1).max(MESSAGE_BODY_MAX)

export const MessageParams = z.strictObject({ schoolId: Id, messageId: Id })
export const MessageAttachmentParams = z.strictObject({ schoolId: Id, messageId: Id, attachmentId: Id })
export const InboxItemParams = z.strictObject({ schoolId: Id, recipientId: Id })

/** Start a draft. The words may use placeholders; they are rendered when the draft is saved. */
export const CreateMessageRequest = z.strictObject({
  audience: MessageAudienceInput,
  title: MessageTitle,
  body: MessageBody,
  templateId: Id.optional(),
})
export type CreateMessageRequest = z.infer<typeof CreateMessageRequest>

/** Change a draft or a scheduled message. A scheduled message changed this way stays scheduled. */
export const UpdateMessageRequest = z.strictObject({
  expectedVersion: Version,
  audience: MessageAudienceInput.optional(),
  title: MessageTitle.optional(),
  body: MessageBody.optional(),
  templateId: Id.nullable().optional(),
})
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequest>

/** Send now (no sendAt) or schedule it. */
export const SendMessageRequest = z.strictObject({
  expectedVersion: Version,
  sendAt: Timestamp.optional(),
})
export type SendMessageRequest = z.infer<typeof SendMessageRequest>

/** Take a scheduled message back to a draft. */
export const UnscheduleMessageRequest = z.strictObject({ expectedVersion: Version })
export type UnscheduleMessageRequest = z.infer<typeof UnscheduleMessageRequest>

/** Take a sent message back. The reason is the audit note, never a column. */
export const WithdrawMessageRequest = z.strictObject({ expectedVersion: Version, reason: Reason })
export type WithdrawMessageRequest = z.infer<typeof WithdrawMessageRequest>

export const DeleteMessageRequest = z.strictObject({ expectedVersion: Version })
export type DeleteMessageRequest = z.infer<typeof DeleteMessageRequest>

/** The file name travels in the query string; the body is the raw bytes. */
export const MessageAttachmentUploadQuery = z.strictObject({
  expectedVersion: z.number().int().min(1),
  fileName: z.string().trim().min(1).max(120),
})

export const MessageAttachmentView = z.strictObject({
  id: Id,
  fileName: z.string().min(1).max(120),
  contentType: z.enum(MESSAGE_ATTACHMENT_TYPES),
  sizeBytes: z.number().int().positive().max(MESSAGE_ATTACHMENT_MAX_BYTES),
})
export type MessageAttachmentView = z.infer<typeof MessageAttachmentView>

/** Who sent it: the school itself (automatic messages) or a member, by name. */
export const MessageSender = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('school'), name: DisplayName }),
  z.strictObject({ kind: z.literal('member'), membershipId: Id, name: DisplayName }),
])
export type MessageSender = z.infer<typeof MessageSender>

/**
 * The delivery figures of a sent message, over the recipient rows the caller
 * may read. Only a sender or a reader who reaches the message other than as
 * one of its recipients sees them.
 */
export const MessageCounts = z.strictObject({
  recipients: z.number().int().nonnegative(),
  /** How many of the recipients are pupils themselves rather than their families. */
  pupils: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  noConsent: z.number().int().nonnegative(),
  notReceiving: z.number().int().nonnegative(),
  noContact: z.number().int().nonnegative(),
  inApp: z.number().int().nonnegative(),
  read: z.number().int().nonnegative(),
  emailSent: z.number().int().nonnegative(),
  emailPending: z.number().int().nonnegative(),
  emailFailed: z.number().int().nonnegative(),
})
export type MessageCounts = z.infer<typeof MessageCounts>

export const MessageSummary = z.strictObject({
  id: Id,
  kind: MessageKind,
  audience: MessageAudienceView,
  /** Empty only when anonymisation blanked it. */
  title: z.string().max(MESSAGE_TITLE_MAX),
  status: MessageStatus,
  sendAt: Timestamp.optional(),
  sentAt: Timestamp.optional(),
  createdAt: Timestamp,
  sender: MessageSender,
  attachmentCount: z.number().int().nonnegative().max(MESSAGE_ATTACHMENTS_MAX),
  counts: MessageCounts.optional(),
  version: Version,
  allowedActions: AllowedActions,
})
export type MessageSummary = z.infer<typeof MessageSummary>

export const MessageListQuery = z.strictObject({
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  kind: MessageKind.optional(),
  status: MessageStatus.optional(),
  audience: MessageAudienceKind.optional(),
  /** "mine" narrows to messages the caller wrote. */
  author: z.enum(['anyone', 'mine']).default('anyone'),
  q: z.string().trim().min(1).max(100).optional(),
})
export type MessageListQuery = z.infer<typeof MessageListQuery>

export const MessageList = z.strictObject({
  items: z.array(MessageSummary).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
})
export type MessageList = z.infer<typeof MessageList>

/** The caller's own copy, when the caller is one of the recipients. */
export const MessageReceipt = z.strictObject({ recipientId: Id, readAt: Timestamp.optional() })

export const MessageDetail = MessageSummary.extend({
  body: z.string().max(MESSAGE_BODY_MAX),
  attachments: z.array(MessageAttachmentView).max(MESSAGE_ATTACHMENTS_MAX),
  templateId: Id.optional(),
  withdrawnAt: Timestamp.optional(),
  cancelReason: z.enum(['author_lost_access']).optional(),
  redacted: z.boolean(),
  myReceipt: MessageReceipt.optional(),
})
export type MessageDetail = z.infer<typeof MessageDetail>

/** One row of a message's delivery record. */
export const MessageRecipientRow = z.strictObject({
  id: Id,
  /** A pupil's own row names the pupil in `name` and in `pupil`, and never has an email. */
  kind: z.enum(['guardian', 'staff', 'student']),
  /** The guardian's, staff member's or pupil's name, or "Guardian" when the caller may not read guardian names. */
  name: DisplayName,
  relation: z.string().max(40).optional(),
  pupil: z
    .strictObject({ id: Id, name: DisplayName, section: z.string().max(80).optional() })
    .optional(),
  outcome: RecipientOutcome,
  inApp: z.boolean(),
  emailStatus: EmailStatus,
  emailMasked: z.string().max(254).optional(),
  readAt: Timestamp.optional(),
})
export type MessageRecipientRow = z.infer<typeof MessageRecipientRow>

export const MessageRecipientQuery = z.strictObject({
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
  outcome: RecipientOutcome.optional(),
  read: z.enum(['read', 'unread']).optional(),
  emailStatus: EmailStatus.optional(),
})
export type MessageRecipientQuery = z.infer<typeof MessageRecipientQuery>

export const MessageRecipientList = z.strictObject({
  items: z.array(MessageRecipientRow).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
})
export type MessageRecipientList = z.infer<typeof MessageRecipientList>

// ---------------------------------------------------------------------------
// The inbox: messages addressed to the caller.

export const InboxItem = z.strictObject({
  recipientId: Id,
  messageId: Id,
  kind: MessageKind,
  title: z.string().max(MESSAGE_TITLE_MAX),
  /** The first 160 characters of the body. */
  preview: z.string().max(160),
  sentAt: Timestamp,
  readAt: Timestamp.optional(),
  sender: MessageSender,
  pupil: NamedReference.optional(),
  attachmentCount: z.number().int().nonnegative().max(MESSAGE_ATTACHMENTS_MAX),
})
export type InboxItem = z.infer<typeof InboxItem>

export const InboxQuery = z.strictObject({
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(25),
  kind: MessageKind.optional(),
  show: z.enum(['all', 'unread']).default('all'),
})
export type InboxQuery = z.infer<typeof InboxQuery>

export const InboxList = z.strictObject({
  items: z.array(InboxItem).max(100),
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(100),
})
export type InboxList = z.infer<typeof InboxList>

export const UnreadCount = z.strictObject({ unread: z.number().int().nonnegative() })
export type UnreadCount = z.infer<typeof UnreadCount>

export const MarkReadResponse = z.strictObject({ recipientId: Id, readAt: Timestamp })
export type MarkReadResponse = z.infer<typeof MarkReadResponse>

// ---------------------------------------------------------------------------
// Choosing an audience.

/** The audiences this caller may send to right now. */
export const AudienceOptions = z.strictObject({
  school: z.boolean(),
  staff: z.boolean(),
  grades: z.array(NamedReference).max(50),
  sections: z
    .array(z.strictObject({ id: Id, name: DisplayName, grade: NamedReference, academicYearId: Id }))
    .max(300),
  /** True when the caller may pick one pupil's family (from the sections above, or any pupil for the office). */
  pupils: z.boolean(),
})
export type AudienceOptions = z.infer<typeof AudienceOptions>

export const AudiencePreviewRequest = z.strictObject({ audience: MessageAudienceInput })
export type AudiencePreviewRequest = z.infer<typeof AudiencePreviewRequest>

/** Who the message would reach if it went now, counted as the send would record it. */
export const AudiencePreview = z.strictObject({
  audience: MessageAudienceView,
  recipients: z.number().int().nonnegative(),
  /** Pupils among the recipients, and how many of them have a login to read it in the app. */
  pupils: z.number().int().nonnegative(),
  pupilsInApp: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  noConsent: z.number().int().nonnegative(),
  notReceiving: z.number().int().nonnegative(),
  noContact: z.number().int().nonnegative(),
  inApp: z.number().int().nonnegative(),
  email: z.number().int().nonnegative(),
})
export type AudiencePreview = z.infer<typeof AudiencePreview>

// ---------------------------------------------------------------------------
// Templates.

export const TemplateParams = z.strictObject({ schoolId: Id, templateId: Id })

export const MessageTemplate = z.strictObject({
  id: Id,
  kind: MessageKind,
  name: z.string().min(1).max(80),
  title: z.string().min(1).max(MESSAGE_TITLE_MAX),
  body: z.string().min(1).max(MESSAGE_BODY_MAX),
  archived: z.boolean(),
  version: Version,
  allowedActions: AllowedActions,
})
export type MessageTemplate = z.infer<typeof MessageTemplate>

export const MessageTemplateList = z.strictObject({ items: z.array(MessageTemplate).max(200) })
export type MessageTemplateList = z.infer<typeof MessageTemplateList>

export const MessageTemplateQuery = z.strictObject({
  kind: MessageKind.optional(),
  show: z.enum(['live', 'archived', 'all']).default('live'),
})
export type MessageTemplateQuery = z.infer<typeof MessageTemplateQuery>

/**
 * Save a template. For an automatic kind, saving replaces the school's live
 * wording for that kind (the previous one is archived in the same write).
 */
export const CreateMessageTemplateRequest = z.strictObject({
  kind: MessageKind,
  name: z.string().trim().min(1).max(80),
  title: MessageTitle,
  body: MessageBody,
})
export type CreateMessageTemplateRequest = z.infer<typeof CreateMessageTemplateRequest>

export const UpdateMessageTemplateRequest = z.strictObject({
  expectedVersion: Version,
  name: z.string().trim().min(1).max(80).optional(),
  title: MessageTitle.optional(),
  body: MessageBody.optional(),
})
export type UpdateMessageTemplateRequest = z.infer<typeof UpdateMessageTemplateRequest>

/** Archive a notice template, or put an automatic kind back to the built-in wording. */
export const ArchiveMessageTemplateRequest = z.strictObject({ expectedVersion: Version })
export type ArchiveMessageTemplateRequest = z.infer<typeof ArchiveMessageTemplateRequest>

// ---------------------------------------------------------------------------
// Settings for the automatic messages.

export const CommunicationSettingsValues = z.strictObject({
  absenceEnabled: z.boolean(),
  absenceDelayMinutes: z.number().int().min(0).max(240),
  resultsEnabled: z.boolean(),
  reportCardsEnabled: z.boolean(),
  feeRemindersEnabled: z.boolean(),
  feeReminderDaysBefore: z.number().int().min(1).max(30),
  /** 0 turns the overdue reminder off. */
  feeOverdueEveryDays: z.number().int().min(0).max(60),
  birthdaysPupilsEnabled: z.boolean(),
  birthdaysStaffEnabled: z.boolean(),
  /** The hour, in the school's timezone, from which birthday wishes and fee reminders go out. */
  dailySendHour: z.number().int().min(6).max(12),
})
export type CommunicationSettingsValues = z.infer<typeof CommunicationSettingsValues>

export const DEFAULT_COMMUNICATION_SETTINGS: CommunicationSettingsValues = {
  absenceEnabled: true,
  absenceDelayMinutes: 30,
  resultsEnabled: true,
  reportCardsEnabled: true,
  feeRemindersEnabled: true,
  feeReminderDaysBefore: 3,
  feeOverdueEveryDays: 7,
  birthdaysPupilsEnabled: true,
  birthdaysStaffEnabled: true,
  dailySendHour: 8,
}

/**
 * The settings and the wording in use for each automatic kind: the school's
 * live template when it has one, otherwise the built-in wording.
 */
export const CommunicationSettings = CommunicationSettingsValues.extend({
  /** 1 while the school has never saved them. */
  version: Version,
  wording: z.array(
    z.strictObject({
      kind: AutomaticMessageKind,
      title: z.string().min(1).max(MESSAGE_TITLE_MAX),
      body: z.string().min(1).max(MESSAGE_BODY_MAX),
      templateId: Id.optional(),
    }),
  ).length(AUTOMATIC_MESSAGE_KINDS.length),
  allowedActions: AllowedActions,
})
export type CommunicationSettings = z.infer<typeof CommunicationSettings>

export const UpdateCommunicationSettingsRequest = CommunicationSettingsValues.extend({ expectedVersion: Version })
export type UpdateCommunicationSettingsRequest = z.infer<typeof UpdateCommunicationSettingsRequest>

// ---------------------------------------------------------------------------
// The subject-access block: messages about one pupil.

export const SubjectMessage = z.strictObject({
  id: Id,
  kind: MessageKind,
  title: z.string().max(MESSAGE_TITLE_MAX),
  body: z.string().max(MESSAGE_BODY_MAX),
  sentAt: Timestamp,
})
export type SubjectMessage = z.infer<typeof SubjectMessage>

/** The delivery record of one message as an Excel file, through the export pipeline. */
export const MessageExportJob = ExportJobSummary
export type MessageExportJob = z.infer<typeof MessageExportJob>
