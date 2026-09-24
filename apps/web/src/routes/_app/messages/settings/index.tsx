/** The automatic messages: which go out, when, and in what words. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  MESSAGE_BODY_MAX,
  MESSAGE_KIND_LABELS,
  MESSAGE_TITLE_MAX,
  PLACEHOLDERS_BY_KIND,
  unknownPlaceholders,
  type AutomaticMessageKind,
  type CommunicationSettingsValues,
} from '@erp/contracts'
import { Info, Mail } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { PlaceholderList } from '@/components/messages/placeholder-list'
import { EmptyState, PageHeader, Panel } from '@/components/shared/page'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { SettingsRecord } from '@/lib/api/messages'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export const Route = createFileRoute('/_app/messages/settings/')({ component: Page })

/** Each automatic kind with the switch that turns it on. */
const KINDS: Array<{ kind: AutomaticMessageKind; title: string; description: string; enabled: keyof CommunicationSettingsValues }> = [
  { kind: 'absence', title: 'Absence', description: 'Tells the family when a pupil is marked absent.', enabled: 'absenceEnabled' },
  { kind: 'result', title: 'Results', description: 'Tells the family when exam results are published.', enabled: 'resultsEnabled' },
  { kind: 'report_card', title: 'Report cards', description: 'Tells the family when a report card is published.', enabled: 'reportCardsEnabled' },
  { kind: 'fee_reminder', title: 'Fee reminders', description: 'Reminds the family before fees fall due.', enabled: 'feeRemindersEnabled' },
  { kind: 'fee_overdue', title: 'Fee dues', description: 'Reminds the family when fees are past their due date.', enabled: 'feeRemindersEnabled' },
  { kind: 'birthday_pupil', title: 'Pupil birthdays', description: 'Wishes a pupil a happy birthday.', enabled: 'birthdaysPupilsEnabled' },
  { kind: 'birthday_staff', title: 'Staff birthdays', description: 'Wishes a staff member a happy birthday.', enabled: 'birthdaysStaffEnabled' },
]

const HOURS = [6, 7, 8, 9, 10, 11, 12]
const hourLabel = (hour: number) => (hour === 12 ? '12 noon' : `${hour} am`)

function valuesOf(settings: SettingsRecord): CommunicationSettingsValues {
  return {
    absenceEnabled: settings.absenceEnabled,
    absenceDelayMinutes: settings.absenceDelayMinutes,
    resultsEnabled: settings.resultsEnabled,
    reportCardsEnabled: settings.reportCardsEnabled,
    feeRemindersEnabled: settings.feeRemindersEnabled,
    feeReminderDaysBefore: settings.feeReminderDaysBefore,
    feeOverdueEveryDays: settings.feeOverdueEveryDays,
    birthdaysPupilsEnabled: settings.birthdaysPupilsEnabled,
    birthdaysStaffEnabled: settings.birthdaysStaffEnabled,
    dailySendHour: settings.dailySendHour,
  }
}

/** A whole number typed into a box, kept inside its range. */
function wholeNumber(text: string, min: number, max: number): number {
  const value = Math.trunc(Number(text))
  if (Number.isNaN(value)) return min
  return Math.min(max, Math.max(min, value))
}

function Page() {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: qk.messages.settings(schoolId), queryFn: () => api.messages.settings(schoolId) })
  const settings = settingsQuery.data
  const [values, setValues] = useState<CommunicationSettingsValues | null>(null)
  useEffect(() => {
    if (settings) setValues(valuesOf(settings))
  }, [settings])
  const canManage = settings ? allows(settings.allowedActions, 'communication.manage') : false

  const save = useMutation({
    mutationFn: (next: CommunicationSettingsValues) => api.messages.saveSettings(schoolId, { ...next, expectedVersion: settings?.version ?? 1 }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: [schoolId, 'messages'] }); toast.success('Automatic messages saved') },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const header = (
    <PageHeader
      crumbs={[{ label: 'Messages', to: '/messages', icon: <Mail /> }, { label: 'Automatic messages' }]}
      actions={canManage && values ? <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(values)}>Save changes</Button> : undefined}
      mobileActions={canManage && values ? <Button size="sm" disabled={save.isPending} onClick={() => save.mutate(values)}>Save</Button> : undefined}
    />
  )
  if (settingsQuery.isError) {
    return <>{header}<EmptyState icon={<Mail />} title="Automatic messages are not available" description={describeError(settingsQuery.error)} /></>
  }
  if (!settings || !values) {
    return <>{header}<div className="space-y-3 p-3 md:p-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div></>
  }

  const set = (patch: Partial<CommunicationSettingsValues>) => setValues({ ...values, ...patch })

  const options: Partial<Record<AutomaticMessageKind, ReactNode>> = {
    absence: (
      <NumberField label="Wait before sending (minutes)" hint="Gives the teacher time to correct a mistake." value={values.absenceDelayMinutes} min={0} max={240} disabled={!canManage} onChange={(n) => set({ absenceDelayMinutes: n })} />
    ),
    fee_reminder: (
      <div className="flex flex-wrap gap-4">
        <NumberField label="Days before the due date" value={values.feeReminderDaysBefore} min={1} max={30} disabled={!canManage} onChange={(n) => set({ feeReminderDaysBefore: n })} />
        <HourField value={values.dailySendHour} disabled={!canManage} onChange={(n) => set({ dailySendHour: n })} />
      </div>
    ),
    fee_overdue: (
      <NumberField label="Remind every (days)" hint="0 means no reminders once fees are past due." value={values.feeOverdueEveryDays} min={0} max={60} disabled={!canManage} onChange={(n) => set({ feeOverdueEveryDays: n })} />
    ),
    birthday_pupil: <HourField value={values.dailySendHour} disabled={!canManage} onChange={(n) => set({ dailySendHour: n })} />,
    birthday_staff: <HourField value={values.dailySendHour} disabled={!canManage} onChange={(n) => set({ dailySendHour: n })} />,
  }

  return (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <div className="mx-auto max-w-3xl space-y-4">
          <Alert>
            <Info />
            <AlertDescription>Messages go only to families who have agreed to receive messages. Automatic messages start from the moment they are switched on and never repeat.</AlertDescription>
          </Alert>
          {KINDS.map(({ kind, title, description, enabled }) => {
            const wording = settings.wording.find((w) => w.kind === kind)
            // Fee dues share the fee reminders switch; its own "every N days" turns it off.
            const on = kind === 'fee_overdue' ? values.feeRemindersEnabled && values.feeOverdueEveryDays > 0 : values[enabled] === true
            return (
              <Panel
                key={kind}
                title={title}
                description={description}
                actions={kind === 'fee_overdue' ? undefined : (
                  <Switch aria-label={`${title} on or off`} checked={on} disabled={!canManage} onCheckedChange={(checked) => set({ [enabled]: checked })} />
                )}
              >
                <div className="space-y-4">
                  {kind === 'fee_overdue' && <p className="text-[12.5px] text-muted-foreground">Goes out while fee reminders are on.</p>}
                  {options[kind]}
                  {wording && <WordingEditor kind={kind} wording={wording} canManage={canManage} />}
                </div>
              </Panel>
            )
          })}
        </div>
      </div>
    </>
  )
}

function NumberField({ label, hint, value, min, max, disabled, onChange }: { label: string; hint?: string; value: number; min: number; max: number; disabled: boolean; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12.5px] text-muted-foreground">{label}</Label>
      <Input type="number" className="w-32" min={min} max={max} value={value} readOnly={disabled} onChange={(e) => onChange(wholeNumber(e.target.value, min, max))} />
      {hint && <p className="text-[12px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function HourField({ value, disabled, onChange }: { value: number; disabled: boolean; onChange: (n: number) => void }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[12.5px] text-muted-foreground">Send from</Label>
      <Select value={String(value)} disabled={disabled} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="w-32" aria-label="Send from"><SelectValue /></SelectTrigger>
        <SelectContent>{HOURS.map((h) => <SelectItem key={h} value={String(h)}>{hourLabel(h)}</SelectItem>)}</SelectContent>
      </Select>
      <p className="text-[12px] text-muted-foreground">Shared by birthdays and fee reminders.</p>
    </div>
  )
}

/** The words one automatic kind uses. Saving makes a new template that replaces the live one. */
function WordingEditor({ kind, wording, canManage }: { kind: AutomaticMessageKind; wording: SettingsRecord['wording'][number]; canManage: boolean }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [title, setTitle] = useState(wording.title)
  const [body, setBody] = useState(wording.body)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setTitle(wording.title)
    setBody(wording.body)
  }, [wording.title, wording.body])

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [schoolId, 'messages'] })
  const saveWords = useMutation({
    mutationFn: () => api.messages.createTemplate(schoolId, { kind, name: MESSAGE_KIND_LABELS[kind], title: title.trim(), body: body.trim() }),
    onSuccess: () => { void invalidate(); toast.success('Words saved') },
    onError: (failure) => toast.error(describeError(failure)),
  })
  // Archiving the school's own template puts the built-in words back.
  const restore = useMutation({
    mutationFn: async () => {
      const templateId = wording.templateId!
      const list = await api.messages.templates(schoolId, { kind, show: 'live' })
      const live = list.items.find((t) => t.id === templateId)
      if (!live) return
      await api.messages.archiveTemplate(schoolId, templateId, { expectedVersion: live.version })
    },
    onSuccess: () => { void invalidate(); toast.success('Built-in words restored') },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const changed = title !== wording.title || body !== wording.body

  function onSave() {
    if (!title.trim() || !body.trim()) { setError('Both the title and the words are needed.'); return }
    const unknown = [...new Set([...unknownPlaceholders(title, kind), ...unknownPlaceholders(body, kind)])]
    if (unknown.length > 0) { setError(`This message cannot use ${unknown.map((p) => `{${p}}`).join(', ')}.`); return }
    setError(null)
    saveWords.mutate()
  }

  return (
    <div className="space-y-2 border-t pt-3">
      <div className="space-y-1.5">
        <Label className="text-[12.5px] text-muted-foreground">Title</Label>
        <Input value={title} maxLength={MESSAGE_TITLE_MAX} readOnly={!canManage} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label className="text-[12.5px] text-muted-foreground">Words</Label>
        <Textarea rows={6} value={body} maxLength={MESSAGE_BODY_MAX} readOnly={!canManage} onChange={(e) => setBody(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-[12.5px] text-tag-red">{error}</p>}
      <PlaceholderList names={PLACEHOLDERS_BY_KIND[kind]} />
      {canManage && (
        <div className="flex flex-wrap justify-end gap-2">
          {wording.templateId && (
            <Button variant="ghost" size="sm" disabled={restore.isPending} onClick={() => restore.mutate()}>Restore the built-in words</Button>
          )}
          <Button variant="outline" size="sm" disabled={!changed || saveWords.isPending} onClick={onSave}>Save words</Button>
        </div>
      )}
    </div>
  )
}
