import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/staff/$staffId')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Staff member' }]} />
      <EmptyState icon={<Construction />} title="Staff member" description="This screen is being built." />
    </>
  )
}
