import { PageTabs } from '@/components/shared/page'
import { useSchoolContext } from '@/lib/session'

/** The tabs staff who check homework see: the list and the report. Nobody else gets a tab row. */
export function HomeworkTabs() {
  const { hasPermission } = useSchoolContext()
  if (!hasPermission('homework.check')) return null
  return <PageTabs tabs={[{ label: 'Homework', to: '/homework' }, { label: 'Report', to: '/homework/report' }]} />
}
