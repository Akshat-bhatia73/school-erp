import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard } from 'lucide-react'
import { BentoGrid, Cell } from '@/components/dashboard/blocks/card'
import { AccountantDashboard } from '@/components/dashboard/accountant-dashboard'
import { OfficeDashboard } from '@/components/dashboard/office-dashboard'
import { ParentDashboard } from '@/components/dashboard/parent-dashboard'
import { StudentDashboard } from '@/components/dashboard/student-dashboard'
import { TeacherDashboard } from '@/components/dashboard/teacher-dashboard'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { useSchoolDashboardView } from '@/lib/dashboard-view'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_app/dashboard')({ component: Page })

function Page() {
  const { schoolId } = useSchoolContext()
  const { current } = useAcademicYear()
  // The chosen view is sent only when one is stored; otherwise the server's own order decides.
  const { view: audience, preferred } = useSchoolDashboardView()
  const params = preferred ? { audience: preferred } : undefined
  const { data, isLoading, error } = useQuery({
    queryKey: qk.dashboard(schoolId, params),
    queryFn: () => api.dashboard.get(schoolId, params),
  })
  const today = new Date().toISOString()

  return (
    <>
      <PageHeader
        crumbs={[{ label: audience === 'parent' ? 'My children' : audience === 'student' ? 'Home' : 'Dashboard', icon: <LayoutDashboard /> }]}
        actions={
          <>
            {current && <Tag color="blue">{current.name}</Tag>}
            <span className="text-[12.5px] text-muted-foreground">Today, {formatDate(today)}</span>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-4 p-4 md:p-5">
          {data?.audience === 'office' && <OfficeDashboard data={data} isLoading={isLoading} error={error} />}
          {data?.audience === 'teacher' && <TeacherDashboard data={data} isLoading={isLoading} error={error} />}
          {data?.audience === 'parent' && <ParentDashboard data={data} isLoading={isLoading} error={error} />}
          {data?.audience === 'student' && <StudentDashboard data={data} isLoading={isLoading} error={error} />}
          {data?.audience === 'accountant' && <AccountantDashboard data={data} isLoading={isLoading} error={error} />}
          {!data && error && (
            <EmptyState icon={<LayoutDashboard />} title="We could not open your dashboard" description={describeError(error)} />
          )}
          {!data && !error && <DashboardSkeleton />}
        </div>
      </div>
    </>
  )
}

/** One calm layout while the first read is on its way: the office spans, so nothing jumps. */
function DashboardSkeleton() {
  return (
    <BentoGrid dense>
      <Cell col={8} rows={2}><Skeleton className="h-full min-h-[180px] w-full rounded-xl" /></Cell>
      <Cell col={4} rows={2}><Skeleton className="h-full min-h-[180px] w-full rounded-xl" /></Cell>
      <Cell col={4} rows={4}><Skeleton className="h-full min-h-[240px] w-full rounded-xl" /></Cell>
      <Cell col={4} rows={4}><Skeleton className="h-full min-h-[240px] w-full rounded-xl" /></Cell>
      <Cell col={4} rows={4}><Skeleton className="h-full min-h-[240px] w-full rounded-xl" /></Cell>
    </BentoGrid>
  )
}
