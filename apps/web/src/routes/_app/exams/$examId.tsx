/**
 * One exam across the school, for the office: where each section stands, what is holding it up,
 * and publishing its results once every mark is in and the re-check deadline has passed.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, NotebookPen } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { dateRange, EnteredBar, examLabel, reasonText, SectionStatusTag } from '@/components/exams/labels'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import type { ExamSectionStatusRecord } from '@/lib/api/exams'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_app/exams/$examId')({ component: Page })

function SectionRow({ examId, status, canPublish }: { examId: string; status: ExamSectionStatusRecord; canPublish: boolean }) {
  const { schoolId } = useSchoolContext()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const complete = status.papers.filter((paper) => paper.complete).length
  const blocked = reasonText(status.blockedBy)

  const publish = useMutation({
    mutationFn: () => api.exams.publish(schoolId, examId, status.section.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'exams'] })
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'reportCards'] })
      void queryClient.invalidateQueries({ queryKey: [schoolId, 'dashboard'] })
      toast.success(`Results published for ${status.grade.name} - ${status.section.name}`)
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  return (
    <li className="border-b">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 md:px-4">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex min-w-48 flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
          <span className="min-w-0">
            <span className="block text-[13.5px] font-medium">{status.grade.name} - {status.section.name}</span>
            <span className="block text-[12.5px] text-muted-foreground">{status.pupils} {status.pupils === 1 ? 'pupil' : 'pupils'} · {complete} of {status.papers.length} papers complete</span>
          </span>
        </button>
        <SectionStatusTag complete={status.complete} publication={status.publication} />
        {status.publication && <span className="text-[12.5px] text-muted-foreground">Published {formatDate(status.publication.publishedAt)}</span>}
        {status.readyToPublish && canPublish && (
          <Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate()}>
            {status.publication ? 'Publish again' : 'Publish results'}
          </Button>
        )}
        {!status.readyToPublish && blocked && <p className="w-full pl-6 text-[12.5px] text-muted-foreground">{blocked}</p>}
      </div>
      {open && (
        <ul className="border-t bg-muted/30 px-3 py-1 md:px-4">
          {status.papers.map((paper) => (
            <li key={paper.paperId} className="flex items-center gap-3 py-1.5 pl-6">
              <Link to="/exams/papers/$paperId" params={{ paperId: paper.paperId }} className="min-w-0 flex-1 truncate text-[13px] hover:underline">{paper.subject.name}</Link>
              <EnteredBar entered={paper.entered} expected={paper.expected} />
              {paper.complete ? <Tag color="green">Complete</Tag> : <Tag color="grey">Incomplete</Tag>}
            </li>
          ))}
          {status.papers.length === 0 && <li className="py-2 pl-6 text-[12.5px] text-muted-foreground">No subjects are set up for this class.</li>}
        </ul>
      )}
    </li>
  )
}

function Page() {
  const { examId } = Route.useParams()
  const { schoolId, hasPermission } = useSchoolContext()
  const overviewQuery = useQuery({ queryKey: qk.examOverview(schoolId, examId), queryFn: () => api.exams.overview(schoolId, examId) })
  const data = overviewQuery.data
  const crumbs = [{ label: 'Exams', to: '/exams', icon: <NotebookPen /> }, { label: data ? examLabel(data.exam.kind) : 'Loading…' }]

  if (overviewQuery.isError) {
    return <><PageHeader crumbs={crumbs} /><EmptyState icon={<NotebookPen />} title="This exam is not available" description={describeError(overviewQuery.error)} /></>
  }
  if (!data) {
    return <><PageHeader crumbs={crumbs} /><div className="space-y-3 p-3 md:p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-64 w-full" /></div></>
  }

  const { exam, sections } = data
  const ready = sections.filter((section) => section.readyToPublish).length
  const published = sections.filter((section) => section.publication).length
  const canPublish = hasPermission('exams.publish')

  return (
    <>
      <PageHeader crumbs={crumbs} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-3 py-3 md:px-5">
        <div className="min-w-0">
          <h1 className="text-[16px] font-semibold">{examLabel(exam.kind)} · {exam.academicYear.name}</h1>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            {dateRange(exam.startsOn, exam.endsOn)} · Re-check deadline {formatDate(exam.recheckDeadline)}
          </p>
        </div>
        {exam.locked ? <Tag color="grey">Locked</Tag> : <Tag color="blue">Open</Tag>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {sections.length === 0 ? (
          <EmptyState icon={<NotebookPen />} title="No sections" description="There are no sections with subjects in this year yet." />
        ) : (
          <ul>{sections.map((status) => <SectionRow key={status.section.id} examId={exam.id} status={status} canPublish={canPublish} />)}</ul>
        )}
      </div>
      <div className="flex h-11 shrink-0 items-center gap-4 border-t bg-card px-4 text-[12.5px] text-muted-foreground">
        <span>{sections.length} {sections.length === 1 ? 'section' : 'sections'} in view</span>
        <span>{ready} ready to publish</span>
        <span>{published} published</span>
      </div>
    </>
  )
}
