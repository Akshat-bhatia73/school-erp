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
  type MessagePreview,
  type MessageWithdrawPreview,
  MESSAGE_BODY_MAX,
  MESSAGE_SCHEDULE_MAX_DAYS,
  MESSAGE_SCHEDULE_MIN_MINUTES,
  MESSAGE_TITLE_MAX,
  MessageRecipients,
} from '@erp/contracts'
import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { formatDateTime } from '@/components/messages/labels'
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

/** Whether a message's "when" choice leaves it as it is now: a draft kept a draft, or a scheduled one at the same time. */
function sameSend(preview: MessagePreview): boolean {
  const { send } = preview.proposed
  if (preview.currentStatus === 'draft') return send.when === 'draft'
  if (preview.currentStatus === 'scheduled') {
    return send.when === 'at' && preview.current?.sendAt != null && Date.parse(send.sendAt) === Date.parse(preview.current.sendAt)
  }
  return false
}

/**
 * The parts of a change to an existing message that move: its title, its words, when it goes, and
 * who among the pupils' households get it (against the proposal as it was made, when given).
 * A new notice is one thing to do.
 */
export function messageChanges(preview: MessagePreview, original?: AssistantProposalPreview): number {
  if (preview.messageId === null || preview.current === null) return 1
  const recipientsMoved = original?.kind === 'message' && recipientsOf(original) !== recipientsOf(preview)
  return [
    preview.proposed.title.trim() !== preview.current.title.trim(),
    preview.proposed.body.trim() !== preview.current.body.trim(),
    !sameSend(preview),
    recipientsMoved,
  ].filter(Boolean).length
}

/** Families, pupils or both, for an audience made of pupils; nothing for staff. Left out means families. */
export function recipientsOf(preview: MessagePreview): MessageRecipients | null {
  return preview.audience.kind === 'staff' ? null : preview.audience.recipients ?? 'families'
}

/**
 * How many things Confirm would change: pupils or staff whose mark moves, cells of a marks sheet,
 * pupils whose grades or remarks move, or the parts of a message that move. Taking back a sent
 * message is one change. `original` is the proposal as it was made, for the one edit a message
 * card allows that its preview cannot tell apart on its own (who in the household gets it).
 */
export function countChanges(preview: AssistantProposalPreview, original?: AssistantProposalPreview): number {
  switch (preview.kind) {
    case 'message':
      return messageChanges(preview, original)
    case 'message_withdraw':
      return 1
    case 'attendance_day':
    case 'staff_attendance_day':
      return preview.rows.filter((row) => row.proposed !== row.current).length
    case 'exam_marks':
      return preview.rows.reduce((sum, row) => sum + row.cells.filter(cellChanges).length, 0)
    case 'co_scholastic':
      return preview.rows.filter(gradesChange).length
  }
}

/** Grade cells and remarks that move on a co-scholastic card, counted apart so a changed remark is never hidden in a pupil count. */
export function coScholasticChanges(preview: CoScholasticPreview): { grades: number; remarks: number } {
  let grades = 0
  let remarks = 0
  for (const row of preview.rows) {
    grades += (Object.keys(row.proposed) as Array<keyof typeof row.proposed>).filter((area) => row.proposed[area] !== row.current[area]).length
    if (!sameRemarks(row.currentRemarks, row.proposedRemarks)) remarks += 1
  }
  return { grades, remarks }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

export function changesText(count: number, preview?: AssistantProposalPreview): string {
  if (count === 0) return 'Nothing changes yet'
  if (preview?.kind === 'message') return messageWhenText(preview)
  if (preview?.kind === 'message_withdraw') return 'It disappears from every inbox. Emails already sent cannot be taken back.'
  if (preview?.kind === 'co_scholastic') {
    // "3 grade changes and 1 remark change": a remark the assistant wrote is said out loud.
    const { grades, remarks } = coScholasticChanges(preview)
    const parts = [
      grades > 0 ? plural(grades, 'grade change', 'grade changes') : '',
      remarks > 0 ? plural(remarks, 'remark change', 'remark changes') : '',
    ].filter((part) => part !== '')
    return parts.join(' and ')
  }
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
  if (preview.kind === 'co_scholastic' || preview.kind === 'message') return false
  if (preview.kind === 'message_withdraw') return true
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

/** Who each row is about, in order: the part of a preview a kept draft must match. */
function rowIds(preview: Exclude<AssistantProposalPreview, MessagePreview | MessageWithdrawPreview>): string[] {
  switch (preview.kind) {
    case 'attendance_day': return preview.rows.map((row) => row.studentId)
    case 'staff_attendance_day': return preview.rows.map((row) => row.staffId)
    case 'exam_marks': return preview.rows.map((row) => `${row.studentId}:${row.cells.map((cell) => cell.component).join(',')}`)
    case 'co_scholastic': return preview.rows.map((row) => row.studentId)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A card's edited copy kept in the tab, put back over the proposal it was made from. It is used
 * only when it is plainly the same change (same kind, the same rows in the same order), and only
 * the fields the card lets the person edit are taken from it; everything else comes from the
 * proposal. Anything else returns null and the card starts from the proposal.
 */
export function restoreDraft(original: AssistantProposalPreview, kept: unknown): AssistantProposalPreview | null {
  if (original.kind === 'message') return restoreMessage(original, kept)
  if (original.kind === 'message_withdraw') {
    if (!isRecord(kept) || kept.kind !== original.kind || kept.messageId !== original.messageId) return null
    return { ...original, reason: typeof kept.reason === 'string' ? kept.reason : undefined }
  }
  if (!isRecord(kept) || kept.kind !== original.kind || !Array.isArray(kept.rows)) return null
  const keptPreview = kept as unknown as typeof original
  const a = rowIds(original)
  let b: string[]
  try { b = rowIds(keptPreview) } catch { return null }
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) return null

  const reason = typeof kept.reason === 'string' ? kept.reason : undefined
  try {
    switch (original.kind) {
      case 'attendance_day':
      case 'staff_attendance_day': {
        const rows = (keptPreview as typeof original).rows
        return { ...original, reason, rows: original.rows.map((row, i) => ({ ...row, proposed: rows[i]!.proposed })) } as AssistantProposalPreview
      }
      case 'exam_marks': {
        const rows = (keptPreview as ExamMarksPreview).rows
        const reasonKind = (keptPreview as ExamMarksPreview).reasonKind ?? original.reasonKind
        return { ...original, reason, reasonKind, rows: original.rows.map((row, i) => ({ ...row, cells: row.cells.map((cell, c) => ({ ...cell, proposed: rows[i]!.cells[c]!.proposed })) })) }
      }
      case 'co_scholastic': {
        const rows = (keptPreview as CoScholasticPreview).rows
        return { ...original, rows: original.rows.map((row, i) => ({ ...row, proposed: { ...row.proposed, ...rows[i]!.proposed }, proposedRemarks: rows[i]!.proposedRemarks ?? null })) }
      }
    }
  } catch {
    return null
  }
}

/**
 * A message card's kept words, time and recipients over the proposal, when it is the same
 * message and each kept field has the right shape; the audience itself always comes from the proposal.
 */
function restoreMessage(original: MessagePreview, kept: unknown): MessagePreview | null {
  if (!isRecord(kept) || kept.kind !== 'message' || kept.messageId !== original.messageId || !isRecord(kept.proposed)) return null
  const { title, body, send } = kept.proposed
  if (typeof title !== 'string' || typeof body !== 'string' || !isRecord(send)) return null
  let when: MessagePreview['proposed']['send']
  if (send.when === 'draft' || send.when === 'now') when = { when: send.when }
  else if (send.when === 'at' && typeof send.sendAt === 'string') when = { when: 'at', sendAt: send.sendAt }
  else return null
  let audience = original.audience
  if (original.pupilAudience && audience.kind !== 'staff' && isRecord(kept.audience)) {
    const recipients = MessageRecipients.safeParse(kept.audience.recipients)
    if (recipients.success) audience = { ...audience, recipients: recipients.data }
  }
  return { ...original, audience, proposed: { title, body, send: when } }
}

// ---------------------------------------------------------------------------
// A message card's words

/** What Confirm says on a message card, by what it will do. */
export function messageConfirmLabel(preview: MessagePreview): string {
  const { send } = preview.proposed
  if (preview.messageId === null) {
    return send.when === 'now' ? 'Send notice' : send.when === 'at' ? 'Schedule notice' : 'Save draft'
  }
  if (send.when === 'now') return 'Send notice'
  if (send.when === 'draft' && preview.currentStatus === 'scheduled') return 'Take back to draft'
  if (send.when === 'at' && preview.currentStatus === 'draft') return 'Schedule notice'
  return 'Save changes'
}

/** The line above a message card's buttons: when it goes, in the school's time. */
export function messageWhenText(preview: MessagePreview): string {
  const { send } = preview.proposed
  if (send.when === 'now') return 'It goes out as soon as you confirm.'
  if (send.when === 'draft') return 'It stays a draft. Nobody gets it yet.'
  const at = formatDateTime(send.sendAt)
  return at ? `It goes out on ${at}.` : 'Choose when it goes.'
}

/** The first and last moment a notice may be scheduled for, from now. */
export function scheduleWindow(now = Date.now()): { earliest: number; latest: number } {
  return { earliest: now + MESSAGE_SCHEDULE_MIN_MINUTES * 60_000, latest: now + MESSAGE_SCHEDULE_MAX_DAYS * 86_400_000 }
}

/** The same sentences the message screen uses for words it cannot send, plus the time window. */
function messageProblems(preview: MessagePreview): FieldErrors {
  const errors: FieldErrors = {}
  const title = preview.proposed.title.trim()
  if (!title) errors['proposed.title'] = 'Give the message a title.'
  else if (title.length > MESSAGE_TITLE_MAX) errors['proposed.title'] = `A title can be at most ${MESSAGE_TITLE_MAX} characters.`
  const body = preview.proposed.body.trim()
  if (!body) errors['proposed.body'] = 'Write the message.'
  else if (body.length > MESSAGE_BODY_MAX) errors['proposed.body'] = `A message can be at most ${MESSAGE_BODY_MAX} characters.`
  const { send } = preview.proposed
  if (send.when === 'at') {
    const at = Date.parse(send.sendAt)
    const { earliest, latest } = scheduleWindow()
    if (Number.isNaN(at)) errors['proposed.send'] = 'Choose the date and time it should go.'
    else if (at < earliest) errors['proposed.send'] = `Choose a time at least ${MESSAGE_SCHEDULE_MIN_MINUTES} minutes from now.`
    else if (at > latest) errors['proposed.send'] = `Choose a time at most ${MESSAGE_SCHEDULE_MAX_DAYS} days ahead.`
  }
  return errors
}

// ---------------------------------------------------------------------------
// Checking an edited preview before it is sent

const LABELS: FieldLabels = {
  reason: 'reason',
  reasonKind: { label: 'reason', kind: 'select' },
  'rows.*.proposed': { label: 'mark', kind: 'select' },
  'rows.*.cells.*.proposed': { label: 'mark', kind: 'number' },
  'rows.*.proposedRemarks': 'remarks',
  'proposed.title': 'title',
  'proposed.body': 'message',
  'proposed.send': { label: 'time', kind: 'select' },
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
export function checkPreview(preview: AssistantProposalPreview, original?: AssistantProposalPreview): { ok: true; data: AssistantProposalPreview } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {}
  if (preview.kind === 'message_withdraw' && (preview.reason ?? '').trim().length < 3) errors.reason = 'Give a reason.'
  if (preview.kind === 'message') Object.assign(errors, messageProblems(preview))
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
  if (countChanges(checked.data, original) === 0) return { ok: false, errors: { [FORM_ERROR]: 'There is nothing to change. Change a value first, or discard this.' } }
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
  message: ['messages'],
  message_withdraw: ['messages'],
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
