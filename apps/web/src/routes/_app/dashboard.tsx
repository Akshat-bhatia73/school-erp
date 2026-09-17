import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard } from 'lucide-react'
import { AccountantDashboard } from '@/components/dashboard/accountant-dashboard'
import { OfficeDashboard } from '@/components/dashboard/office-dashboard'
import { ParentDashboard } from '@/components/dashboard/parent-dashboard'
import { TeacherDashboard } from '@/components/dashboard/teacher-dashboard'
import { EmptyState, PageHeader } from '@/components/shared/page'
import { Tag } from '@/components/shared/tag'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { describeError } from '@/lib/api-errors'
import { qk } from '@/lib/query'
import { audienceFor } from '@/lib/permissions'
import { useSchoolContext } from '@/lib/session'
import { useAcademicYear } from '@/lib/use-academic-year'
import { formatDate } from '@/lib/utils'

export const Route = createFileRoute('/_app/dashboard')({ component: Page })

function Page() {
  const { schoolId, school, roleKeys } = useSchoolContext()
  const { current } = useAcademicYear()
  const { data, isLoading, error } = useQuery({
    queryKey: qk.dashboard(schoolId),
    queryFn: () => api.dashboard.get(schoolId),
  })
  const audience = audienceFor(roleKeys)
  const today = new Date().toISOString()

  return (
    <>
      <PageHeader
        crumbs={[{ label: audience === 'parent' ? 'My children' : 'Dashboard', icon: <LayoutDashboard /> }]}
        actions={
          <>
            {current && <Tag color="blue">{current.name}</Tag>}
            <span className="text-[12.5px] text-muted-foreground">Today, {formatDate(today)}</span>
          </>
        }
      />

      <div className="flex-1 overflow-y-auto p-3 md:p-5">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-4">
          {error ? (
            <EmptyState icon={<LayoutDashboard />} title="We could not open your dashboard" description={describeError(error)} />
          ) : (
            <>
              {audience !== 'parent' && (
                <p className="text-[13.5px] text-muted-foreground">Overview for {school.name}</p>
              )}

              {data?.audience === 'office' && <OfficeDashboard data={data} isLoading={isLoading} />}
              {data?.audience === 'teacher' && <TeacherDashboard data={data} />}
              {data?.audience === 'parent' && <ParentDashboard students={data.children} />}
              {data?.audience === 'accountant' && <AccountantDashboard message={data.message} />}
              {!data && isLoading && (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
