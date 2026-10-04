/**
 * Task 25 request and response contracts owned by the homework module
 * (migration 0030). Decided by the product owner on 4 October 2026.
 *
 * A homework item belongs to one section in one academic year: a title, the
 * instructions, the day it was set (today in the school's timezone, set by
 * the server) and the day it is due (on or after that, within
 * HOMEWORK_DUE_MAX_DAYS). It has a subject, or none: general homework, which
 * only the class teacher (or the office) sets. Editing changes the words, the
 * due date and the files, never the section or the subject. Removing hides it
 * from families and drops it from figures, and keeps it and its check-offs.
 *
 * From the due date the teacher checks each pupil on the roster (the pupils
 * enrolled in the section on the due date) off as done, partly done or not
 * done, with an optional remark. A teacher may change check-offs until
 * HOMEWORK_TEACHER_CHECK_DAYS after the due date, the office at any time. A
 * pupil with no check-off after the due date is "Not checked", never "Not
 * done". Families read their own child's items and the child's own status,
 * for every year the child was at the school.
 *
 * Keys: homework.read, homework.set, homework.check (also gates the report),
 * homework.export (the Excel report, job kind `homework_report`).
 */
import { z } from 'zod'
import { CalendarDate, DisplayName, Id, Timestamp, Version } from './common.ts'
import { ErrorReason } from './errors.ts'
import { AllowedActions, ExportJobSummary, NamedReference } from './responses.ts'

// ---------------------------------------------------------------------------
// Limits.

export const HOMEWORK_TITLE_MAX = 120
export const HOMEWORK_INSTRUCTIONS_MAX = 4000
/** The due date is at most this many days after the day the item is set. */
export const HOMEWORK_DUE_MAX_DAYS = 60
/** A teacher may change check-offs until this many days after the due date (school timezone). */
export const HOMEWORK_TEACHER_CHECK_DAYS = 14
export const HOMEWORK_REMARK_MAX = 200
/** Files per item. */
export const HOMEWORK_ATTACHMENTS_MAX = 3
/** One file: PDF, JPEG or PNG, type decided by the first bytes. The Vercel request limit is 4.5 MB. */
export const HOMEWORK_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024
export const HOMEWORK_ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const
/** The most items one list answers with. */
export const HOMEWORK_LIST_MAX = 500
/** The longest date range one report covers, in days including both ends. */
export const HOMEWORK_REPORT_MAX_DAYS = 366
/** A pupil with at least this many Not done in the report's range is listed. */
export const HOMEWORK_NOT_DONE_THRESHOLD = 3
/** The most pupils one roster (check-off sheet) holds. */
export const HOMEWORK_ROSTER_MAX = 200
/** The digest goes from the school's time on the day until this hour the next morning, then is skipped. */
export const HOMEWORK_DIGEST_LAST_HOUR = 9
export const HOMEWORK_DIGEST_DEFAULT_TIME = '17:00'
/**
 * The most items one pupil's digest lists, soonest due first; any more are one
 * closing line ("and N more, see Homework in the app"). Nothing caps the items
 * a class gets in a day, and a message body is at most MESSAGE_BODY_MAX
 * (5000) characters, so the list has a budget of its own.
 */
export const HOMEWORK_DIGEST_MAX_ITEMS = 12
/** A title in the digest list is cut to this many characters, with an ellipsis. */
export const HOMEWORK_DIGEST_TITLE_MAX = 80

/** One item as the digest lists it. `subject` is the subject's name, or the word for general homework. */
export interface HomeworkDigestEntry {
  subject: string
  title: string
  /** ISO date, for the order. */
  dueOn: string
  /** The due date as the message shows it (formatDate). */
  dueLabel: string
}

/**
 * The `{homework_list}` placeholder of the digest: one line per item, soonest
 * due first (then subject, then title), at most HOMEWORK_DIGEST_MAX_ITEMS
 * lines with titles cut to HOMEWORK_DIGEST_TITLE_MAX, and a closing line for
 * the rest. At most about 12 x 200 characters, far inside a message body; the
 * writer still clamps the rendered body to MESSAGE_BODY_MAX because a school's
 * own wording may be long.
 */
export function homeworkDigestList(entries: readonly HomeworkDigestEntry[]): string {
  const ordered = [...entries].sort(
    (a, b) =>
      a.dueOn.localeCompare(b.dueOn) || a.subject.localeCompare(b.subject) || a.title.localeCompare(b.title),
  )
  const shown = ordered.slice(0, HOMEWORK_DIGEST_MAX_ITEMS).map((entry) => {
    const title =
      entry.title.length > HOMEWORK_DIGEST_TITLE_MAX
        ? `${entry.title.slice(0, HOMEWORK_DIGEST_TITLE_MAX - 1).trimEnd()}…`
        : entry.title
    return `- ${entry.subject}: ${title} (due ${entry.dueLabel})`
  })
  const rest = ordered.length - shown.length
  if (rest > 0) shown.push(`- and ${rest} more, see Homework in the app`)
  return shown.join('\n')
}

/** 'HH:MM', 12:00 to 21:00: when the evening digest starts to go, in the school's timezone. */
export const HomeworkDigestTime = z
  .string()
  .regex(/^(?:1[2-9]|20):[0-5]\d$|^21:00$/, 'Choose a time from 12:00 to 21:00')
export type HomeworkDigestTime = z.infer<typeof HomeworkDigestTime>

// ---------------------------------------------------------------------------
// Statuses.

/** What the teacher marked. The only status there is; families cannot tick anything. */
export const HomeworkCheckStatus = z.enum(['done', 'partly_done', 'not_done'])
export type HomeworkCheckStatus = z.infer<typeof HomeworkCheckStatus>
export const HOMEWORK_CHECK_STATUSES = HomeworkCheckStatus.options

/**
 * One pupil's status on one item as a screen shows it: a check-off, or
 * `not_checked` (due date reached, nobody checked the pupil), or `not_due`
 * (before the due date, nothing to check yet).
 */
export const HomeworkPupilStatus = z.enum(['done', 'partly_done', 'not_done', 'not_checked', 'not_due'])
export type HomeworkPupilStatus = z.infer<typeof HomeworkPupilStatus>

export const HOMEWORK_PUPIL_STATUS_LABELS: Readonly<Record<HomeworkPupilStatus, string>> = {
  done: 'Done',
  partly_done: 'Partly done',
  not_done: 'Not done',
  not_checked: 'Not checked',
  not_due: 'Not due yet',
}

/**
 * The list's status filter. `upcoming`: due today or later. `past`: due
 * before today. `to_check`: due on or before today with a pupil on the roster
 * not checked (staff only). `removed`: removed items (staff only; families
 * never see them).
 */
export const HomeworkListStatus = z.enum(['upcoming', 'past', 'to_check', 'removed'])
export type HomeworkListStatus = z.infer<typeof HomeworkListStatus>

// ---------------------------------------------------------------------------
// Shared parts.

const HomeworkTitle = z.string().trim().min(1).max(HOMEWORK_TITLE_MAX)
const HomeworkInstructions = z.string().trim().max(HOMEWORK_INSTRUCTIONS_MAX)
const HomeworkRemark = z.string().trim().min(1).max(HOMEWORK_REMARK_MAX)
/** Query-string boolean, as elsewhere. */
const QueryFlag = z.enum(['true', 'false'])

const dayCount = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1

export const HomeworkParams = z.strictObject({ schoolId: Id, homeworkId: Id })
export type HomeworkParams = z.infer<typeof HomeworkParams>
export const HomeworkAttachmentParams = z.strictObject({ schoolId: Id, homeworkId: Id, attachmentId: Id })
export type HomeworkAttachmentParams = z.infer<typeof HomeworkAttachmentParams>

/** A pupil as a roster names them. */
export const HomeworkPupil = z.strictObject({
  id: Id,
  name: DisplayName,
  admissionNumber: z.string().min(1).max(100),
  rollNumber: z.number().int().positive().optional(),
})
export type HomeworkPupil = z.infer<typeof HomeworkPupil>

export const HomeworkAttachmentView = z.strictObject({
  id: Id,
  fileName: z.string().min(1).max(120),
  contentType: z.enum(HOMEWORK_ATTACHMENT_TYPES),
  sizeBytes: z.number().int().positive().max(HOMEWORK_ATTACHMENT_MAX_BYTES),
})
export type HomeworkAttachmentView = z.infer<typeof HomeworkAttachmentView>

/** Staff figures for one item over its roster (the pupils enrolled in the section on the due date). */
export const HomeworkProgress = z.strictObject({
  /** Pupils on the roster: enrolled in the section on the due date. */
  pupils: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  partlyDone: z.number().int().nonnegative(),
  notDone: z.number().int().nonnegative(),
  /** Pupils on the roster with no check-off. */
  notChecked: z.number().int().nonnegative(),
})
export type HomeworkProgress = z.infer<typeof HomeworkProgress>

/** One child's status on an item, for a family (and for staff reading one pupil). */
export const HomeworkChildStatus = z.strictObject({
  student: NamedReference,
  status: HomeworkPupilStatus,
  remark: HomeworkRemark.optional(),
  checkedAt: Timestamp.optional(),
})
export type HomeworkChildStatus = z.infer<typeof HomeworkChildStatus>

/**
 * When check-offs may be saved on this item by this caller, worked out once
 * so the screen and the write agree. `state`: before the due date, from the
 * due date to the end of the teacher's window, and after it. `check` says
 * whether this caller may save now (the office: from the due date, at any
 * time after); `checkBlockedBy` why not, when the caller holds the key.
 */
export const HomeworkCheckWindow = z.strictObject({
  state: z.enum(['not_due', 'open', 'closed']),
  /** The last day a teacher may change check-offs. */
  teacherClosesOn: CalendarDate,
  check: z.boolean(),
  checkBlockedBy: ErrorReason.optional(),
})
export type HomeworkCheckWindow = z.infer<typeof HomeworkCheckWindow>

const HomeworkCommon = {
  id: Id,
  version: Version,
  academicYear: NamedReference,
  section: NamedReference,
  grade: NamedReference,
  /** Absent for general homework. */
  subject: NamedReference.optional(),
  title: HomeworkTitle,
  setOn: CalendarDate,
  dueOn: CalendarDate,
  /** Who set it, by name, when the author's name can be read. */
  setBy: DisplayName.optional(),
  attachmentCount: z.number().int().nonnegative().max(HOMEWORK_ATTACHMENTS_MAX),
  /** Staff only: set when the item was removed. Families never receive a removed item. */
  removedAt: Timestamp.optional(),
  /** Staff only (homework.check or homework.read at a staff scope). */
  progress: HomeworkProgress.optional(),
  /** Family only: the caller's child (or, for a pupil, themself) on this item. */
  child: HomeworkChildStatus.optional(),
  /** homework.set (edit, remove, files) and homework.check on this item. */
  allowedActions: AllowedActions,
}

// ---------------------------------------------------------------------------
// List.

/**
 * The items the caller may read, soonest due first for `upcoming`, newest
 * due first otherwise. `general=true` narrows to items with no subject.
 * `studentId` narrows to the items of one pupil (a parent choosing a child;
 * staff reading one pupil): the items of the sections the pupil was enrolled
 * in on the day each was set. from/to bound the due date. Without academicYearId every year the
 * caller may read is listed (a family reads past years too).
 */
export const HomeworkListRequest = z
  .strictObject({
    academicYearId: Id.optional(),
    sectionId: Id.optional(),
    subjectId: Id.optional(),
    general: QueryFlag.optional(),
    studentId: Id.optional(),
    status: HomeworkListStatus.optional(),
    from: CalendarDate.optional(),
    to: CalendarDate.optional(),
  })
  .refine((value) => !(value.subjectId !== undefined && value.general === 'true'), {
    message: 'Choose a subject or general homework, not both',
    path: ['general'],
  })
  .refine((value) => value.from === undefined || value.to === undefined || value.to >= value.from, {
    message: 'The end of the range is before its start',
    path: ['to'],
  })
export type HomeworkListRequest = z.infer<typeof HomeworkListRequest>

/**
 * One item in the list. A family receives one entry per child and item, so
 * two children in the same section see the item twice, each with its own
 * `child`.
 */
export const HomeworkListItem = z.strictObject(HomeworkCommon)
export type HomeworkListItem = z.infer<typeof HomeworkListItem>

export const HomeworkListResponse = z.strictObject({
  /** Today in the school's timezone. */
  today: CalendarDate,
  items: z.array(HomeworkListItem).max(HOMEWORK_LIST_MAX),
  /** True when more items matched than HOMEWORK_LIST_MAX. */
  truncated: z.boolean(),
  /** homework.set when the caller may set homework somewhere; homework.check / homework.export for the report. */
  allowedActions: AllowedActions,
})
export type HomeworkListResponse = z.infer<typeof HomeworkListResponse>

// ---------------------------------------------------------------------------
// Detail.

export const HomeworkDetail = z.strictObject({
  ...HomeworkCommon,
  instructions: HomeworkInstructions,
  attachments: z.array(HomeworkAttachmentView).max(HOMEWORK_ATTACHMENTS_MAX),
  updatedAt: Timestamp,
  /** Staff only: who last changed the words, the date or the files. */
  updatedBy: DisplayName.optional(),
  /** Staff only. */
  removedBy: DisplayName.optional(),
  /** Staff with homework.check on this item. */
  checkWindow: HomeworkCheckWindow.optional(),
  /** Family only: every child of the caller this item is for. */
  children: z.array(HomeworkChildStatus).max(20).optional(),
})
export type HomeworkDetail = z.infer<typeof HomeworkDetail>

// ---------------------------------------------------------------------------
// Set, edit, remove.

/**
 * Set an item. `subjectId` null or left out is general homework (the class
 * teacher's, or the office's). The subject must be one of the section's class
 * subjects that year. The server sets `setOn` to today in the school's
 * timezone; `dueOn` is on or after it and within HOMEWORK_DUE_MAX_DAYS. Files
 * are uploaded after, one request each.
 */
export const HomeworkCreateRequest = z.strictObject({
  sectionId: Id,
  subjectId: Id.nullable().optional(),
  title: HomeworkTitle,
  /** Left out is no instructions: the title says it all. */
  instructions: HomeworkInstructions.optional(),
  dueOn: CalendarDate,
})
export type HomeworkCreateRequest = z.infer<typeof HomeworkCreateRequest>

/** Change the words or the due date. Never the section or the subject. */
export const HomeworkUpdateRequest = z
  .strictObject({
    expectedVersion: Version,
    title: HomeworkTitle.optional(),
    instructions: HomeworkInstructions.optional(),
    dueOn: CalendarDate.optional(),
  })
  .refine((value) => value.title !== undefined || value.instructions !== undefined || value.dueOn !== undefined, {
    message: 'Change at least one thing',
  })
export type HomeworkUpdateRequest = z.infer<typeof HomeworkUpdateRequest>

/** Remove an item for good. It and its check-offs stay for the record. The reason goes to the audit note. */
export const HomeworkRemoveRequest = z.strictObject({
  expectedVersion: Version,
  reason: z.string().trim().min(1).max(500).optional(),
})
export type HomeworkRemoveRequest = z.infer<typeof HomeworkRemoveRequest>

/** The file name travels in the query string; the body is the raw bytes. Each upload bumps the item's version. */
export const HomeworkAttachmentUploadQuery = z.strictObject({
  expectedVersion: z.number().int().min(1),
  fileName: z.string().trim().min(1).max(120),
})
export type HomeworkAttachmentUploadQuery = z.infer<typeof HomeworkAttachmentUploadQuery>

/** Take one file off an item. Bumps the item's version. */
export const HomeworkAttachmentRemoveRequest = z.strictObject({ expectedVersion: Version })
export type HomeworkAttachmentRemoveRequest = z.infer<typeof HomeworkAttachmentRemoveRequest>

// ---------------------------------------------------------------------------
// Check-off sheet.

/** The stored check-off behind a row. */
export const HomeworkCheckView = z.strictObject({
  id: Id,
  version: Version,
  status: HomeworkCheckStatus,
  remark: HomeworkRemark.optional(),
  checkedAt: Timestamp,
  checkedBy: DisplayName.optional(),
})
export type HomeworkCheckView = z.infer<typeof HomeworkCheckView>

export const HomeworkCheckRow = z.strictObject({
  student: HomeworkPupil,
  /** Absent: not checked yet. */
  check: HomeworkCheckView.optional(),
})
export type HomeworkCheckRow = z.infer<typeof HomeworkCheckRow>

/** The roster down, one status and remark each. Staff with homework.check, or homework.read at a staff scope. */
export const HomeworkCheckSheet = z.strictObject({
  homework: HomeworkListItem,
  window: HomeworkCheckWindow,
  rows: z.array(HomeworkCheckRow).max(HOMEWORK_ROSTER_MAX),
})
export type HomeworkCheckSheet = z.infer<typeof HomeworkCheckSheet>

/**
 * One pupil's line. `expectedVersion` is the version of the check-off the
 * writer read, 0 when the pupil was not checked; the whole save is refused
 * with VERSION_CONFLICT when any line has moved. `remark` null clears it.
 */
export const HomeworkCheckLine = z.strictObject({
  studentId: Id,
  status: HomeworkCheckStatus,
  remark: HomeworkRemark.nullable().optional(),
  expectedVersion: z.number().int().nonnegative(),
})
export type HomeworkCheckLine = z.infer<typeof HomeworkCheckLine>

/** The changed lines of the sheet, saved in one write and one audit row. A line is never un-checked. */
export const HomeworkCheckSaveRequest = z.strictObject({
  entries: z
    .array(HomeworkCheckLine)
    .min(1)
    .max(HOMEWORK_ROSTER_MAX)
    .refine((lines) => new Set(lines.map((line) => line.studentId)).size === lines.length, 'Each pupil may appear once'),
})
export type HomeworkCheckSaveRequest = z.infer<typeof HomeworkCheckSaveRequest>

// ---------------------------------------------------------------------------
// Report (gated by homework.check, so a teacher sees it for their own scope).

/** Items due from..to (both included, at most HOMEWORK_REPORT_MAX_DAYS). Removed items are left out. */
export const HomeworkReportRequest = z
  .strictObject({
    from: CalendarDate,
    to: CalendarDate,
    academicYearId: Id.optional(),
    sectionId: Id.optional(),
    subjectId: Id.optional(),
    general: QueryFlag.optional(),
  })
  .refine((value) => value.to >= value.from, { message: 'The end of the range is before its start', path: ['to'] })
  .refine((value) => dayCount(value.from, value.to) <= HOMEWORK_REPORT_MAX_DAYS, {
    message: `A report covers ${HOMEWORK_REPORT_MAX_DAYS} days at most`,
    path: ['to'],
  })
  .refine((value) => !(value.subjectId !== undefined && value.general === 'true'), {
    message: 'Choose a subject or general homework, not both',
    path: ['general'],
  })
export type HomeworkReportRequest = z.infer<typeof HomeworkReportRequest>

/** Items set per section and subject in the range. */
export const HomeworkReportSetRow = z.strictObject({
  section: NamedReference,
  grade: NamedReference,
  /** Absent for general homework. */
  subject: NamedReference.optional(),
  items: z.number().int().nonnegative(),
  /** Check-offs over those items' rosters. */
  done: z.number().int().nonnegative(),
  partlyDone: z.number().int().nonnegative(),
  notDone: z.number().int().nonnegative(),
  notChecked: z.number().int().nonnegative(),
})
export type HomeworkReportSetRow = z.infer<typeof HomeworkReportSetRow>

/** A pupil with HOMEWORK_NOT_DONE_THRESHOLD or more Not done in the range. */
export const HomeworkReportPupilRow = z.strictObject({
  student: HomeworkPupil,
  section: NamedReference,
  grade: NamedReference,
  notDone: z.number().int().nonnegative(),
  /** Items in the range the pupil was checked on. */
  checked: z.number().int().nonnegative(),
})
export type HomeworkReportPupilRow = z.infer<typeof HomeworkReportPupilRow>

export const HomeworkReportResponse = z.strictObject({
  from: CalendarDate,
  to: CalendarDate,
  threshold: z.number().int().positive(),
  sets: z.array(HomeworkReportSetRow).max(2000),
  repeatedNotDone: z.array(HomeworkReportPupilRow).max(2000),
  /** homework.export when the caller may export the report. */
  allowedActions: AllowedActions,
})
export type HomeworkReportResponse = z.infer<typeof HomeworkReportResponse>

/** The Excel report, through the exports module (job kind `homework_report`). Same filters as the screen. */
export const HomeworkReportExportRequest = HomeworkReportRequest
export type HomeworkReportExportRequest = z.infer<typeof HomeworkReportExportRequest>

export const HomeworkExportJob = ExportJobSummary
export type HomeworkExportJob = z.infer<typeof HomeworkExportJob>

// ---------------------------------------------------------------------------
// Subject access. Imported by module-lifecycle.

/**
 * One of the pupil's check-offs in a subject access export. A check-off is
 * part of the pupil's record and outlives its item: once the retention sweep
 * has removed the item, the title and due date are gone and the class, year,
 * subject, status and remark stay. The remark is cleared when the pupil is
 * anonymised.
 */
export const SubjectHomeworkCheck = z.strictObject({
  academicYear: NamedReference,
  section: NamedReference,
  grade: NamedReference,
  /** Absent for general homework. */
  subject: NamedReference.optional(),
  /** Absent once the item itself has been removed by the retention sweep. */
  title: HomeworkTitle.optional(),
  dueOn: CalendarDate.optional(),
  status: HomeworkCheckStatus,
  remark: HomeworkRemark.optional(),
  checkedAt: Timestamp,
})
export type SubjectHomeworkCheck = z.infer<typeof SubjectHomeworkCheck>

// ---------------------------------------------------------------------------
// Dashboard cards. Imported by module-dashboard.

/** One item on a family's "Homework due" card: due today or tomorrow, for one child. */
export const DashboardHomeworkDueItem = z.strictObject({
  homeworkId: Id,
  /** Absent for general homework. */
  subject: NamedReference.optional(),
  title: HomeworkTitle,
  dueOn: CalendarDate,
  status: HomeworkPupilStatus,
})
export type DashboardHomeworkDueItem = z.infer<typeof DashboardHomeworkDueItem>

/** The "Homework due" card of one child (or of a pupil themself): due today and tomorrow, soonest first. */
export const DashboardHomeworkDue = z.strictObject({
  today: z.array(DashboardHomeworkDueItem).max(50),
  tomorrow: z.array(DashboardHomeworkDueItem).max(50),
})
export type DashboardHomeworkDue = z.infer<typeof DashboardHomeworkDue>

/** One item on a teacher's "To check" card: past its due date with pupils not checked. */
export const DashboardHomeworkToCheckItem = z.strictObject({
  homeworkId: Id,
  section: NamedReference,
  grade: NamedReference,
  subject: NamedReference.optional(),
  title: HomeworkTitle,
  dueOn: CalendarDate,
  pupils: z.number().int().nonnegative(),
  notChecked: z.number().int().nonnegative(),
})
export type DashboardHomeworkToCheckItem = z.infer<typeof DashboardHomeworkToCheckItem>
