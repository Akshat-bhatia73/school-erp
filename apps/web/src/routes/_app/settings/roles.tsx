import { createFileRoute } from '@tanstack/react-router'
import { Construction } from 'lucide-react'
import { EmptyState, PageHeader } from '@/components/shared/page'

export const Route = createFileRoute('/_app/settings/roles')({ component: Page })

function Page() {
  return (
    <>
      <PageHeader crumbs={[{ label: 'Roles & permissions' }]} />
      <EmptyState icon={<Construction />} title="Roles & permissions" description="This screen is being built." />
    </>
  )
}
