import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard } from 'lucide-react'
import { api } from '@/api/client'
import { QuickActions } from '@/components/dashboard/quick-actions'
import { RecentActivity } from '@/components/dashboard/recent-activity'
import { SetupChecklist } from '@/components/dashboard/setup-checklist'
import { StatPanel } from '@/components/dashboard/stat-panel'
import { StudentsByClass } from '@/components/dashboard/students-by-class'
import { PageHeader } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { qk } from '@/lib/query'
import { useSession } from '@/lib/session'
import { formatDate, formatINR } from '@/lib/utils'

export const Route = createFileRoute('/_app/dashboard')({ component: Page })

function Page() {
  const { school } = useSession()
  const { data, isLoading } = useQuery({ queryKey: qk.dashboard, queryFn: api.dashboard.summary })
  const today = new Date().toISOString()

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Dashboard', icon: <LayoutDashboard /> }]}
        actions={
          <>
            {data?.academicYearName && <Tag color="blue">{data.academicYearName}</Tag>}
            <span className="text-[12.5px] text-muted-foreground">Today, {formatDate(today)}</span>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-3 md:p-5">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13.5px] text-muted-foreground">Overview for {school?.name ?? 'your school'}</p>
            <QuickActions />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatPanel
              label="Active students"
              isLoading={isLoading}
              value={data?.students.active ?? 0}
              sub={`${data?.students.newThisYear ?? 0} admitted this year · ${data?.students.rte ?? 0} under RTE`}
            />
            <StatPanel
              label="Staff"
              isLoading={isLoading}
              value={data?.staff.total ?? 0}
              sub={`${data?.staff.teaching ?? 0} teaching · ${data?.staff.nonTeaching ?? 0} non-teaching`}
            />
            <StatPanel
              label="Attendance today"
              tag="Phase 2 preview"
              isLoading={isLoading}
              value={`${data?.attendance?.todayPercent ?? 0}%`}
              sub={`${data?.attendance?.unmarkedSections ?? 0} sections not marked yet`}
            />
            <StatPanel
              label="Fees collected this month"
              tag="Phase 2 preview"
              isLoading={isLoading}
              value={formatINR(data?.fees?.collectedThisMonth ?? 0, { compact: true })}
              sub={`${formatINR(data?.fees?.pendingTotal ?? 0, { compact: true })} pending · ${data?.fees?.defaulters ?? 0} defaulters`}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2"><StudentsByClass students={data?.students} isLoading={isLoading} /></div>
            <SetupChecklist steps={data?.setup.steps} isLoading={isLoading} />
          </div>

          <RecentActivity items={data?.recentActivity} isLoading={isLoading} />
        </div>
      </div>
    </>
  )
}
