import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/staff/')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Staff' }]} />
      <EmptyState icon={<Construction />} title="Staff" description="This screen is being built." />
    </>
  )
}
