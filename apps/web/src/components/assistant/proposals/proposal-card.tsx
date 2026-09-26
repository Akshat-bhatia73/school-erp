/**
 * One change the assistant proposes, as a card the person edits in place.
 *
 * The card edits only the preview's `proposed…`, `reason` and `reasonKind` fields. Confirm sends
 * the preview as the person left it; the server checks it is the same change, re-reads the record
 * and writes through the real route as the person. The answer (done, stale, failed, expired)
 * replaces the card's state; a request the server refused as it stood (a 400 with its own
 * sentence) is said under the buttons and the card stays open.
 */
import type {
  AssistantProposal,
  AssistantProposalPreview,
  ExamReasonKind,
} from '@erp/contracts'
import { ASSISTANT_PROPOSAL_MINUTES } from '@erp/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, CircleSlash, Clock, LoaderCircle, PencilLine, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
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
import { CoScholasticBody } from './co-scholastic-body'
import { useProposals, type ConfirmResult, type SettledProposal } from './context'
import { MarksBody } from './marks-body'
import { changesText, checkPreview, clockTime, countChanges, initialDraft, needsReason, settledText, TOUCHES } from './model'
import { RegisterBody } from './register-body'

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
function ProposalBody({ preview, onChange, errors, readOnly }: {
  preview: AssistantProposalPreview
  onChange: (next: AssistantProposalPreview) => void
  errors: FieldErrors
  readOnly: boolean
}) {
  switch (preview.kind) {
    case 'attendance_day':
    case 'staff_attendance_day':
      return <RegisterBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} />
    case 'exam_marks':
      return <MarksBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} />
    case 'co_scholastic':
      return <CoScholasticBody preview={preview} onChange={onChange} errors={errors} readOnly={readOnly} />
  }
}

/** Why saved marks or a saved register are changing, asked on the card itself before Confirm. */
function ReasonFields({ preview, onChange, errors, readOnly }: {
  preview: AssistantProposalPreview
  onChange: (next: AssistantProposalPreview) => void
  errors: FieldErrors
  readOnly: boolean
}) {
  if (preview.kind === 'co_scholastic') return null
  const id = `reason-${preview.kind}`
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
          placeholder="Some of these are already saved. Say why they are changing."
          value={preview.reason ?? ''}
          onChange={(event) => onChange({ ...preview, reason: event.target.value === '' ? undefined : event.target.value })}
          className="min-h-14 text-[13px]"
        />
        {errors.reason && <p role="alert" className="text-[12.5px] text-tag-red">{errors.reason}</p>}
      </div>
    </div>
  )
}

export function ProposalCard({ proposal: made }: { proposal: AssistantProposal }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const proposals = useProposals()
  // This card's own Confirm or Discard is the newest word, then the conversation's list, then the answer's copy.
  const [own, setOwn] = useState<SettledProposal | null>(null)
  const current = own ?? proposals.live(made.id) ?? { proposal: made }
  const { proposal } = current
  const open = proposal.status === 'open'

  const [draft, setDraft] = useState<AssistantProposalPreview>(() => initialDraft(made.preview))
  const [errors, setErrors] = useState<FieldErrors>({})

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

  const confirm = useCallback(async (): Promise<ConfirmResult> => {
    const checked = checkPreview(draft)
    if (!checked.ok) {
      setErrors(checked.errors)
      return 'blocked'
    }
    setErrors({})
    try {
      const { proposal: next } = await confirmation.mutateAsync(checked.data)
      return next.status
    } catch {
      return 'blocked'
    }
  }, [draft, confirmation])

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

  const status = proposal.status
  const shown = open ? draft : proposal.preview
  const changes = countChanges(shown)

  return (
    <section
      aria-label={proposal.title}
      data-status={status}
      className={cn('flex flex-col overflow-hidden rounded-xl border bg-card', !open && status !== 'done' && status !== 'confirming' && 'opacity-70')}
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
            <AppLink href={proposal.href} className="shrink-0 text-[12.5px] font-medium link-dotted">Open</AppLink>
          )}
        </div>
      ) : (
        <>
          <ProposalBody preview={shown} onChange={edit} errors={errors} readOnly={!open || busy} />
          {open && needsReason(shown) && <ReasonFields preview={shown} onChange={edit} errors={errors} readOnly={busy} />}
          {open ? (
            <footer className="grid gap-2 border-t px-3.5 py-2.5">
              <p className="text-[12.5px] text-muted-foreground">{changesText(changes, shown)}</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                  <Clock className="size-3.5" />
                  Open for {ASSISTANT_PROPOSAL_MINUTES} minutes
                </span>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => dismissal.mutate()}>Discard</Button>
                  <Button size="sm" disabled={busy} onClick={() => void confirm()}>Confirm</Button>
                </div>
              </div>
              {errors[FORM_ERROR] && <p role="alert" className="text-[12.5px] text-tag-red">{errors[FORM_ERROR]}</p>}
            </footer>
          ) : (
            <footer className="flex items-start gap-2 border-t px-3.5 py-2.5 text-[13px] text-muted-foreground">
              {status === 'confirming'
                ? <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
                : status === 'stale' || status === 'failed'
                  ? <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  : <CircleSlash className="mt-0.5 size-3.5 shrink-0" />}
              <span>{settledText(proposal)}</span>
            </footer>
          )}
        </>
      )}
    </section>
  )
}
