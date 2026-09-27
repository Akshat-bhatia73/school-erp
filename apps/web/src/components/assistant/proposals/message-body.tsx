/**
 * A notice inside a change card: who it is for (fixed; to change it the person asks again), its
 * title and words, when it goes (now, at a time in the school's clock, or kept as a draft) and,
 * for an audience made of pupils, whether families, pupils or both get it. A change to an existing
 * message shows what is saved now beside what changes.
 */
import { MESSAGE_BODY_MAX, MESSAGE_SCHEDULE_MAX_DAYS, MESSAGE_SCHEDULE_MIN_MINUTES, MESSAGE_TITLE_MAX, MessageRecipients, type MessagePreview } from '@erp/contracts'
import { Users } from 'lucide-react'
import { useState } from 'react'
import { formatDateTime, isoToLocalInput, localInputToIso, RECIPIENTS_LABEL } from '@/components/messages/labels'
import { Tag } from '@/components/shared/tag'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import type { FieldErrors } from '@/lib/validation'
import { cn } from '@/lib/utils'
import { recipientsOf, scheduleWindow } from './model'
import { Was } from './parts'

type Send = MessagePreview['proposed']['send']
type When = Send['when']

const WHEN_LABEL: Record<When, string> = { now: 'Send now', at: 'Schedule', draft: 'Keep as draft' }

/** The date and time boxes' values for an instant, or empty boxes when there is none yet. */
function splitLocal(iso: string | undefined): { date: string; time: string } {
  if (!iso || Number.isNaN(Date.parse(iso))) return { date: '', time: '' }
  const local = isoToLocalInput(iso)
  return { date: local.slice(0, 10), time: local.slice(11, 16) }
}

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? <p id={id} role="alert" className="text-[12.5px] text-tag-red">{text}</p> : null
}

export function MessageBody({ preview, onChange, errors, readOnly, idBase }: {
  preview: MessagePreview
  onChange: (next: MessagePreview) => void
  errors: FieldErrors
  readOnly: boolean
  /** Unique to the card, so two cards on one answer never share a label target. */
  idBase: string
}) {
  const { proposed, current } = preview
  const send = proposed.send
  // The boxes keep a half-typed date or time; the preview holds an instant only once both are there.
  const [local, setLocal] = useState(() => splitLocal(send.when === 'at' ? send.sendAt : current?.sendAt ?? undefined))
  const recipients = recipientsOf(preview)
  const ids = { title: `${idBase}-title`, body: `${idBase}-body`, date: `${idBase}-date`, time: `${idBase}-time` }
  const err = { title: errors['proposed.title'], body: errors['proposed.body'], send: errors['proposed.send'] }

  const setProposed = (change: Partial<MessagePreview['proposed']>) => onChange({ ...preview, proposed: { ...proposed, ...change } })
  const atFrom = (next: { date: string; time: string }): Send => ({ when: 'at', sendAt: localInputToIso(`${next.date}T${next.time}`) ?? '' })

  const chooseWhen = (when: When) => {
    if (when === 'at') setProposed({ send: atFrom(local) })
    else setProposed({ send: { when } })
  }
  const moveTime = (change: Partial<typeof local>) => {
    const next = { ...local, ...change }
    setLocal(next)
    setProposed({ send: atFrom(next) })
  }

  const titleChanged = current !== null && proposed.title.trim() !== current.title.trim()
  const bodyChanged = current !== null && proposed.body.trim() !== current.body.trim()
  const timeMoved = current?.sendAt != null && (send.when !== 'at' || Date.parse(send.sendAt) !== Date.parse(current.sendAt))
  const allowed = scheduleWindow()
  const label = 'text-[12.5px] font-normal text-muted-foreground'

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3.5 py-2.5 text-[13px]">
        <Users className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground">To </span>
          <span className="font-medium">{preview.audienceLabel}</span>
        </span>
        {preview.currentStatus === 'draft' && <Tag color="grey">Draft</Tag>}
        {preview.currentStatus === 'scheduled' && (
          <Tag color="blue">{current?.sendAt ? `Scheduled for ${formatDateTime(current.sendAt)}` : 'Scheduled'}</Tag>
        )}
      </div>

      <div className="grid gap-3 px-3.5 py-3">
        <div className="grid gap-1.5">
          <Label htmlFor={ids.title} className={label}>Title</Label>
          {readOnly ? (
            <p id={ids.title} className="text-[13.5px] font-medium break-words">{proposed.title}</p>
          ) : (
            <Input
              id={ids.title}
              value={proposed.title}
              maxLength={MESSAGE_TITLE_MAX}
              aria-invalid={!!err.title || undefined}
              aria-describedby={err.title ? `${ids.title}-error` : undefined}
              onChange={(event) => setProposed({ title: event.target.value })}
              className="h-8 text-[13.5px]"
            />
          )}
          {titleChanged && <p className="text-[12px] break-words"><Was>{current.title}</Was></p>}
          <FieldError id={`${ids.title}-error`} text={err.title} />
        </div>

        <div className="grid gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor={ids.body} className={label}>Message</Label>
            {!readOnly && (
              <span className={cn('text-[12px] tabular-nums text-muted-foreground', proposed.body.length > MESSAGE_BODY_MAX && 'text-tag-red')}>
                {proposed.body.length} / {MESSAGE_BODY_MAX}
              </span>
            )}
          </div>
          {readOnly ? (
            <p id={ids.body} className="max-h-48 overflow-auto text-[13px] break-words whitespace-pre-wrap scrollbar-thin">{proposed.body}</p>
          ) : (
            <Textarea
              id={ids.body}
              rows={5}
              maxLength={MESSAGE_BODY_MAX}
              aria-invalid={!!err.body || undefined}
              aria-describedby={err.body ? `${ids.body}-error` : undefined}
              value={proposed.body}
              onChange={(event) => setProposed({ body: event.target.value })}
              className="max-h-72 min-h-24 text-[13px]"
            />
          )}
          {bodyChanged && (
            <div className="max-h-32 overflow-auto rounded-md border bg-muted/40 px-2.5 py-1.5 text-[12px] break-words whitespace-pre-wrap scrollbar-thin">
              <span aria-hidden className="text-muted-foreground">Was: </span>
              <Was>{current.body}</Was>
            </div>
          )}
          <FieldError id={`${ids.body}-error`} text={err.body} />
        </div>

        <div className="grid gap-1.5">
          <p className={label} id={`${idBase}-when`}>When</p>
          <RadioGroup
            aria-labelledby={`${idBase}-when`}
            value={send.when}
            disabled={readOnly}
            onValueChange={(value) => chooseWhen(value as When)}
            className="flex flex-wrap gap-x-4 gap-y-2"
          >
            {(['now', 'at', 'draft'] as const).map((when) => (
              <Label key={when} className="flex items-center gap-2 text-[13.5px] font-normal"><RadioGroupItem value={when} />{WHEN_LABEL[when]}</Label>
            ))}
          </RadioGroup>
          {send.when === 'at' && (
            <div className="grid gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={ids.date}
                  type="date"
                  aria-label="Date"
                  readOnly={readOnly}
                  min={isoToLocalInput(new Date(allowed.earliest).toISOString()).slice(0, 10)}
                  max={isoToLocalInput(new Date(allowed.latest).toISOString()).slice(0, 10)}
                  value={local.date}
                  aria-invalid={!!err.send || undefined}
                  aria-describedby={err.send ? `${idBase}-send-error` : `${idBase}-send-help`}
                  onChange={(event) => moveTime({ date: event.target.value })}
                  className="h-8 w-40 text-[13px]"
                />
                <Input
                  id={ids.time}
                  type="time"
                  aria-label="Time"
                  readOnly={readOnly}
                  value={local.time}
                  aria-invalid={!!err.send || undefined}
                  onChange={(event) => moveTime({ time: event.target.value })}
                  className="h-8 w-32 text-[13px]"
                />
              </div>
              <p id={`${idBase}-send-help`} className="text-[12px] text-muted-foreground">
                In the school's time, at least {MESSAGE_SCHEDULE_MIN_MINUTES} minutes from now and at most {MESSAGE_SCHEDULE_MAX_DAYS} days ahead.
              </p>
            </div>
          )}
          {timeMoved && current?.sendAt && <p className="text-[12px]"><Was>{formatDateTime(current.sendAt)}</Was></p>}
          <FieldError id={`${idBase}-send-error`} text={err.send} />
        </div>

        {preview.pupilAudience && recipients !== null && (
          <div className="grid gap-1.5">
            <p className={label} id={`${idBase}-recipients`}>Send to</p>
            <RadioGroup
              aria-labelledby={`${idBase}-recipients`}
              value={recipients}
              disabled={readOnly}
              onValueChange={(value) => {
                if (preview.audience.kind === 'staff') return
                onChange({ ...preview, audience: { ...preview.audience, recipients: MessageRecipients.parse(value) } })
              }}
              className="flex flex-wrap gap-x-4 gap-y-2"
            >
              {MessageRecipients.options.map((value) => (
                <Label key={value} className="flex items-center gap-2 text-[13.5px] font-normal"><RadioGroupItem value={value} />{RECIPIENTS_LABEL[value]}</Label>
              ))}
            </RadioGroup>
            {recipients !== 'families' && (
              <p className="text-[12px] text-muted-foreground">Pupils in Class 9 to 12 with a login read it in the app. Other pupils get nothing.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
