/** Words, colours and small helpers the homework screens share. */
import {
  HOMEWORK_ATTACHMENT_MAX_BYTES,
  HOMEWORK_ATTACHMENT_TYPES,
  HOMEWORK_ATTACHMENTS_MAX,
  HOMEWORK_PUPIL_STATUS_LABELS,
  type HomeworkCheckStatus,
  type HomeworkPupilStatus,
} from '@erp/contracts'
import { Tag, type TagColor } from '@/components/shared/tag'
import { formatDate } from '@/lib/utils'

export const PUPIL_STATUS_COLOR: Readonly<Record<HomeworkPupilStatus, TagColor>> = {
  done: 'green',
  partly_done: 'yellow',
  not_done: 'red',
  not_checked: 'grey',
  not_due: 'blue',
}

export function PupilStatusTag({ status }: { status: HomeworkPupilStatus }) {
  return <Tag color={PUPIL_STATUS_COLOR[status]}>{HOMEWORK_PUPIL_STATUS_LABELS[status]}</Tag>
}

export const CHECK_OPTIONS: ReadonlyArray<{ value: HomeworkCheckStatus; label: string }> = [
  { value: 'done', label: HOMEWORK_PUPIL_STATUS_LABELS.done },
  { value: 'partly_done', label: HOMEWORK_PUPIL_STATUS_LABELS.partly_done },
  { value: 'not_done', label: HOMEWORK_PUPIL_STATUS_LABELS.not_done },
]

/** The word for an item with no subject. */
export const GENERAL_LABEL = 'General'

export function subjectLabel(subject: { name: string } | undefined): string {
  return subject?.name ?? GENERAL_LABEL
}

/** "Class 6 A". */
export function classLabel(grade: { name: string } | undefined, section: { name: string }): string {
  return grade ? `${grade.name} ${section.name}` : section.name
}

/** "Due today", "Due tomorrow", "Due 6 Oct 2026". */
export function dueLabel(dueOn: string, today: string): string {
  if (dueOn === today) return 'Due today'
  if (dueOn === addDays(today, 1)) return 'Due tomorrow'
  return `Due ${formatDate(dueOn)}`
}

export function addDays(dateIso: string, by: number): string {
  const moved = new Date(`${dateIso}T00:00:00Z`)
  moved.setUTCDate(moved.getUTCDate() + by)
  return moved.toISOString().slice(0, 10)
}

/** Why a picked file cannot go on the item, or null when it can. The server checks again by its bytes. */
export function fileProblem(file: { type: string; size: number }, alreadyAttached: number): string | null {
  if (alreadyAttached >= HOMEWORK_ATTACHMENTS_MAX) return `Homework can have up to ${HOMEWORK_ATTACHMENTS_MAX} files.`
  if (!(HOMEWORK_ATTACHMENT_TYPES as readonly string[]).includes(file.type)) return 'Attach a PDF, JPEG or PNG file.'
  if (file.size > HOMEWORK_ATTACHMENT_MAX_BYTES) return 'A file can be up to 4 MB.'
  return null
}

/** Hands the browser the bytes it just fetched. */
export function saveFile(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
