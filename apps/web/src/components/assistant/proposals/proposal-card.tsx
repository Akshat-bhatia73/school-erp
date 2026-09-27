/**
 * One change the assistant proposes, as a card the person edits in place.
 *
 * The card edits only the preview's `proposed…`, `reason` and `reasonKind` fields, and a notice's
 * recipients (families, pupils or both) when it is for pupils; a fee card's pupil, year and fee
 * are never touched, so the server's same-change check accepts it. Confirm sends
 * the preview as the person left it; the server checks it is the same change, re-reads the record
 * and writes through the real route as the person. The answer (done, stale, failed, expired)
 * replaces the card's state; a request the server refused as it stood (a 400 with its own
 * sentence) is said under the buttons and the card stays open.
 *
 * A card from a reopened conversation waits for the conversation's states before it offers
 * Confirm (see ProposalsProvider's `kept`); a card open past its `expiresAt` shows as expired at
 * once, and the person's edits are kept in the tab while it is open.
 */
import type {
  AssistantProposal,
  AssistantProposalPreview,
  AttendanceDayPreview,
  ExamMarksPreview,
  ExamReasonKind,
  FeeConcessionPreview,
  MessageWithdrawPreview,
  StaffAttendanceDayPreview,
} from '@erp/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleSlash, Clock, LoaderCircle, PencilLine, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { REASON_KIND_LABELS } from '@/components/exams/reason-dialog'
import { Tag, type TagColor } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { ApiRequestError } from '@/lib/http'
import { useSchoolContext } from '@/lib/session'
import { FORM_ERROR, type FieldErrors } from '@/lib/validation'
import { cn } from '@/lib/utils'
import { AppLink } from '../app-link'
import { clearSessionDraft, draftKeys, useSessionDraft } from '../session-draft'
import { CoScholasticBody } from './co-scholastic-body'
import { useProposals, type ConfirmResult, type SettledProposal } from './context'
import { FeeConcessionBody } from './fee-concession-body'
import { FeeOptInBody } from './fee-opt-in-body'
import { FeePaymentBody } from './fee-payment-body'
import { MarksBody } from './marks-body'
import { MessageBody } from './message-body'
import { changesText, checkPreview, clockTime, countChanges, initialDraft, messageConfirmLabel, needsReason, restoreDraft, settledText, TOUCHES } from './model'
import { RegisterBody } from './register-body'
import { WithdrawBody } from './withdraw-body'

/** Done needs no tag: its own line says "Saved at 10:42". */
const STATUS_TAG: Record<Exclude<AssistantProposal['status'], 'open' | 'done'>, { label: string; color: TagColor }> = {
  confirming: { label: 'Saving', color: 'blue' },
  stale: { label: 'Changed since', color: 'orange' },
  failed: { label: 'Not saved', color: 'red' },
  expired: { label: 'Expired', color: 'grey' },
  dismissed: { label: 'Discarded', color: 'grey' },
}

/** A refusal the server explained in its own words (a 400) is said as it is; anything else in the app's usual words. */
function refusalText(error: unknown): string {
  if (error instanceof ApiRequestError && error.status === 400 && error.message.trim() !== '') return error.message
  return describeError(error)
}

/** The kind's editable body. Read-only once the proposal is settled or while it is being sent. */
function ProposalBody({ preview, onChange, errors, readOnly, idBase, errorId }: {
  preview: AssistantProposalPreview
  onChange: (next: AssistantProposalPreview) => void
  errors: FieldErrors
  readOnly: boolean
  idBase: string
  errorId: string
}) {
  switch (preview.kind) {
    case 'attendance_day':
    case 'staff_attendance_day':
      return <RegisterBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} />
    case 'exam_marks':
      return <MarksBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} errorId={errorId} />
    case 'co_scholastic':
      return <CoScholasticBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} idBase={idBase} />
    case 'message':
      return <MessageBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} idBase={idBase} />
    case 'message_withdraw':
      return <WithdrawBody preview={preview} />
    case 'fee_payment':
      return <FeePaymentBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} idBase={idBase} />
    case 'fee_concession':
      return <FeeConcessionBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} idBase={idBase} />
    case 'fee_opt_in':
      return <FeeOptInBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} idBase={idBase} />
  }
}

/** The kinds a card asks a reason for. */
type ReasonPreview = AttendanceDayPreview | StaffAttendanceDayPreview | ExamMarksPreview | MessageWithdrawPreview | FeeConcessionPreview

const REASON_PLACEHOLDER: Record<ReasonPreview['kind'], string> = {
  attendance_day: 'Some of these are already saved. Say why they are changing.',
  staff_attendance_day: 'Some of these are already saved. Say why they are changing.',
  exam_marks: 'Some of these are already saved. Say why they are changing.',
  message_withdraw: 'Why is it being withdrawn?',
  fee_concession: 'Why is this concession given? Kept in the audit log only.',
}

function asksReason(preview: AssistantProposalPreview): preview is ReasonPreview {
  return preview.kind in REASON_PLACEHOLDER && needsReason(preview)
}

/** What Confirm says it does. A message or fee card names the action; the others confirm the change shown. */
function confirmLabel(preview: AssistantProposalPreview): string {
  switch (preview.kind) {
    case 'message': return messageConfirmLabel(preview)
    case 'message_withdraw': return 'Withdraw message'
    case 'fee_payment': return 'Record payment'
    case 'fee_concession': return 'Apply concession'
    case 'fee_opt_in': return 'Add fee'
    default: return 'Confirm'
  }
}

/** The done card's link: a payment's goes to the receipt it made (or, settled later, the statement). */
function openLabel(href: string): string {
  return href.startsWith('/fees/receipts/') ? 'Open receipt' : 'Open'
}

/** Why saved marks or a saved register are changing, or a sent message is taken back, asked on the card itself before Confirm. */
function ReasonFields({ preview, onChange, errors, readOnly, idBase }: {
  preview: ReasonPreview
  onChange: (next: AssistantProposalPreview) => void
  errors: FieldErrors
  readOnly: boolean
  /** Unique to the card, so two cards on one answer never share a label target. */
  idBase: string
}) {
  const id = `${idBase}-reason`
  const errorId = `${id}-error`
  return (
    <div className="grid gap-2 border-t px-3.5 py-3">
      {preview.kind === 'exam_marks' && (
        <div className="flex items-center gap-2">
          <Label htmlFor={`${id}-kind`} className="text-[12.5px] font-normal text-muted-foreground">Why</Label>
          <Select value={preview.reasonKind ?? 'recheck'} disabled={readOnly} onValueChange={(value) => onChange({ ...preview, reasonKind: value as ExamReasonKind })}>
            <SelectTrigger id={`${id}-kind`} size="sm" className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(REASON_KIND_LABELS) as ExamReasonKind[]).map((kind) => <SelectItem key={kind} value={kind}>{REASON_KIND_LABELS[kind]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={id} className="text-[12.5px] font-normal text-muted-foreground">Reason</Label>
        <Textarea
          id={id}
          rows={2}
          maxLength={1000}
          readOnly={readOnly}
          aria-invalid={!!errors.reason || undefined}
          aria-describedby={errors.reason ? errorId : undefined}
          placeholder={REASON_PLACEHOLDER[preview.kind]}
          value={preview.reason ?? ''}
          onChange={(event) => onChange({ ...preview, reason: event.target.value === '' ? undefined : event.target.value })}
          className="min-h-14 text-[13px]"
        />
        {errors.reason && <p id={errorId} role="alert" className="text-[12.5px] text-tag-red">{errors.reason}</p>}
      </div>
    </div>
  )
}

/** True once `expiresAt` has passed, flipping by itself at that moment while `watch` is on. */
function useLapsed(expiresAt: string, watch: boolean): boolean {
  const at = Date.parse(expiresAt)
  const [lapsed, setLapsed] = useState(() => at <= Date.now())
  useEffect(() => {
    if (!watch || lapsed || Number.isNaN(at)) return
    const timer = setTimeout(() => setLapsed(true), Math.max(0, at - Date.now()))
    return () => clearTimeout(timer)
  }, [at, watch, lapsed])
  return lapsed
}

export function ProposalCard({ proposal: made }: { proposal: AssistantProposal }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const proposals = useProposals()
  const idBase = useId()
  const formErrorId = `${idBase}-form-error`
  const section = useRef<HTMLElement>(null)
  // This card's own Confirm or Discard is the newest word, then the conversation's list, then the answer's copy.
  const [own, setOwn] = useState<SettledProposal | null>(null)
  const current = own ?? proposals.live(made.id) ?? { proposal: made }
  const { proposal } = current
  // Whether the copy above can be acted on: a card from the kept history waits for the states.
  const check = own ? 'ready' : proposals.check(made.id)

  const draftKey = draftKeys.proposal(made.id)
  const initial = useCallback(() => initialDraft(made.preview), [made.preview])
  const restore = useCallback((kept: unknown) => {
    const restored = restoreDraft(made.preview, kept)
    return restored ? initialDraft(restored) : null
  }, [made.preview])
  const [draft, setDraft] = useSessionDraft<AssistantProposalPreview>(draftKey, { initial, restore })
  const [errors, setErrors] = useState<FieldErrors>({})
  const [focusAsk, setFocusAsk] = useState(0)

  const settle = (next: AssistantProposal) => {
    const settled: SettledProposal = { proposal: next, savedAt: next.status === 'done' ? new Date().toISOString() : undefined }
    setOwn(settled)
    proposals.settle(settled)
  }

  const refresh = (touched: boolean) => {
    void queryClient.invalidateQueries({ queryKey: [schoolId, 'assistant'] })
    if (!touched) return
    for (const prefix of TOUCHES[made.kind]) void queryClient.invalidateQueries({ queryKey: [schoolId, prefix] })
  }

  const confirmation = useMutation({
    mutationFn: (preview: AssistantProposalPreview) => api.assistant.confirmProposal(schoolId, made.id, { preview }),
    onSuccess: ({ proposal: next }) => {
      settle(next)
      refresh(next.status === 'done')
      if (next.status === 'done') toast.success(next.outcome ?? 'Saved')
    },
    onError: (error) => {
      setErrors({ [FORM_ERROR]: refusalText(error) })
      // The save may have been cut off half way; the conversation's list says where it stands.
      refresh(false)
    },
  })

  const dismissal = useMutation({
    mutationFn: () => api.assistant.dismissProposal(schoolId, made.id),
    onSuccess: ({ proposal: next }) => {
      settle(next)
      refresh(false)
    },
    onError: (error) => setErrors({ [FORM_ERROR]: describeError(error) }),
  })

  const busy = confirmation.isPending || dismissal.isPending

  // Past its time the card says so at once, without waiting for the server. Not while a Confirm is
  // on its way (the answer decides) and not while the states are unknown (it may be saved already).
  const lapsed = useLapsed(proposal.expiresAt, proposal.status === 'open' && check === 'ready')
  const lapsedHere = proposal.status === 'open' && check === 'ready' && lapsed && !busy
  const status: AssistantProposal['status'] = lapsedHere ? 'expired' : proposal.status
  const open = status === 'open' && check === 'ready'

  // Ask the server once it lapses here, so "Confirm all" and the list agree with the card.
  const { retry } = proposals
  useEffect(() => { if (lapsedHere) retry() }, [lapsedHere, retry])

  // An edited copy is kept only while the change can still be confirmed.
  useEffect(() => {
    if (status !== 'open') clearSessionDraft(draftKey)
  }, [status, draftKey])

  // After a blocked Confirm, take the person to the first thing that needs fixing on this card.
  useEffect(() => {
    if (focusAsk === 0) return
    const field = section.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (!field) return
    field.focus()
    field.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [focusAsk])

  const confirm = useCallback(async (): Promise<ConfirmResult> => {
    const checked = checkPreview(draft, made.preview)
    if (!checked.ok) {
      setErrors(checked.errors)
      setFocusAsk((n) => n + 1)
      return 'blocked'
    }
    setErrors({})
    try {
      const { proposal: next } = await confirmation.mutateAsync(checked.data)
      return next.status
    } catch {
      return 'blocked'
    }
  }, [draft, made.preview, confirmation])

  // Lend this card's Confirm to "Confirm all" while it is open; the latest one, with the latest edits.
  const confirmRef = useRef(confirm)
  useEffect(() => { confirmRef.current = confirm }, [confirm])
  const { register } = proposals
  useEffect(() => {
    if (!open) return
    return register(made.id, () => confirmRef.current())
  }, [open, register, made.id])

  const edit = (next: AssistantProposalPreview) => {
    setDraft(next)
    if (Object.keys(errors).length > 0) setErrors({})
  }

  const shown = status === 'open' ? draft : proposal.preview
  const changes = countChanges(shown, made.preview)
  const formError = errors[FORM_ERROR]

  return (
    <section
      ref={section}
      aria-label={proposal.title}
      data-status={status}
      className={cn('flex flex-col overflow-hidden rounded-xl border bg-card', status !== 'open' && status !== 'done' && status !== 'confirming' && 'opacity-70')}
    >
      <header className="flex items-start justify-between gap-3 border-b px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <PencilLine className="size-3.5" />
            Proposed change
          </p>
          <h4 className="truncate text-[13.5px] font-medium">{proposal.title}</h4>
        </div>
        {status !== 'open' && status !== 'done' && <Tag color={STATUS_TAG[status].color} className="mt-0.5 shrink-0">{STATUS_TAG[status].label}</Tag>}
      </header>

      {status === 'done' ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-[13px]">
          <CheckCircle2 className="size-4 shrink-0 text-tag-green" />
          <span className="font-medium">{(proposal.decidedAt ?? current.savedAt) ? `Saved at ${clockTime(proposal.decidedAt ?? current.savedAt ?? '')}` : 'Saved'}</span>
          <span className="min-w-0 flex-1 text-muted-foreground">{settledText(proposal)}</span>
          {proposal.href && (
            <AppLink href={proposal.href} className="shrink-0 text-[12.5px] font-medium link-dotted">{openLabel(proposal.href)}</AppLink>
          )}
        </div>
      ) : (
        <>
          <ProposalBody preview={shown} onChange={edit} errors={errors} readOnly={!open || busy} idBase={idBase} errorId={formErrorId} />
          {open && asksReason(shown) && <ReasonFields preview={shown} onChange={edit} errors={errors} readOnly={busy} idBase={idBase} />}
          {open ? (
            <footer className="grid gap-2 border-t px-3.5 py-2.5">
              <p className="text-[12.5px] text-muted-foreground">{changesText(changes, shown)}</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <Clock className="size-3.5" />
                  Open until {clockTime(proposal.expiresAt)}
                </span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => dismissal.mutate()}>Discard</Button>
                  <Button size="sm" disabled={busy} aria-describedby={formError ? formErrorId : undefined} variant={shown.kind === 'message_withdraw' ? 'destructive' : 'default'} onClick={() => void confirm()}>{confirmLabel(shown)}</Button>
                </div>
              </div>
              {formError && <p id={formErrorId} role="alert" className="text-[12.5px] text-tag-red">{formError}</p>}
            </footer>
          ) : status === 'open' && check === 'checking' ? (
            <footer className="flex items-center gap-2 border-t px-3.5 py-2.5 text-[13px] text-muted-foreground">
              <LoaderCircle className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
              <span>Checking…</span>
            </footer>
          ) : status === 'open' ? (
            <footer className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-3.5 py-2.5 text-[13px] text-muted-foreground">
              <TriangleAlert className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">Could not check this change.</span>
              <Button size="sm" variant="outline" onClick={proposals.retry}>Retry</Button>
            </footer>
          ) : (
            <footer className="flex items-start gap-2 border-t px-3.5 py-2.5 text-[13px] text-muted-foreground">
              {status === 'confirming'
                ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
                : status === 'stale' || status === 'failed'
                  ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  : <CircleSlash className="mt-0.5 size-3.5 shrink-0" />}
              <span>{settledText({ ...proposal, status })}</span>
            </footer>
          )}
        </>
      )}
    </section>
  )
}
