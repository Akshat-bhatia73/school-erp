import type { ReactNode } from 'react'
import { PageTabs } from '@/components/shared/page'
import { useSchoolContext } from '@/lib/session'

const TABS = [
  { label: 'School profile', to: '/setup/school' },
  { label: 'Academic years', to: '/setup/academic-years' },
  { label: 'Classes & sections', to: '/setup/classes' },
  { label: 'Subjects', to: '/setup/subjects' },
  { label: 'Holidays', to: '/setup/holidays' },
]

/**
 * The School setup tabs, shared by every setup screen. Periods (the bell schedule) keeps its
 * timetable path but is set up here; it is offered to whoever can change the periods.
 */
export function SetupTabs({ actions }: { actions?: ReactNode }) {
  const { hasPermission } = useSchoolContext()
  const tabs = hasPermission('timetable.manage_periods') ? [...TABS, { label: 'Periods', to: '/timetable/periods' }] : TABS
  return <PageTabs tabs={tabs} actions={actions} />
}
