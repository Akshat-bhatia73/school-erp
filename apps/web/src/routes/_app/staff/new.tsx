import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/staff/new')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Add staff' }]} />
      <EmptyState icon={<Construction />} title="Add staff" description="This screen is being built." />
    </>
  )
}
