/**
 * Settings → Assistant: the school's switch, the question limits and this month's counts.
 *
 * The counts are how many questions each role asked, never what was asked: nobody, not even the
 * owner, reads another person's conversation.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Sparkles, UserCog } from 'lucide-react'
import { toast } from 'sonner'
import { AssistantSettingsValues, type AssistantSettings, type AssistantUsage } from '@erp/contracts'
import { SettingsTabs } from '@/components/settings/settings-tabs'
import { Field } from '@/components/setup/field'
import { EmptyState, Facts, PageHeader, Panel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { allows, roleLabel } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { CHECK_FIELDS, focusFirstInvalid, validate, type FieldErrors, type FieldLabels } from '@/lib/validation'

/** Numbers are kept as typed, so an empty box is a problem to point at, not a silent zero. */
type Form = {
  enabled: boolean
  dailyQuestionsStaff: string
  dailyQuestionsFamily: string
  monthlyQuestions: string
}

const LABELS: FieldLabels = {
  dailyQuestionsStaff: { label: 'questions per staff member per day', kind: 'number' },
  dailyQuestionsFamily: { label: 'questions per parent or pupil per day', kind: 'number' },
  monthlyQuestions: { label: 'questions for the whole school per month', kind: 'number' },
}

const SWITCH_LABEL = 'Let people in this school use the assistant'

function toForm(settings: AssistantSettings): Form {
  return {
    enabled: settings.enabled,
    dailyQuestionsStaff: String(settings.dailyQuestionsStaff),
    dailyQuestionsFamily: String(settings.dailyQuestionsFamily),
    monthlyQuestions: String(settings.monthlyQuestions),
  }
}

/** An empty box is not a number, so the check says "Enter the ..." instead of saving 0. */
function numberOf(text: string): number {
  return text.trim() === '' ? Number.NaN : Number(text)
}

const count = (value: number) => value.toLocaleString('en-IN')

/** "2026-09" as "September 2026". */
function monthLabel(month: string): string {
  const [year, index] = month.split('-').map(Number)
  return new Date(Date.UTC(year ?? 1970, (index ?? 1) - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function AssistantSettingsPage() {
  const { hasPermission } = useSchoolContext()

  const header = (
    <>
      <PageHeader crumbs={[{ label: 'Settings', icon: <UserCog /> }, { label: 'Assistant' }]} hideOnMobile />
      <SettingsTabs />
    </>
  )

  if (!hasPermission('ai_assistant.manage')) {
    return (
      <>
        {header}
        <EmptyState icon={<Sparkles />} title="You cannot change the school assistant" description="Ask an owner or principal if you need this." />
      </>
    )
  }

  return (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto bg-background p-3 scrollbar-thin md:p-5">
        <div className="max-w-3xl space-y-4">
          <SettingsPanel />
          <UsagePanel />
        </div>
      </div>
    </>
  )
}

function SettingsPanel() {
  const { schoolId } = useSchoolContext()
  const { data: settings, isLoading, error } = useQuery({
    queryKey: qk.assistant.settings(schoolId),
    queryFn: () => api.assistant.settings(schoolId),
  })

  if (error) {
    return <Panel title="School assistant"><p className="text-[13px] text-muted-foreground">{describeError(error)}</p></Panel>
  }
  if (isLoading || !settings) return <Skeleton className="h-72 w-full rounded-xl" />

  // The record says whether this person may change it; without that the values are only shown.
  if (!allows(settings.allowedActions, 'ai_assistant.manage')) {
    return (
      <Panel title="School assistant">
        <Facts items={[
          { label: 'Assistant', value: settings.enabled ? 'On' : 'Off' },
          { label: 'Questions per staff member per day', value: count(settings.dailyQuestionsStaff) },
          { label: 'Questions per parent or pupil per day', value: count(settings.dailyQuestionsFamily) },
          { label: 'Questions for the whole school per month', value: count(settings.monthlyQuestions) },
        ]} />
      </Panel>
    )
  }

  // A saved version starts the form again from what the server now holds.
  return <SettingsForm key={settings.version} settings={settings} />
}

function SettingsForm({ settings }: { settings: AssistantSettings }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Form>(() => toForm(settings))
  const [errors, setErrors] = useState<FieldErrors>({})

  const save = useMutation({
    mutationFn: (values: AssistantSettingsValues) =>
      api.assistant.updateSettings(schoolId, { ...values, expectedVersion: settings.version }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'assistant'] })
      toast.success('Assistant settings saved')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }))
  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(settings))

  function submit() {
    const checked = validate(AssistantSettingsValues, {
      enabled: form.enabled,
      dailyQuestionsStaff: numberOf(form.dailyQuestionsStaff),
      dailyQuestionsFamily: numberOf(form.dailyQuestionsFamily),
      monthlyQuestions: numberOf(form.monthlyQuestions),
    }, LABELS)
    if (!checked.ok) {
      setErrors(checked.errors)
      toast.error(CHECK_FIELDS)
      requestAnimationFrame(() => focusFirstInvalid())
      return
    }
    setErrors({})
    save.mutate(checked.data)
  }

  return (
    <Panel title="School assistant" description="Staff, parents and pupils ask it about the records they can already see.">
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="assistant-enabled" className="text-[13.5px] font-medium">{SWITCH_LABEL}</Label>
            <p className="text-[12.5px] text-muted-foreground">
              Questions and the records needed to answer them go to Google to be answered. Nothing is kept by Google.
              Conversations are kept for 30 days and only the person who asked can read them.
            </p>
          </div>
          <Switch id="assistant-enabled" aria-label={SWITCH_LABEL} checked={form.enabled} onCheckedChange={(checked) => set('enabled', checked)} />
        </div>

        <div className="grid gap-3 border-t pt-4 sm:grid-cols-3">
          <Field label="Questions per staff member per day" error={errors.dailyQuestionsStaff}>
            <Input aria-label="Questions per staff member per day" type="number" inputMode="numeric" min={0} max={500} value={form.dailyQuestionsStaff} onChange={(e) => set('dailyQuestionsStaff', e.target.value)} />
          </Field>
          <Field label="Questions per parent or pupil per day" error={errors.dailyQuestionsFamily}>
            <Input aria-label="Questions per parent or pupil per day" type="number" inputMode="numeric" min={0} max={500} value={form.dailyQuestionsFamily} onChange={(e) => set('dailyQuestionsFamily', e.target.value)} />
          </Field>
          <Field label="Questions for the whole school per month" error={errors.monthlyQuestions}>
            <Input aria-label="Questions for the whole school per month" type="number" inputMode="numeric" min={0} max={100000} value={form.monthlyQuestions} onChange={(e) => set('monthlyQuestions', e.target.value)} />
          </Field>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <p className="text-[12.5px] text-muted-foreground">
            To switch it off for one person, open them in{' '}
            <Link to="/settings/users" className="link-dotted">Users & logins</Link>{' '}
            and add the restriction "The school assistant".
          </p>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={submit}>Save changes</Button>
        </div>
      </div>
    </Panel>
  )
}

function UsagePanel() {
  const { schoolId } = useSchoolContext()
  const { data: usage, isLoading, error } = useQuery({
    queryKey: qk.assistant.usage(schoolId),
    queryFn: () => api.assistant.usage(schoolId),
  })

  if (error) {
    return <Panel title="This month"><p className="text-[13px] text-muted-foreground">{describeError(error)}</p></Panel>
  }
  if (isLoading || !usage) return <Skeleton className="h-48 w-full rounded-xl" />

  return (
    <Panel title="This month" description={`Questions asked in ${monthLabel(usage.month)}. What people asked is never shown here.`}>
      <div className="space-y-4">
        <MonthlyUse usage={usage} />
        {usage.byRole.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Nobody has asked a question this month.</p>
        ) : (
          <div className="overflow-hidden rounded-xl border">
            <table className="w-full border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  <th className="h-9 border-b bg-muted/40 px-3 text-left font-medium text-muted-foreground">Role</th>
                  <th className="h-9 border-b border-l bg-muted/40 px-3 text-right font-medium text-muted-foreground">Questions</th>
                  <th className="h-9 border-b border-l bg-muted/40 px-3 text-right font-medium text-muted-foreground">People</th>
                </tr>
              </thead>
              <tbody>
                {usage.byRole.map((row) => (
                  <tr key={row.role} className="[&:last-child>td]:border-b-0">
                    <td className="h-9 border-b px-3">{roleLabel(row.role)}</td>
                    <td className="h-9 border-b border-l px-3 text-right tabular-nums">{count(row.questions)}</td>
                    <td className="h-9 border-b border-l px-3 text-right tabular-nums">{count(row.people)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  )
}

/** Questions so far against the school's monthly limit. */
function MonthlyUse({ usage }: { usage: AssistantUsage }) {
  const limit = usage.monthlyQuestions
  const percent = limit === 0 ? 100 : Math.min(100, (usage.questions / limit) * 100)
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 text-[13.5px]">
        <span><span className="font-semibold tabular-nums">{count(usage.questions)}</span> of {count(limit)} questions used</span>
        <span className="text-[12.5px] text-muted-foreground tabular-nums">{count(Math.max(limit - usage.questions, 0))} left</span>
      </div>
      <Progress value={percent} aria-label="Questions used this month" />
    </div>
  )
}
