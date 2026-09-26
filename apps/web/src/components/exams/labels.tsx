/** Words and small pieces every exams screen shares: exam names, reasons, marks and status tags. */
import { EXAM_COMPONENTS, EXAM_PATTERN, type ErrorReason, type ExamComponent, type ExamKind, type MarkValue, type ReportCardKind } from '@erp/contracts'
import { Tag } from '@/components/shared/tag'
import { formatDate } from '@/lib/utils'

export function examLabel(kind: ExamKind): string {
  return EXAM_PATTERN[kind].label
}

export function componentLabel(component: ExamComponent): string {
  return EXAM_COMPONENTS[component].label
}

/**
 * Said when a save is refused because somebody saved these marks after the sheet was read.
 * The sheet refetches at the same time, so the newer marks are already showing.
 */
export const STALE_MARKS_MESSAGE = 'Somebody else saved these marks first. The latest marks are now shown; check them and save again.'

export const CARD_LABELS: Record<ReportCardKind, string> = { term_1: 'Term 1', final: 'Final' }

export const STATUS_LABELS = { absent: 'Absent', medical: 'Medical', exempt: 'Exempt' } as const

/** A mark or a status as a person reads it: "7.5", "Absent". */
export function markText(value: MarkValue | null | undefined): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return String(value)
  return STATUS_LABELS[value]
}

export function percentText(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`
}

/**
 * The server's reason for a shut window or a section that cannot be published, in the same
 * words the API uses when it refuses the write.
 */
export const EXAM_REASON_TEXT: Partial<Record<ErrorReason, string>> = {
  exam_dates_outside_year: 'The exam dates have to fall inside the academic year.',
  exam_already_published: 'Results for this exam have already been published, so its dates can no longer change.',
  exam_nothing_to_publish: 'These results are already published and no mark has changed since.',
  exam_not_started: 'This exam has not started yet. Marks can be entered from its first day.',
  exam_recheck_deadline_passed: 'The re-check deadline for this exam has passed. Only the office can change these marks now.',
  exam_change_needs_reason: 'Changing a mark that was already saved needs a reason.',
  exam_publish_before_deadline: 'Results can be published once the re-check deadline has passed.',
  exam_section_incomplete: 'Every pupil needs a mark or a status in every subject before the results can be published.',
  grade_bands_overlap: 'Two grade bands cover the same marks. Each mark can belong to one band only.',
  grade_bands_gap: 'The grade bands leave some marks without a grade. Make each band start one above the next one down.',
  grade_bands_out_of_range: 'The grade bands have to run from 0 to 100.',
  grade_bands_duplicate_label: 'Two grade bands have the same name.',
  report_card_exams_not_published: "The results of this term's exams have to be published for this section before its report cards can be.",
  report_card_exams_changed: "Marks have changed since this term's results were published. Publish the results again first.",
  report_card_nothing_to_publish: 'Every report card here is already published and nothing has changed since.',
}

export function reasonText(reason: ErrorReason | undefined): string | undefined {
  return reason ? EXAM_REASON_TEXT[reason] : undefined
}

/** Where one paper stands, as a tag. */
export function PaperStatusTag({ state, published }: { state: 'not_started' | 'open' | 'locked'; published: boolean }) {
  if (published) return <Tag color="green">Published</Tag>
  if (state === 'open') return <Tag color="blue">Open</Tag>
  if (state === 'locked') return <Tag color="grey">Locked</Tag>
  return <Tag color="grey">Not started</Tag>
}

/** Where one section stands for one exam. */
export function SectionStatusTag({ complete, publication }: { complete: boolean; publication: { changedSince: boolean } | null }) {
  if (publication?.changedSince) return <Tag color="orange">Changed since published</Tag>
  if (publication) return <Tag color="green">Published</Tag>
  if (complete) return <Tag color="blue">Ready to publish</Tag>
  return <Tag color="grey">Incomplete</Tag>
}

/** "entered 12 of 40" as a thin bar with the figures beside it. */
export function EnteredBar({ entered, expected }: { entered: number; expected: number }) {
  const width = expected > 0 ? Math.round((entered / expected) * 100) : 0
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
        <span className={entered >= expected && expected > 0 ? 'block h-full rounded-full bg-tag-green' : 'block h-full rounded-full bg-tag-blue'} style={{ width: `${width}%` }} />
      </span>
      <span className="text-[12.5px] tabular-nums text-muted-foreground">{entered} of {expected}</span>
    </span>
  )
}

export function dateRange(startsOn: string, endsOn: string): string {
  return startsOn === endsOn ? formatDate(startsOn) : `${formatDate(startsOn)} to ${formatDate(endsOn)}`
}
