/**
 * The homework report: the items set per class and subject over a date range with how the checking
 * went, and the pupils with three or more Not done in that range. Gated by `homework.check`, so a
 * teacher sees it for their own classes and subjects and the office for the school. The Excel file
 * goes through the exports module, offered where the report's `allowedActions` carry
 * `homework.export`.
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { FileSpreadsheet, NotebookText } from 'lucide-react'
import type { ReactNode } from 'react'
import { toast } from 'sonner'
import { z } from 'zod'
import { HOMEWORK_REPORT_MAX_DAYS, HomeworkReportRequest } from '@erp/contracts'
import { todayIso } from '@/components/attendance/month-chip'
import { useClassOptions } from '@/components/homework/homework-sheet'
import { addDays, classLabel, GENERAL_LABEL, subjectLabel } from '@/components/homework/labels'
import { HomeworkTabs } from '@/components/homework/tabs'
import { useExportDownload } from '@/components/shared/export-download'
import { FilterChip } from '@/components/shared/filter-chip'
import { EmptyState, PageHeader, Panel, Toolbar } from '@/components/shared/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { HomeworkReport, HomeworkReportParams } from '@/lib/api/homework'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'

const GENERAL = 'general'

const searchSchema = z.object({
  from: z.string().optional().catch(undefined),
  to: z.string().optional().catch(undefined),
  sectionId: z.string().optional().catch(undefined),
  subjectId: z.string().optional().catch(undefined),
})
type Search = z.infer<typeof searchSchema>

export const Route = createFileRoute('/_app/homework/report')({ component: Page, validateSearch: searchSchema })

const th = 'border-b border-r px-3 py-2 text-left text-[12px] font-medium text-muted-foreground last:border-r-0'
const td = 'border-b border-r px-3 py-1.5 text-[13.5px] last:border-r-0'
const num = 'text-right tabular-nums'

function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="bg-muted/30"><tr>{head}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

function Page() {
  const { schoolId, hasPermission } = useSchoolContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const set = (patch: Partial<Search>) => void navigate({ search: (prev: Search) => ({ ...prev, ...patch }), replace: true })
  const exportFile = useExportDownload({ className: 'px-4 pb-2' })
  const classes = useClassOptions(true)
  const subjectsQuery = useQuery({ queryKey: qk.subjects(schoolId), queryFn: () => api.setup.subjects(schoolId), enabled: hasPermission('subjects.read') })

  const today = todayIso()
  const from = search.from ?? addDays(today, -30)
  const to = search.to ?? today
  const params: HomeworkReportParams = {
    from,
    to,
    sectionId: search.sectionId,
    ...(search.subjectId === GENERAL ? { general: 'true' as const } : { subjectId: search.subjectId }),
  }
  const checked = HomeworkReportRequest.safeParse(params)
  const rangeError = checked.success ? null : (checked.error.issues[0]?.message ?? `Choose a range of up to ${HOMEWORK_REPORT_MAX_DAYS} days.`)
  const canCheck = hasPermission('homework.check')
  const reportQuery = useQuery({
    queryKey: qk.homework.report(schoolId, params),
    queryFn: () => api.homework.report(schoolId, params),
    enabled: canCheck && checked.success,
  })
  const report = reportQuery.data

  const startExport = useMutation({
    mutationFn: () => api.homework.export(schoolId, params),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })
  // The record wins: the report says whether this person may export it.
  const canExport = report ? allows(report.allowedActions, 'homework.export') : false

  const subjectOptions = [
    ...(subjectsQuery.data ?? []).map((subject) => ({ value: subject.id, label: subject.name })).sort((a, b) => a.label.localeCompare(b.label)),
    { value: GENERAL, label: GENERAL_LABEL },
  ]

  const crumbs = [{ label: 'Homework', to: '/homework', icon: <NotebookText /> }, { label: 'Report' }]
  if (!canCheck) {
    return <><PageHeader crumbs={crumbs} /><EmptyState icon={<NotebookText />} title="The report is not available" description="You do not have access to the homework report." /></>
  }

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        actions={canExport && hasPermission('homework.export')
          ? <Button size="sm" variant="outline" disabled={startExport.isPending || !checked.success} onClick={() => startExport.mutate()}><FileSpreadsheet />Export to Excel</Button>
          : undefined}
      />
      <HomeworkTabs />
      <Toolbar>
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          From
          <Input type="date" aria-label="From" className="h-8 w-40" value={from} onChange={(event) => event.target.value && set({ from: event.target.value })} />
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          To
          <Input type="date" aria-label="To" className="h-8 w-40" value={to} onChange={(event) => event.target.value && set({ to: event.target.value })} />
        </label>
        <FilterChip label="Class" value={search.sectionId} options={classes.options} onChange={(value) => set({ sectionId: value })} />
        <FilterChip label="Subject" value={search.subjectId} options={subjectOptions} onChange={(value) => set({ subjectId: value })} />
      </Toolbar>
      {exportFile.status}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <div className="space-y-4">
          {rangeError ? (
            <p role="alert" className="text-[13px] text-tag-red">{rangeError}</p>
          ) : reportQuery.isError ? (
            <EmptyState icon={<NotebookText />} title="The report is not available" description={describeError(reportQuery.error)} />
          ) : !report ? (
            <><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></>
          ) : (
            <ReportTables report={report} />
          )}
        </div>
      </div>
    </>
  )
}

function ReportTables({ report }: { report: HomeworkReport }) {
  return (
    <>
      <Panel title="Homework set" description="Per class and subject, due in this range. Removed homework is left out." bodyClassName="px-0 pb-0 md:px-0">
        {report.sets.length === 0 ? (
          <EmptyState icon={<NotebookText />} title="No homework was due in this range" className="py-8" />
        ) : (
          <Table head={<>
            <th className={th}>Class</th><th className={th}>Subject</th><th className={`${th} ${num}`}>Items</th>
            <th className={`${th} ${num}`}>Done</th><th className={`${th} ${num}`}>Partly done</th><th className={`${th} ${num}`}>Not done</th><th className={`${th} ${num}`}>Not checked</th>
          </>}>
            {report.sets.map((row) => (
              <tr key={`${row.section.id}-${row.subject?.id ?? GENERAL}`}>
                <td className={td}>{classLabel(row.grade, row.section)}</td>
                <td className={td}>{subjectLabel(row.subject)}</td>
                <td className={`${td} ${num}`}>{row.items}</td>
                <td className={`${td} ${num}`}>{row.done}</td>
                <td className={`${td} ${num}`}>{row.partlyDone}</td>
                <td className={`${td} ${num}`}>{row.notDone}</td>
                <td className={`${td} ${num}`}>{row.notChecked}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
      <Panel title={`Pupils with ${report.threshold} or more Not done`} description="In this range, over the homework they were checked on." bodyClassName="px-0 pb-0 md:px-0">
        {report.repeatedNotDone.length === 0 ? (
          <EmptyState icon={<NotebookText />} title={`No pupil has ${report.threshold} or more Not done`} className="py-8" />
        ) : (
          <Table head={<>
            <th className={th}>Pupil</th><th className={th}>Admission no.</th><th className={th}>Class</th>
            <th className={`${th} ${num}`}>Not done</th><th className={`${th} ${num}`}>Checked</th>
          </>}>
            {report.repeatedNotDone.map((row) => (
              <tr key={row.student.id}>
                <td className={`${td} font-medium`}>{row.student.name}</td>
                <td className={`${td} font-mono text-[12.5px] text-muted-foreground`}>{row.student.admissionNumber}</td>
                <td className={td}>{classLabel(row.grade, row.section)}</td>
                <td className={`${td} ${num}`}>{row.notDone}</td>
                <td className={`${td} ${num}`}>{row.checked}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>
    </>
  )
}
