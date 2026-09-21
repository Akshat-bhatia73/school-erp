import type { ReactNode } from 'react'
import { PageTabs } from '@/components/shared/page'
import { useSchoolContext } from '@/lib/session'

/** The Timetable tabs, shared by every timetable screen. */
export function TimetableTabs({ actions }: { actions?: ReactNode }) {
  const { hasPermission } = useSchoolContext()
  const canReadLoads = hasPermission('timetable.read_teacher_loads')
  // Somebody who cannot read teacher loads but has a staff record of their own sees their own week
  // there instead. A parent has neither, so the tab is not rendered for them at all.
  const showStaffTab = canReadLoads || hasPermission('staff.read_directory')

  const tabs = [
    { label: 'Class timetable', to: '/timetable' },
    ...(showStaffTab ? [{ label: canReadLoads ? 'Teachers' : 'My timetable', to: '/timetable/teachers' }] : []),
    { label: 'Substitutions', to: '/timetable/substitutions' },
    { label: 'Bell schedule', to: '/timetable/periods' },
  ]

  return <PageTabs tabs={tabs} actions={actions} />
}
