/**
 * The school's exam settings: the grade bands, what parents see, and how a report card is laid
 * out, with a live preview of a sample card drawn with the unsaved choices.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import {
  gradeBandsProblem,
  REPORT_CARD_BLOCKS,
  ReportCardBlock,
  type GradeBand,
  type ReportCardLayout,
  type ResultDisplayMode,
} from '@erp/contracts'
import { ArrowDown, ArrowUp, NotebookPen, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { EXAM_REASON_TEXT } from '@/components/exams/labels'
import { ReportCard } from '@/components/exams/report-card'
import { sampleCard } from '@/components/exams/sample-card'
import { EmptyState, PageHeader, Panel } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import type { ExamSettingsRecord } from '@/lib/api/report-cards'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

export const Route = createFileRoute('/_app/exams/settings/')({ component: Page })

interface Draft {
  displayMode: ResultDisplayMode
  gradeBands: GradeBand[]
  layout: ReportCardLayout
}

const HEADER_LINES: Array<[keyof ReportCardLayout['headerLines'], string]> = [
  ['schoolName', 'School name'],
  ['affiliationNumber', 'Affiliation number'],
  ['address', 'Address'],
  ['contact', 'Phone and email'],
]

function draftOf(settings: ExamSettingsRecord): Draft {
  return {
    displayMode: settings.displayMode,
    gradeBands: settings.gradeBands.map((band) => ({ ...band })),
    layout: structuredClone(settings.layout),
  }
}

function Page() {
  const { schoolId, school, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const settingsQuery = useQuery({ queryKey: qk.examSettings(schoolId), queryFn: () => api.reportCards.settings(schoolId) })
  const settings = settingsQuery.data
  const [draft, setDraft] = useState<Draft | null>(null)
  useEffect(() => {
    if (settings) setDraft(draftOf(settings))
  }, [settings])

  const canManage = settings ? allows(settings.allowedActions, 'exams.manage') : false
  const bandsProblem = draft ? gradeBandsProblem(draft.gradeBands) : null
  // The preview's header lines come from the school's own profile, so it
  // looks like the card parents will get; the pupil and marks are a sample.
  const profileQuery = useQuery({
    queryKey: qk.school(schoolId),
    queryFn: () => api.setup.school(schoolId),
    enabled: hasPermission('school.read'),
  })
  const profile = profileQuery.data
  const profileHeader = useMemo(() => {
    if (!profile) return undefined
    const contact = [profile.phone, profile.email].filter((part): part is string => !!part).join(' · ')
    return {
      ...(profile.affiliationNumber ? { affiliationNumber: profile.affiliationNumber } : {}),
      ...(profile.address ? { address: profile.address } : {}),
      ...(contact ? { contact } : {}),
    }
  }, [profile])
  const preview = useMemo(
    () => (draft ? sampleCard({ ...draft, schoolName: school.name, ...(profileHeader ? { header: profileHeader } : {}) }) : null),
    [draft, school.name, profileHeader],
  )

  const save = useMutation({
    mutationFn: (value: Draft) => api.reportCards.saveSettings(schoolId, {
      expectedVersion: settings?.version ?? 0,
      displayMode: value.displayMode,
      gradeBands: value.gradeBands,
      layout: { ...value.layout, footerNote: value.layout.footerNote.trim(), signatures: value.layout.signatures.map((s) => s.trim()).filter(Boolean) },
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'reportCards'] })
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'exams'] })
      toast.success('Exam settings saved')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const header = (
    <PageHeader
      crumbs={[{ label: 'Exams', to: '/exams', icon: <NotebookPen /> }, { label: 'Exams & report cards' }]}
      actions={canManage && draft ? <Button size="sm" disabled={save.isPending || bandsProblem !== null} onClick={() => save.mutate(draft)}>Save changes</Button> : undefined}
    />
  )

  if (settingsQuery.isError) {
    return <>{header}<EmptyState icon={<NotebookPen />} title="Exam settings are not available" description={describeError(settingsQuery.error)} /></>
  }
  if (!draft || !settings || !preview) {
    return <>{header}<div className="space-y-3 p-3 md:p-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-64 w-full" /></div></>
  }

  const setBands = (gradeBands: GradeBand[]) => setDraft({ ...draft, gradeBands })
  const setLayout = (layout: Partial<ReportCardLayout>) => setDraft({ ...draft, layout: { ...draft.layout, ...layout } })
  const blocks = draft.layout.blocks
  const moveBlock = (index: number, by: number) => {
    const next = [...blocks]
    const [item] = next.splice(index, 1)
    next.splice(index + by, 0, item!)
    setLayout({ blocks: next })
  }
  const allBlocks = [...blocks, ...ReportCardBlock.options.filter((block) => !blocks.includes(block))]

  return (
    <>
      {header}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <div className="grid gap-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="space-y-4">
            <Panel title="Grade bands" description="Whole percentages, both ends included, from 100 down to 0.">
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_1fr_1fr_2rem] gap-2 text-[12px] text-muted-foreground"><span>Grade</span><span>From</span><span>To</span><span /></div>
                {draft.gradeBands.map((band, index) => (
                  <div key={index} className="grid grid-cols-[1fr_1fr_1fr_2rem] items-center gap-2">
                    <Input aria-label="Grade" value={band.label} readOnly={!canManage} maxLength={8} onChange={(e) => setBands(draft.gradeBands.map((b, i) => (i === index ? { ...b, label: e.target.value } : b)))} />
                    <Input aria-label="From" type="number" min={0} max={100} value={band.min} readOnly={!canManage} onChange={(e) => setBands(draft.gradeBands.map((b, i) => (i === index ? { ...b, min: Math.trunc(Number(e.target.value)) } : b)))} />
                    <Input aria-label="To" type="number" min={0} max={100} value={band.max} readOnly={!canManage} onChange={(e) => setBands(draft.gradeBands.map((b, i) => (i === index ? { ...b, max: Math.trunc(Number(e.target.value)) } : b)))} />
                    {canManage && draft.gradeBands.length > 2 ? (
                      <Button variant="ghost" size="icon" aria-label={`Remove ${band.label || 'band'}`} onClick={() => setBands(draft.gradeBands.filter((_, i) => i !== index))}><Trash2 /></Button>
                    ) : <span />}
                  </div>
                ))}
                {bandsProblem && <p role="alert" className="text-[12.5px] text-tag-red">{EXAM_REASON_TEXT[bandsProblem]}</p>}
                {canManage && draft.gradeBands.length < 12 && (
                  <Button variant="outline" size="sm" onClick={() => setBands([...draft.gradeBands, { label: '', min: 0, max: 0 }])}><Plus />Add band</Button>
                )}
              </div>
            </Panel>

            <Panel title="What parents see" description="Staff always see the marks.">
              <RadioGroup
                value={draft.displayMode}
                disabled={!canManage}
                onValueChange={(value) => setDraft({ ...draft, displayMode: value as ResultDisplayMode })}
                className="gap-2.5"
              >
                <Label className="flex items-center gap-2 text-[13.5px] font-normal"><RadioGroupItem value="marks" />Marks with grades</Label>
                <Label className="flex items-center gap-2 text-[13.5px] font-normal"><RadioGroupItem value="grades" />Grades only</Label>
              </RadioGroup>
            </Panel>

            <Panel title="Report card layout">
              <div className="space-y-4">
                <Label className="flex items-center justify-between text-[13.5px] font-normal">
                  <span>Show the school logo{!settings.hasLogo && <span className="block text-[12px] text-muted-foreground">Add a logo on the school profile first.</span>}</span>
                  <Switch checked={draft.layout.showLogo} disabled={!canManage} onCheckedChange={(checked) => setLayout({ showLogo: checked })} />
                </Label>
                <div className="space-y-2">
                  <p className="text-[12.5px] text-muted-foreground">Header lines</p>
                  {HEADER_LINES.map(([key, label]) => (
                    <Label key={key} className="flex items-center justify-between text-[13.5px] font-normal">
                      {label}
                      <Switch checked={draft.layout.headerLines[key]} disabled={!canManage} onCheckedChange={(checked) => setLayout({ headerLines: { ...draft.layout.headerLines, [key]: checked } })} />
                    </Label>
                  ))}
                </div>
                <div className="space-y-1.5">
                  <p className="text-[12.5px] text-muted-foreground">Blocks, in order</p>
                  {allBlocks.map((block) => {
                    const index = blocks.indexOf(block)
                    const on = index >= 0
                    return (
                      <div key={block} className="flex h-9 items-center gap-2 rounded-lg border px-2">
                        <Checkbox
                          aria-label={REPORT_CARD_BLOCKS[block]}
                          checked={on}
                          disabled={!canManage || (on && blocks.length === 1)}
                          onCheckedChange={(checked) => setLayout({ blocks: checked ? [...blocks, block] : blocks.filter((b) => b !== block) })}
                        />
                        <span className={on ? 'flex-1 text-[13.5px]' : 'flex-1 text-[13.5px] text-muted-foreground'}>{REPORT_CARD_BLOCKS[block]}</span>
                        {canManage && on && (
                          <>
                            <Button variant="ghost" size="icon" aria-label={`Move ${REPORT_CARD_BLOCKS[block]} up`} disabled={index === 0} onClick={() => moveBlock(index, -1)}><ArrowUp /></Button>
                            <Button variant="ghost" size="icon" aria-label={`Move ${REPORT_CARD_BLOCKS[block]} down`} disabled={index === blocks.length - 1} onClick={() => moveBlock(index, 1)}><ArrowDown /></Button>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="space-y-2">
                  <p className="text-[12.5px] text-muted-foreground">Signature lines (up to three)</p>
                  {[0, 1, 2].map((index) => (
                    <Input
                      key={index}
                      aria-label={`Signature ${index + 1}`}
                      placeholder="Leave empty for none"
                      maxLength={40}
                      readOnly={!canManage}
                      value={draft.layout.signatures[index] ?? ''}
                      onChange={(e) => {
                        const next = [0, 1, 2].map((i) => (i === index ? e.target.value : draft.layout.signatures[i] ?? ''))
                        // All three lines are kept while editing; empty ones are dropped on save.
                        setLayout({ signatures: next })
                      }}
                    />
                  ))}
                </div>
                <div className="space-y-1.5">
                  <p className="text-[12.5px] text-muted-foreground">Footer note</p>
                  <Input aria-label="Footer note" maxLength={300} readOnly={!canManage} value={draft.layout.footerNote} onChange={(e) => setLayout({ footerNote: e.target.value })} />
                </div>
              </div>
            </Panel>
          </div>

          <Panel title="Preview" description="A sample pupil, laid out with the settings above.">
            <ReportCard
              content={{ ...preview.content, signatures: preview.content.signatures.filter((s) => s.trim() !== '') }}
              remarks={preview.remarks}
              logoSrc={settings.hasLogo ? api.logo.url(schoolId, settings.updatedAt) : undefined}
            />
          </Panel>
        </div>
      </div>
    </>
  )
}
