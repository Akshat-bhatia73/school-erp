import { PageTabs } from '@/components/shared/page'

const TABS = [
  { label: 'Class timetable', to: '/timetable' },
  { label: 'Teachers', to: '/timetable/teachers' },
  { label: 'Substitutions', to: '/timetable/substitutions' },
  { label: 'Bell schedule', to: '/timetable/periods' },
]

/** The four Timetable tabs, shared by every timetable screen. */
export function TimetableTabs() {
  return <PageTabs tabs={TABS} />
}
