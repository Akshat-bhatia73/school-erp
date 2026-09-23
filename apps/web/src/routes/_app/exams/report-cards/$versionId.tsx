/** One published report card, drawn from its frozen content, with its PDF. */
import { useMutation, useQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Download, NotebookPen } from 'lucide-react'
import { toast } from 'sonner'
import { CARD_LABELS } from '@/components/exams/labels'
import { ReportCard } from '@/components/exams/report-card'
import { useExportDownload } from '@/components/shared/export-download'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { allows } from '@/lib/permissions'
import { qk } from '@/lib/query'
import { useSchoolContext } from '@/lib/session'
import { formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_app/exams/report-cards/$versionId')({ component: Page })

function Page() {
  const { versionId } = Route.useParams()
  const { schoolId, hasPermission } = useSchoolContext()
  const canReadSchool = hasPermission('school.read')
  const exportFile = useExportDownload({ className: 'px-4 pt-2' })
  const cardQuery = useQuery({ queryKey: qk.reportCardVersion(schoolId, versionId), queryFn: () => api.reportCards.version(schoolId, versionId) })
  const schoolQuery = useQuery({ queryKey: qk.school(schoolId), queryFn: () => api.setup.school(schoolId), enabled: canReadSchool && cardQuery.data?.content.showLogo === true })

  const startExport = useMutation({
    mutationFn: () => api.reportCards.exportVersion(schoolId, versionId),
    onSuccess: (job) => {
      exportFile.start(job)
      toast.success('Export started')
    },
    onError: (failure) => toast.error(describeError(failure)),
  })

  const view = cardQuery.data
  const header = (
    <PageHeader
      crumbs={[
        { label: 'Exams', to: '/exams', icon: <NotebookPen /> },
        ...(view ? [{ label: view.content.student.name, to: `/exams/students/${view.content.student.id}` }] : []),
        { label: view ? `${CARD_LABELS[view.card]} report card` : 'Loading…' },
      ]}
      actions={view && allows(view.allowedActions, 'report_cards.export')
        ? <Button size="sm" variant="outline" disabled={startExport.isPending} onClick={() => startExport.mutate()}><Download />Download PDF</Button>
        : undefined}
    />
  )

  if (cardQuery.isError) {
    return <>{header}<EmptyState icon={<NotebookPen />} title="This report card is not available" description={describeError(cardQuery.error)} /></>
  }
  if (!view) {
    return <>{header}<div className="p-3 md:p-4"><Skeleton className="mx-auto h-[36rem] w-full max-w-3xl" /></div></>
  }

  // Somebody who reads the profile knows whether there is a logo; anybody else asks for it and
  // the card hides the picture if there is none.
  const logo = schoolQuery.data?.logo
  const logoSrc = view.content.showLogo && (!canReadSchool || logo) ? api.logo.url(schoolId, logo?.updatedAt) : undefined

  return (
    <>
      {header}
      {exportFile.status}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin md:p-4">
        <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <span>Version {view.versionNumber}, published {formatDate(view.publishedAt, 'long')}</span>
          {!view.latest && <Tag color="orange">A newer version exists</Tag>}
        </div>
        <ReportCard content={view.content} remarks={view.remarks} logoSrc={logoSrc} />
      </div>
    </>
  )
}
