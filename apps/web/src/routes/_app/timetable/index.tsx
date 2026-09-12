import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/timetable/')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Class timetable' }]} />
      <EmptyState icon={<Construction />} title="Class timetable" description="This screen is being built." />
    </>
  )
}
