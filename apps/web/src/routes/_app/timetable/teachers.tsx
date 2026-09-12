import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/timetable/teachers')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Teacher timetables' }]} />
      <EmptyState icon={<Construction />} title="Teacher timetables" description="This screen is being built." />
    </>
  )
}
