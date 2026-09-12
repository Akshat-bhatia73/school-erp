import { PageTabs } from '@/components/shared/page'

const TABS = [
  { label: 'School profile', to: '/setup/school' },
  { label: 'Academic years', to: '/setup/academic-years' },
  { label: 'Classes & sections', to: '/setup/classes' },
  { label: 'Subjects', to: '/setup/subjects' },
  { label: 'Holidays', to: '/setup/holidays' },
]

/** The five School setup tabs, shared by every setup screen. */
export function SetupTabs() {
  return <PageTabs tabs={TABS} />
}
