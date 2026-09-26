/**
 * Pure rules for the assistant's change cards: which tool part is a proposal, what a preview
 * changes, whether an edited preview can be sent, and which screens a saved change touches.
 * Nothing here touches the network, so the tests can check each rule on its own.
 */
import {
  AssistantProposalPreview,
  AssistantProposalToolOutput,
  type AssistantProposal,
  type AssistantProposalKind,
  type AssistantProposalStatus,
  type CoScholasticPreview,
  type ExamMarksPreview,
  type MarkValue,
} from '@erp/contracts'
import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { FORM_ERROR, validate, type FieldErrors, type FieldLabels } from '@/lib/validation'

/** Every change tool is named `propose_…`; its output is a proposal, never a card. */
export function isProposalTool(toolName: string): boolean {
  return toolName.startsWith('propose_')
}

/** The pieces of a tool part this needs, however the SDK shaped the rest. */
export interface ProposalPartLike {
  state?: string
  output?: unknown
}

export type ProposalPartView =
  | { kind: 'working' }
  | { kind: 'proposal'; proposal: AssistantProposal }
  /** The change could not be proposed as asked; the words say why. */
  | { kind: 'problem'; text: string }
  | { kind: 'failed' }
  | { kind: 'nothing' }

/**
 * How one change tool part is drawn. A proposal is its card; a refusal shows nothing (the model
 * says it cannot see that); a request that cannot be proposed is one muted line saying why.
 */
export function viewProposalPart(part: ProposalPartLike): ProposalPartView {
  switch (part.state) {
    case 'input-streaming':
    case 'input-available':
      return { kind: 'working' }
    case 'output-available': {
      const parsed = AssistantProposalToolOutput.safeParse(part.output)
      if (!parsed.success) return { kind: 'failed' }
      const output = parsed.data
      if (output.status === 'ok') return output.proposal ? { kind: 'proposal', proposal: output.proposal } : { kind: 'failed' }
      if (output.status === 'invalid') return output.problem ? { kind: 'problem', text: output.problem } : { kind: 'failed' }
      if (output.status === 'not_available') return { kind: 'nothing' }
      return { kind: 'failed' }
    }
    case 'output-error':
      return { kind: 'failed' }
    default:
      return { kind: 'nothing' }
  }
}

/** The proposals an answer made, in the order it made them. */
export function proposalsIn(message: Pick<UIMessage, 'parts'>): AssistantProposal[] {
  const out: AssistantProposal[] = []
  for (const part of message.parts) {
    if (!isToolUIPart(part) || !isProposalTool(getToolName(part))) continue
    const view = viewProposalPart(part)
    if (view.kind === 'proposal') out.push(view.proposal)
  }
  return out
}

/** True once any answer in the conversation holds a change tool call, so its states are worth asking for. */
export function holdsProposal(messages: readonly Pick<UIMessage, 'parts'>[]): boolean {
  return messages.some((message) => message.parts.some((part) => isToolUIPart(part) && isProposalTool(getToolName(part))))
}

// ---------------------------------------------------------------------------
// What a preview changes

function sameRemarks(a: string | null, b: string | null): boolean {
  return (a ?? '').trim() === (b ?? '').trim()
}

/** A cell with a proposed value that differs from what is saved. Null leaves the cell as it is. */
export function cellChanges(cell: { current: MarkValue | null; proposed: MarkValue | null }): boolean {
  return cell.proposed !== null && cell.proposed !== cell.current
}

/** A pupil whose grades or remarks move. Remarks compare as trimmed words, so a stray space is no change. */
export function gradesChange(row: CoScholasticPreview['rows'][number]): boolean {
  if (!sameRemarks(row.currentRemarks, row.proposedRemarks)) return true
  return (Object.keys(row.proposed) as Array<keyof typeof row.proposed>).some((area) => row.proposed[area] !== row.current[area])
}

/**
 * How many things Confirm would change: pupils or staff whose mark moves, cells of a marks sheet,
 * or pupils whose grades or remarks move.
 */
export function countChanges(preview: AssistantProposalPreview): number {
  switch (preview.kind) {
    case 'attendance_day':
    case 'staff_attendance_day':
      return preview.rows.filter((row) => row.proposed !== row.current).length
    case 'exam_marks':
      return preview.rows.reduce((sum, row) => sum + row.cells.filter(cellChanges).length, 0)
    case 'co_scholastic':
      return preview.rows.filter(gradesChange).length
  }
}

export function changesText(count: number, preview?: AssistantProposalPreview): string {
  if (count === 0) return 'Nothing changes yet'
  // A register marked for the first time saves every mark; nothing it replaces.
  if ((preview?.kind === 'attendance_day' || preview?.kind === 'staff_attendance_day') && preview.mode === 'first_entry') {
    return `${count} ${count === 1 ? 'mark' : 'marks'} to save`
  }
  return `${count} ${count === 1 ? 'change' : 'changes'}`
}

/**
 * A correction to saved attendance or marks needs a reason; co-scholastic
 * entries never ask. For marks it is any change to a saved mark, not only a
 * proposal made as a correction: the marks sheet asks the same when a saved
 * cell is edited, and the office's correction after the deadline always asks.
 */
export function needsReason(preview: AssistantProposalPreview): boolean {
  if (preview.kind === 'co_scholastic') return false
  if (preview.kind === 'exam_marks') {
    return (
      preview.mode === 'correction' ||
      preview.route === 'office_correction' ||
      preview.rows.some((row) =>
        row.cells.some((cell) => cell.current !== null && cell.proposed !== null && JSON.stringify(cell.proposed) !== JSON.stringify(cell.current)),
      )
    )
  }
  return preview.mode === 'correction'
}

/** The editable copy a card starts from: a marks correction starts on "Re-check", as the screen's own dialog does. */
export function initialDraft(preview: AssistantProposalPreview): AssistantProposalPreview {
  if (preview.kind === 'exam_marks' && needsReason(preview) && !preview.reasonKind) return { ...preview, reasonKind: 'recheck' }
  return preview
}

// ---------------------------------------------------------------------------
// Checking an edited preview before it is sent

const LABELS: FieldLabels = {
  reason: 'reason',
  reasonKind: { label: 'reason', kind: 'select' },
  'rows.*.proposed': { label: 'mark', kind: 'select' },
  'rows.*.cells.*.proposed': { label: 'mark', kind: 'number' },
  'rows.*.proposedRemarks': 'remarks',
}

/** The same sentences the register and the marks sheet use when a correction has no reason. */
const REASON_MISSING: Record<'register' | 'marks', string> = {
  register: 'Say why these marks are being changed.',
  marks: 'Say in a few words why these marks are changing.',
}

/** The marks sheet's own sentence for marks it cannot send. */
function badMarksText(count: number): string {
  return `${count} ${count === 1 ? 'mark is' : 'marks are'} not right. A mark is a number with at most one decimal, no higher than what that part is out of.`
}

function isBadMark(value: MarkValue | null, maxMarks: number): boolean {
  if (typeof value !== 'number') return false
  if (!Number.isFinite(value) || value < 0 || value > maxMarks) return true
  return Math.abs(value * 10 - Math.round(value * 10)) > 1e-6
}

/** Every mark on the sheet that cannot be sent, by its preview path. */
function badMarks(preview: ExamMarksPreview): FieldErrors {
  const errors: FieldErrors = {}
  const max = new Map(preview.components.map((component) => [component.component, component.maxMarks]))
  preview.rows.forEach((row, r) => row.cells.forEach((cell, c) => {
    if (isBadMark(cell.proposed, max.get(cell.component) ?? 0)) errors[`rows.${r}.cells.${c}.proposed`] = `Enter a mark of at most ${max.get(cell.component) ?? 0}`
  }))
  return errors
}

/**
 * The edited preview as it will be sent, or the problems to show on the card. It is checked
 * against the same `@erp/contracts` schema the server applies, plus the two rules the screens
 * check before saving: a correction says why, and a mark fits what its part is out of.
 */
export function checkPreview(preview: AssistantProposalPreview): { ok: true; data: AssistantProposalPreview } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {}
  if (needsReason(preview) && (preview.kind === 'exam_marks' || preview.kind === 'attendance_day' || preview.kind === 'staff_attendance_day')) {
    if ((preview.reason ?? '').trim().length < 3) errors.reason = REASON_MISSING[preview.kind === 'exam_marks' ? 'marks' : 'register']
  }
  if (preview.kind === 'exam_marks') {
    const bad = badMarks(preview)
    const count = Object.keys(bad).length
    if (count > 0) Object.assign(errors, bad, { [FORM_ERROR]: badMarksText(count) })
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const checked = validate(AssistantProposalPreview, preview, LABELS)
  if (!checked.ok) {
    const rowProblems = Object.keys(checked.errors).filter((key) => key.startsWith('rows.')).length
    return { ok: false, errors: rowProblems > 0 && !checked.errors[FORM_ERROR] ? { ...checked.errors, [FORM_ERROR]: 'Check the highlighted rows.' } : checked.errors }
  }
  if (countChanges(checked.data) === 0) return { ok: false, errors: { [FORM_ERROR]: 'There is nothing to change. Change a value first, or discard this.' } }
  return { ok: true, data: checked.data }
}

// ---------------------------------------------------------------------------
// After a change

/** The screens a saved change shows on, by their query prefix, so they read it fresh. */
export const TOUCHES: Record<AssistantProposalKind, readonly string[]> = {
  attendance_day: ['attendance', 'dashboard'],
  staff_attendance_day: ['attendance', 'dashboard'],
  exam_marks: ['exams', 'reportCards', 'dashboard'],
  co_scholastic: ['reportCards'],
}

/** A proposal nobody can act on any more is drawn greyed and read-only. */
export function isSettled(status: AssistantProposalStatus): boolean {
  return status !== 'open'
}

/** The line a card shows once it can no longer be confirmed. */
export function settledText(proposal: Pick<AssistantProposal, 'status' | 'outcome'>): string {
  switch (proposal.status) {
    case 'open': return ''
    case 'confirming': return 'Saving this change. It updates here in a moment.'
    case 'done': return proposal.outcome ?? 'Saved.'
    case 'stale': return 'This changed after the assistant read it. Ask again to get a fresh copy.'
    case 'failed': return proposal.outcome ?? 'This change was not saved.'
    case 'expired': return 'This was not confirmed in time, so nothing was saved. Ask again to get a fresh copy.'
    case 'dismissed': return 'Discarded. Nothing was saved.'
  }
}

/** "10:42 am" in the person's own clock. */
export function clockTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}
