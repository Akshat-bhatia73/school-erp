/**
 * One section's report cards. The class teacher grades the co-scholastic areas and writes the
 * remarks for each term; the office publishes the cards once the term's results are out.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import type { ColumnDef } from '@tanstack/react-table'
import {
  CO_SCHOLASTIC_AREAS,
  CoScholasticArea,
  ExamTerm,
  ReportCardKind,
  type CoScholasticGrade,
  type CoScholasticGrades,
} from '@erp/contracts'
import { Download, FileText, NotebookPen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { CARD_LABELS, examLabel, reasonText } from '@/components/exams/labels'
import { useExportDownload } from '@/components/shared/export-download'
import { DataTable, EntityCell } from '@/components/shared/data-table'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Toolbar } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import type { ReportCardEntries, ReportCardSection } from '@/lib/api/report-cards'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { cn, formatDate } from '@/lib/utils'

const searchSchema = z.object({
  tab: z.enum(['entries', 'cards']).optional().catch(undefined),
  card: ReportCardKind.optional().catch(undefined),
  term: ExamTerm.optional().catch(undefined),
})

export const Route = createFileRoute('/_app/exams/report-cards/sections/$sectionId')({ component: Page, validateSearch: searchSchema })

const TERM_LABELS = { term_1: 'Term 1', term_2: 'Term 2' } as const
const AREAS = CoScholasticArea.options
const NOT_GRADED = 'none'

// ---------- co-scholastic grades and remarks ----------

interface RowDraft { grades: CoScholasticGrades; remarks: string }

const EMPTY_GRADES: CoScholasticGrades = { work_education: null, art_education: null, health_physical_education: null, discipline: null }

function draftOf(data: ReportCardEntries): Record<string, RowDraft> {
  const draft: Record<string, RowDraft> = {}
  for (const row of data.rows) draft[row.student.id] = { grades: { ...(row.entry?.grades ?? EMPTY_GRADES) }, remarks: row.entry?.remarks ?? '' }
  return draft
}

function sameRow(a: RowDraft, b: RowDraft): boolean {
  return a.remarks.trim() === b.remarks.trim() && AREAS.every((area) => a.grades[area] === b.grades[area])
}

function EntriesTab({ sectionId, term, onTerm }: { sectionId: string; term: ExamTerm; onTerm: (term: ExamTerm) => void }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const entriesQuery = useQuery({ queryKey: qk.reportCardEntries(schoolId, sectionId, term), queryFn: () => api.reportCards.entries(schoolId, sectionId, term) })
  const data = entriesQuery.data
  const saved = useMemo(() => (data ? draftOf(data) : {}), [data])
  const [draft, setDraft] = useState<Record<string, RowDraft>>({})
  useEffect(() => setDraft(saved), [saved])

  const canManage = data ? allows(data.allowedActions, 'report_cards.manage') : false
  const changed = data ? data.rows.filter((row) => draft[row.student.id] && !sameRow(draft[row.student.id]!, saved[row.student.id]!)) : []

  const save = useMutation({
    mutationFn: () => api.reportCards.saveEntries(schoolId, sectionId, term, {
      rows: changed.map((row) => {
        const value = draft[row.student.id]!
        const remarks = value.remarks.trim()
        return { studentId: row.student.id, expectedVersion: row.entry?.version ?? 0, grades: value.grades, remarks: remarks === '' ? null : remarks }
      }),
    }),
    onSuccess: (fresh) => {
      queryClient.setQueryData(qk.reportCardEntries(schoolId, sectionId, term), fresh)
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'reportCards'] })
      toast.success('Changes saved')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const setGrade = (studentId: string, area: CoScholasticArea, grade: CoScholasticGrade | null) =>
    setDraft((current) => ({ ...current, [studentId]: { ...current[studentId]!, grades: { ...current[studentId]!.grades, [area]: grade } } }))

  return (
    <>
      <Toolbar right={canManage ? <Button size="sm" disabled={save.isPending || changed.length === 0} onClick={() => save.mutate()}>Save changes</Button> : undefined}>
        <FilterChip label="Term" value={term} options={ExamTerm.options.map((value) => ({ value, label: TERM_LABELS[value] }))} onChange={(value) => onTerm(value ?? 'term_1')} clearable={false} />
        {changed.length > 0 && <span className="text-[12.5px] text-muted-foreground">{changed.length} unsaved {changed.length === 1 ? 'change' : 'changes'}</span>}
      </Toolbar>
      {entriesQuery.isError ? (
        <EmptyState icon={<FileText />} title="These entries are not available" description={describeError(entriesQuery.error)} />
      ) : !data ? (
        <div className="p-3 md:p-4"><Skeleton className="h-64 w-full" /></div>
      ) : data.rows.length === 0 ? (
        <EmptyState icon={<FileText />} title="Nobody on this roster" description="No pupil was in this class on the first day of the term's main exam." />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
          <table className="w-full min-w-[56rem] border-collapse text-[13.5px]">
            <thead>
              <tr>
                <th className="sticky top-0 z-10 border-r border-b bg-card px-2 py-2 text-left text-[12px] font-medium text-muted-foreground">Pupil</th>
                {AREAS.map((area) => <th key={area} className="sticky top-0 z-10 w-32 border-r border-b bg-card px-2 py-2 text-left text-[12px] font-medium text-muted-foreground">{CO_SCHOLASTIC_AREAS[area]}</th>)}
                <th className="sticky top-0 z-10 border-b bg-card px-2 py-2 text-left text-[12px] font-medium text-muted-foreground">Remarks</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const value = draft[row.student.id]
                if (!value) return null
                return (
                  <tr key={row.student.id} className="align-top">
                    <td className="border-r border-b px-2 py-1.5">
                      <span className="block">{row.student.rollNumber ? `${row.student.rollNumber}. ` : ''}{row.student.name}</span>
                      <span className="block font-mono text-[11.5px] text-muted-foreground">{row.student.admissionNumber}</span>
                    </td>
                    {AREAS.map((area) => (
                      <td key={area} className="border-r border-b px-1.5 py-1.5">
                        {canManage ? (
                          <Select value={value.grades[area] ?? NOT_GRADED} onValueChange={(grade) => setGrade(row.student.id, area, grade === NOT_GRADED ? null : (grade as CoScholasticGrade))}>
                            <SelectTrigger size="sm" aria-label={`${CO_SCHOLASTIC_AREAS[area]} for ${row.student.name}`} className="w-full"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value={NOT_GRADED}>Not graded</SelectItem>
                              <SelectItem value="A">A</SelectItem>
                              <SelectItem value="B">B</SelectItem>
                              <SelectItem value="C">C</SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <span className="px-1">{value.grades[area] ?? '—'}</span>
                        )}
                      </td>
                    ))}
                    <td className="border-b px-1.5 py-1.5">
                      {canManage ? (
                        <Textarea
                          aria-label={`Remarks for ${row.student.name}`}
                          rows={2}
                          maxLength={1000}
                          value={value.remarks}
                          onChange={(event) => setDraft((current) => ({ ...current, [row.student.id]: { ...current[row.student.id]!, remarks: event.target.value } }))}
                          className="min-h-9 text-[13px]"
                        />
                      ) : (
                        <span className="text-[13px] text-muted-foreground">{value.remarks || '—'}</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {data && (
        <div className="flex h-11 shrink-0 items-center gap-4 border-t bg-card px-4 text-[12.5px] text-muted-foreground">
          <span>{data.rows.length} {data.rows.length === 1 ? 'pupil' : 'pupils'} in view</span>
        </div>
      )}
    </>
  )
}

// ---------- the cards ----------

type CardRow = ReportCardSection['rows'][number]

function CardsTab({ sectionId, card, onCard }: { sectionId: string; card: ReportCardKind; onCard: (card: ReportCardKind) => void }) {
  const { schoolId, hasPermission } = useSchoolContext()
  const queryClient = useQueryClient()
  const exportFile = useExportDownload({ className: 'px-4 py-2' })
  const sectionQuery = useQuery({ queryKey: qk.reportCardSection(schoolId, sectionId, card), queryFn: () => api.reportCards.section(schoolId, sectionId, card) })
  const data = sectionQuery.data

  const publish = useMutation({
    mutationFn: () => api.reportCards.publish(schoolId, sectionId, card, {}),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'reportCards'] })
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
      toast.success(`${result.published} ${result.published === 1 ? 'report card' : 'report cards'} published${result.unchanged > 0 ? `, ${result.unchanged} unchanged` : ''}`)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const startExport = useMutation({
    mutationFn: () => api.reportCards.exportSection(schoolId, sectionId, card),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const columns = useMemo<ColumnDef<CardRow, unknown>[]>(() => [
    { id: 'pupil', header: 'Pupil', size: 240, cell: ({ row }) => <EntityCell name={row.original.student.name} sub={row.original.student.admissionNumber} /> },
    { id: 'version', header: 'Latest version', size: 130, cell: ({ row }) => (row.original.latest ? `Version ${row.original.latest.versionNumber}` : <span className="text-muted-foreground">Not published</span>) },
    { id: 'published', header: 'Published', size: 140, cell: ({ row }) => (row.original.latest ? formatDate(row.original.latest.publishedAt) : '—') },
    { id: 'changed', header: '', size: 190, cell: ({ row }) => (row.original.latest?.changedSince ? <Tag color="orange">Changed since published</Tag> : null) },
  ], [])

  const anyPublished = data?.rows.some((row) => row.latest) ?? false
  const canPublish = hasPermission('report_cards.publish')
  const canExport = data ? allows(data.allowedActions, 'report_cards.export') : false
  const blocked = reasonText(data?.blockedBy)

  return (
    <>
      <Toolbar
        right={
          <>
            {canExport && anyPublished && <Button size="sm" variant="outline" disabled={startExport.isPending} onClick={() => startExport.mutate()}><Download />Download all</Button>}
            {canPublish && data?.readyToPublish && (
              <Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate()}>{anyPublished ? 'Publish again' : 'Publish report cards'}</Button>
            )}
          </>
        }
      >
        <FilterChip label="Card" value={card} options={ReportCardKind.options.map((value) => ({ value, label: CARD_LABELS[value] }))} onChange={(value) => onCard(value ?? 'term_1')} clearable={false} />
        {data?.exams.map((exam) => (
          <Tag key={exam.examId} color={exam.changedSincePublished ? 'orange' : exam.published ? 'green' : 'grey'}>
            {examLabel(exam.kind)}: {exam.changedSincePublished ? 'changed since published' : exam.published ? 'published' : 'not published'}
          </Tag>
        ))}
      </Toolbar>
      {blocked && !data?.readyToPublish && <p className="border-b bg-card px-4 py-2 text-[12.5px] text-muted-foreground">{blocked}</p>}
      {exportFile.status}
      {sectionQuery.isError ? (
        <EmptyState icon={<FileText />} title="These report cards are not available" description={describeError(sectionQuery.error)} />
      ) : (
        <DataTable
          columns={columns}
          data={data?.rows ?? []}
          isLoading={sectionQuery.isLoading}
          getRowId={(row) => row.student.id}
          rowLink={(row) => (row.latest ? `/exams/report-cards/${row.latest.versionId}` : '')}
          mobileRow={(row) => ({
            title: row.student.name,
            subtitle: row.latest ? `Version ${row.latest.versionNumber} · ${formatDate(row.latest.publishedAt)}` : 'Not published',
            trailing: row.latest?.changedSince ? <Tag color="orange">Changed</Tag> : undefined,
          })}
          emptyState={<EmptyState icon={<FileText />} title="Nobody on this roster" />}
          footer={<><span>{data?.rows.length ?? 0} pupils in view</span><span>{data?.rows.filter((row) => row.latest).length ?? 0} published</span></>}
        />
      )}
    </>
  )
}

function Page() {
  const { sectionId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const card = search.card ?? 'term_1'
  const term = search.term ?? (card === 'final' ? 'term_2' : 'term_1')
  const tab = search.tab ?? 'entries'
  const { schoolId } = useSchoolContext()
  // The heading names the class from whichever read has answered.
  const sectionQuery = useQuery({ queryKey: qk.reportCardSection(schoolId, sectionId, card), queryFn: () => api.reportCards.section(schoolId, sectionId, card), enabled: tab === 'cards' })
  const entriesQuery = useQuery({ queryKey: qk.reportCardEntries(schoolId, sectionId, term), queryFn: () => api.reportCards.entries(schoolId, sectionId, term), enabled: tab === 'entries' })
  const named = sectionQuery.data ?? entriesQuery.data
  const label = named ? `${named.grade.name} - ${named.section.name}` : 'Loading…'

  const go = (next: Partial<z.infer<typeof searchSchema>>) => void navigate({ search: { ...search, ...next }, replace: true })
  const tabClass = (active: boolean) => cn(
    'relative flex h-10 shrink-0 items-center px-2.5 text-[13.5px] text-muted-foreground hover:text-foreground md:h-11',
    active && 'font-medium text-foreground after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full after:bg-foreground',
  )

  return (
    <>
      <PageHeader crumbs={[{ label: 'Exams', to: '/exams', icon: <NotebookPen /> }, { label: 'Report cards', to: '/exams/report-cards' }, { label }]} />
      <div role="tablist" className="flex shrink-0 items-center gap-1 border-b bg-card px-3">
        <button type="button" role="tab" aria-selected={tab === 'entries'} className={tabClass(tab === 'entries')} onClick={() => go({ tab: 'entries' })}>Co-scholastic and remarks</button>
        <button type="button" role="tab" aria-selected={tab === 'cards'} className={tabClass(tab === 'cards')} onClick={() => go({ tab: 'cards' })}>Report cards</button>
      </div>
      {tab === 'entries'
        ? <EntriesTab sectionId={sectionId} term={term} onTerm={(value) => go({ term: value })} />
        : <CardsTab sectionId={sectionId} card={card} onCard={(value) => go({ card: value })} />}
    </>
  )
}
