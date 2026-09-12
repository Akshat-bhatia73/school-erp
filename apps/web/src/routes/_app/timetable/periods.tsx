import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/timetable/periods')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Bell schedule' }]} />
      <EmptyState icon={<Construction />} title="Bell schedule" description="This screen is being built." />
    </>
  )
}
